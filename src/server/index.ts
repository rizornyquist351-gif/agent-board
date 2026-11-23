// 看板服务器（只用 Node 内置模块）：
//   GET /api/state    当前快照（JSON）
//   GET /api/events   SSE 实时推送：连上立即发一次快照，之后数据有变化就推送（D10）
//   其他路径          生产模式下提供 dist/web 里构建好的网页
//
// 环境变量：
//   PORT        默认 4317
//   CLAUDE_DIR  Claude Code 数据目录，默认 ~/.claude

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardState } from '../shared/types.ts';
import { readBoardState } from './adapter.ts';

const PORT = Number(process.env.PORT ?? 4317);
const CLAUDE_DIR = resolve(process.env.CLAUDE_DIR ?? join(homedir(), '.claude'));
const WEB_DIR = fileURLToPath(new URL('../../dist/web/', import.meta.url));
// 用轮询而不是 fs.watch：任务目录会在运行中被创建和删除，fs.watch 处理这种情况不可靠；
// 任务文件很小，每秒读一遍的开销可以忽略。
const POLL_MS = 1000;
const HEARTBEAT_MS = 25_000;

let current: BoardState | undefined;
let currentKey = '';
const clients = new Set<ServerResponse>();

/** 用于判断"有没有变化"的内容，去掉每次都会变的 generatedAt。 */
function contentKey(s: BoardState): string {
  return JSON.stringify({ ...s, generatedAt: 0 });
}

function send(res: ServerResponse, state: BoardState) {
  res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
}

async function refresh() {
  try {
    const next = await readBoardState(CLAUDE_DIR);
    const key = contentKey(next);
    if (key === currentKey) return;
    current = next;
    currentKey = key;
    for (const res of clients) send(res, next);
  } catch (err) {
    console.error('读取数据失败：', err);
  }
}

async function getState(): Promise<BoardState> {
  if (!current) await refresh();
  return current!;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

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
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(await getState()));
    return;
  }

  if (pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    send(res, await getState());
    req.on('close', () => clients.delete(res));
    return;
  }

  await serveStatic(pathname, res);
});

setInterval(refresh, POLL_MS);
// 定期发注释行，防止代理或浏览器因长时间无数据断开连接
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, HEARTBEAT_MS);

server.listen(PORT, () => {
  console.log(`agent-board 已启动：http://localhost:${PORT}`);
  console.log(`读取数据目录：${CLAUDE_DIR}`);
});
