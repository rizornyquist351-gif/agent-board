// 看板服务器（只用 Node 内置模块）。
//
// 启动：npx github:rizornyquist351-gif/agent-board [项目目录]
//   或：npm start -- [项目目录]          项目目录也可用 AGENT_BOARD_PROJECT 指定，默认为当前目录
//
// 接口：
//   GET  /api/events                 SSE：wishes（许愿）与 state（观察 Claude Code 任务）
//   GET  /api/state                  观察视图快照
//   POST /api/wishes                 {text}           许愿
//   POST /api/wishes/:id/start       {tasks?}         确认并开始（可带修改后的任务清单）
//   POST /api/wishes/:id/{retry,skip,stop,approve,discard,remove}
//   POST /api/project                {path}           切换项目
//   POST /api/recheck                                 重新自检
//
// 环境变量：
//   PORT                      默认 4317，被占用时自动往后找
//   CLAUDE_DIR                Claude Code 数据目录，默认 ~/.claude
//   AGENT_BOARD_FAKE=1        用假 agent（不调用 Claude、不花钱），用于演示
//   AGENT_BOARD_PERMISSION    执行 agent 的权限模式，默认 auto（不可用时自动降级为 acceptEdits）
//   AGENT_BOARD_MODEL         指定模型
//   AGENT_BOARD_PLAN_BUDGET   规划费用上限（美元），默认 0.5
//   AGENT_BOARD_TASK_BUDGET   每个任务费用上限（美元），默认 2
//   AGENT_BOARD_MAX_AGENTS    同时最多几个 agent 干活，默认 3
//   AGENT_BOARD_OPEN=1        启动后自动打开浏览器（npx 启动时默认开启）
//
// 安全（D13）：只监听 127.0.0.1；拒绝 Host 不是本机、或 Origin 来自其他网站的请求；
// 写操作必须是 JSON 请求。这样别的网站无法替用户"许愿"。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardState } from '../shared/types.ts';
import type { HealthCheck, PlannedTask, ProjectInfo, WishesPayload } from '../shared/wish.ts';
import { readBoardState } from './adapter.ts';
import { createCliRunner } from './claude.ts';
import { checkHealth } from './doctor.ts';
import { createFakeRunner } from './fake-runner.ts';
import { projectInfo } from './git.ts';
import { WishError, WishManager } from './wishes.ts';

const BASE_PORT = Number(process.env.PORT ?? 4317);
const CLAUDE_DIR = resolve(process.env.CLAUDE_DIR ?? join(homedir(), '.claude'));
const BOARD_HOME = join(homedir(), '.agent-board');
const FAKE = process.env.AGENT_BOARD_FAKE === '1';
const WEB_DIR = fileURLToPath(new URL('../../dist/web/', import.meta.url));
// 观察视图用轮询而不是 fs.watch：任务目录会在运行中被创建和删除，fs.watch 处理这种情况不可靠。
const POLL_MS = 1000;
const HEARTBEAT_MS = 25_000;
const WISH_PUSH_MS = 200;

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

const runner = FAKE
  ? createFakeRunner()
  : createCliRunner({ permissionMode: process.env.AGENT_BOARD_PERMISSION ?? 'auto', model: process.env.AGENT_BOARD_MODEL });

const clients = new Set<ServerResponse>();

function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---------- 观察视图（第 0 阶段） ----------

let observed: BoardState | undefined;
let observedKey = '';

async function refreshObserved() {
  try {
    const next = await readBoardState(CLAUDE_DIR);
    const key = JSON.stringify({ ...next, generatedAt: 0 });
    if (key === observedKey) return;
    observed = next;
    observedKey = key;
    broadcast('state', next);
  } catch (err) {
    console.error('读取 Claude Code 任务失败：', err);
  }
}

// ---------- 最近打开的项目 ----------

const RECENT_FILE = join(BOARD_HOME, 'recent.json');
let recent: string[] = [];

async function loadRecent() {
  try {
    const data = JSON.parse(await readFile(RECENT_FILE, 'utf8'));
    recent = Array.isArray(data) ? data.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    recent = [];
  }
}

async function rememberProject(path: string) {
  recent = [path, ...recent.filter((p) => p !== path)].slice(0, 8);
  try {
    await mkdir(BOARD_HOME, { recursive: true });
    await writeFile(RECENT_FILE, JSON.stringify(recent, null, 1));
  } catch {
    /* 记不住也不影响使用 */
  }
}

// ---------- 当前项目与许愿 ----------

// 启动时项目和端口是同时准备的，打开项目之前就可能有请求进来
let project: ProjectInfo = { path: '', name: '', problem: '正在打开项目…' };
let manager: WishManager | undefined;
let health: HealthCheck[] = [];
let pendingPush: NodeJS.Timeout | undefined;

function schedulePush() {
  pendingPush ??= setTimeout(() => {
    pendingPush = undefined;
    void pushWishes();
  }, WISH_PUSH_MS);
}

async function openProject(path: string): Promise<void> {
  const info = await projectInfo(resolve(expandHome(path)));
  if (manager) {
    if (manager.agents().length || manager.list().some((w) => w.status === 'planning')) {
      throw new WishError('当前项目还有 agent 在干活，请等它们做完或停止后再切换。');
    }
    await manager.close();
    manager = undefined;
  }
  project = info;
  if (!info.problem) {
    // worktree 放在项目之外：~/.agent-board/worktrees/{项目名}-{路径哈希}/（D14）
    const hash = createHash('sha1').update(info.path).digest('hex').slice(0, 8);
    manager = new WishManager(
      info.path,
      runner,
      { planUsd: Number(process.env.AGENT_BOARD_PLAN_BUDGET ?? 0.5), taskUsd: Number(process.env.AGENT_BOARD_TASK_BUDGET ?? 2) },
      { worktreeRoot: join(BOARD_HOME, 'worktrees', `${info.name}-${hash}`), maxAgents: Math.max(1, Number(process.env.AGENT_BOARD_MAX_AGENTS ?? 3)) },
    );
    await manager.load();
    manager.onChange(schedulePush);
    await rememberProject(info.path);
  }
  schedulePush();
}

async function wishesPayload(): Promise<WishesPayload> {
  if (manager) project = await projectInfo(project.path); // 分支可能变了
  return {
    project,
    fake: FAKE,
    wishes: manager?.list() ?? [],
    agents: manager?.agents() ?? [],
    maxAgents: manager?.maxAgents ?? 0,
    health,
    recent: recent.filter((p) => p !== project.path),
    permissionMode: FAKE ? 'demo' : (runner.permissionMode?.() ?? 'auto'),
  };
}

async function pushWishes() {
  broadcast('wishes', await wishesPayload());
}

// ---------- HTTP ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function isLocalHost(value: string | undefined): boolean {
  if (!value) return false;
  const host = value.replace(/^https?:\/\//, '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** 防止其他网站或 DNS 重绑定攻击调用本地接口。 */
function allowed(req: IncomingMessage): boolean {
  if (!isLocalHost(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || isLocalHost(origin);
}

async function readBody(req: IncomingMessage): Promise<any> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new WishError('请求格式不对');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > 100_000) throw new WishError('内容太长');
    chunks.push(c);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw new WishError('请求内容不是有效的 JSON');
  }
}

async function handlePost(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const body = await readBody(req);
  if (pathname === '/api/project') {
    const path = String(body.path ?? '').trim();
    if (!path) throw new WishError('请填写项目所在的文件夹路径');
    await openProject(path);
    return json(res, 200, { ok: true, problem: project.problem });
  }
  if (pathname === '/api/recheck') {
    health = await checkHealth({ fake: FAKE });
    schedulePush();
    return json(res, 200, { ok: true });
  }
  if (!manager) return json(res, 409, { error: project.problem });
  if (pathname === '/api/wishes') {
    const w = manager.create(String(body.text ?? ''));
    return json(res, 200, { id: w.id });
  }
  const m = pathname.match(/^\/api\/wishes\/([\w-]+)\/(start|retry|skip|stop|approve|discard|remove)$/);
  if (!m) return json(res, 404, { error: '没有这个操作' });
  const [, id, action] = m;
  switch (action) {
    case 'start': {
      const tasks = Array.isArray(body.tasks) ? (body.tasks as PlannedTask[]) : undefined;
      await manager.start(id, tasks);
      break;
    }
    case 'retry':
      await manager.retry(id);
      break;
    case 'skip':
      await manager.skip(id);
      break;
    case 'stop':
      manager.stop(id);
      break;
    case 'approve':
      await manager.approve(id);
      break;
    case 'discard':
      await manager.discard(id);
      break;
    case 'remove':
      manager.remove(id);
      break;
  }
  json(res, 200, { ok: true });
}

async function serveStatic(pathname: string, res: ServerResponse) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\]|\.\.)+/, '');
  let file = join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) file = join(WEB_DIR, 'index.html');
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
  } catch {
    file = join(WEB_DIR, 'index.html'); // 单页应用：未知路径都回到首页
  }
  try {
    await stat(file);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('网页尚未构建。开发时请用 npm run dev，或先运行 npm run build。');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    if (!allowed(req)) return json(res, 403, { error: '只允许从本机的看板页面访问' });
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'POST' && pathname.startsWith('/api/')) return await handlePost(req, res, pathname);

    if (pathname === '/api/state') {
      if (!observed) await refreshObserved();
      return json(res, 200, observed);
    }

    if (pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      if (!observed) await refreshObserved();
      res.write(`event: wishes\ndata: ${JSON.stringify(await wishesPayload())}\n\n`);
      res.write(`event: state\ndata: ${JSON.stringify(observed)}\n\n`);
      return;
    }

    if (pathname.startsWith('/api/')) return json(res, 404, { error: '没有这个接口' });
    await serveStatic(pathname, res);
  } catch (err) {
    if (err instanceof WishError) return json(res, 400, { error: err.message });
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: `服务器出错：${(err as Error).message}` });
  }
});

/** 从 BASE_PORT 开始找一个空闲端口 */
function listen(port: number, triesLeft = 10): Promise<number> {
  return new Promise((ok, fail) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE' && triesLeft > 0) listen(port + 1, triesLeft - 1).then(ok, fail);
      else fail(err);
    };
    const onListening = () => {
      server.off('error', onError);
      ok(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // 没有图形界面等情况：忽略，地址已打印在终端
    child.unref();
  } catch {
    /* 同上 */
  }
}

// ---------- 启动 ----------

await loadRecent();
const [, port] = await Promise.all([
  (async () => {
    health = await checkHealth({ fake: FAKE });
  })(),
  listen(BASE_PORT),
  openProject(process.argv[2] ?? process.env.AGENT_BOARD_PROJECT ?? process.env.INIT_CWD ?? process.cwd()),
]);

setInterval(refreshObserved, POLL_MS);
// 定期发注释行，防止代理或浏览器因长时间无数据断开连接
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, HEARTBEAT_MS);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await manager?.close();
    process.exit(0);
  });
}

const url = `http://localhost:${port}`;
console.log(`\n  agent-board 已启动：${url}\n`);
for (const h of health) console.log(`  ${h.ok ? '✓' : '✗'} ${h.label}${h.ok ? '' : `\n    → ${h.fix}`}`);
if (project.problem) console.log(`  ⚠ 项目 ${project.path} 暂时不能许愿：${project.problem}\n    → 可以在网页上换一个项目`);
else console.log(`  许愿的项目：${project.path}（当前分支 ${project.branch}）${FAKE ? ' · 演示模式（假 agent）' : ''}`);
console.log('\n  按 Ctrl+C 退出\n');
if (process.env.AGENT_BOARD_OPEN === '1') openBrowser(url);
