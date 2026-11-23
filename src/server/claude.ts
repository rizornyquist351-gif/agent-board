// 调用 Claude Code 命令行（非交互模式），并把它的输出翻译成看板能用的东西。
// 输出格式见 docs/RESEARCH.md 第六节。
//
// 为了能测试、能离线演示，看板只依赖 Runner 接口；真实实现是 createCliRunner()。

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Activity, PlannedTask, TaskRole } from '../shared/wish.ts';

export interface RunResult {
  ok: boolean;
  /** 进程退出时没有给出结果事件（启动失败、参数不被接受等） */
  noResult?: boolean;
  stderr?: string;
  /** agent 最后的文字总结，或出错原因 */
  text: string;
  costUsd: number;
  denials: number;
  structured?: unknown;
}

export interface RunHandle {
  done: Promise<RunResult>;
  stop(): void;
}

export interface Runner {
  /** 规划：只读工具 + JSON schema，返回结构化结果 */
  plan(opts: { cwd: string; prompt: string; schema: object; budgetUsd: number }): RunHandle;
  /** 执行 agent 当前使用的权限模式 */
  permissionMode?(): string;
  /** 执行：develop 可以改文件、跑命令；research 只读 + 可上网。过程中不断回调活动 */
  work(opts: { cwd: string; prompt: string; role: TaskRole; budgetUsd: number; onActivity: (a: Activity) => void }): RunHandle;
}

// ---------- 把工具调用翻译成大白话 ----------

/** 显示用的路径：在工作目录里的，显示相对路径；否则显示最后两段 */
function shortPath(p: unknown, cwd?: string): string {
  if (typeof p !== 'string') return '';
  const norm = p.replace(/\\/g, '/');
  const base = cwd?.replace(/\\/g, '/').replace(/\/$/, '');
  if (base && norm.startsWith(`${base}/`)) return norm.slice(base.length + 1);
  if (!norm.startsWith('/') && !/^[a-zA-Z]:/.test(norm)) return norm;
  return norm.split('/').filter(Boolean).slice(-2).join('/');
}

/** 截断但保留换行（用于报告） */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…（后面省略）` : s;
}

function clip(s: string, n = 80): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export function describeTool(name: string, input: Record<string, unknown>, cwd?: string): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (name) {
    case 'Read':
      return `正在看 ${shortPath(input.file_path, cwd)}`;
    case 'Write':
      return `正在写 ${shortPath(input.file_path, cwd)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `正在修改 ${shortPath(input.file_path ?? input.notebook_path, cwd)}`;
    case 'Bash':
      return `正在运行命令：${clip(str('description') || str('command'))}`;
    case 'Glob':
      return `正在找文件：${clip(str('pattern'))}`;
    case 'Grep':
      return `正在搜索代码：${clip(str('pattern'))}`;
    case 'WebSearch':
      return `正在上网搜：${clip(str('query'))}`;
    case 'WebFetch':
      return `正在读网页：${clip(str('url'))}`;
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return '正在整理待办清单';
    case 'Agent':
    case 'Task':
      return `派了一个帮手：${clip(str('description') || str('prompt'))}`;
    default:
      return `正在使用工具 ${name}`;
  }
}

/** 解析一行 stream-json 事件，返回其中的活动（可能没有）。 */
export function activitiesFromEvent(e: unknown, now = Date.now(), cwd?: string): Activity[] {
  if (typeof e !== 'object' || e === null) return [];
  const ev = e as Record<string, any>;
  const out: Activity[] = [];
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    for (const c of ev.message.content) {
      if (c?.type === 'tool_use') out.push({ at: now, kind: 'tool', text: describeTool(String(c.name), c.input ?? {}, cwd) });
      else if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) out.push({ at: now, kind: 'text', text: clip(c.text, 200) });
    }
  } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    for (const c of ev.message.content) {
      if (c?.type === 'tool_result' && c.is_error) {
        const content = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '');
        out.push({ at: now, kind: 'error', text: `出错了：${clip(content, 160)}` });
      }
    }
  }
  return out;
}

/** 把 result 事件转成 RunResult。 */
export function resultFromEvent(ev: Record<string, any>): RunResult {
  const subtype = String(ev.subtype ?? '');
  const ok = ev.is_error === false && subtype === 'success';
  let text = typeof ev.result === 'string' ? ev.result : '';
  if (!ok) {
    const reasons: Record<string, string> = {
      error_max_budget_usd: '超出了这一步的费用上限',
      error_max_turns: '超出了最大轮数',
      error_during_execution: '执行过程中出错',
    };
    text = reasons[subtype] ?? (text || `运行失败（${subtype || '未知原因'}）`);
  }
  return {
    ok,
    text,
    costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : 0,
    denials: Array.isArray(ev.permission_denials) ? ev.permission_denials.length : 0,
    structured: ev.structured_output,
  };
}

// ---------- 真实实现：调用 claude 命令行 ----------

const RESEARCH_TOOLS = 'Read,Glob,Grep,WebSearch,WebFetch';

export interface CliOptions {
  /** claude 可执行文件，默认 "claude" */
  bin?: string;
  /** 执行 agent 的权限模式，默认 "auto"（D12：独立分支里自主干活） */
  permissionMode?: string;
  model?: string;
}

function runCli(bin: string, args: string[], cwd: string, onEvent: (e: Record<string, any>) => void): RunHandle {
  const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let result: RunResult | undefined;
  let stderr = '';
  let stopped = false;
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      return; // 非 JSON 行忽略
    }
    if (ev.type === 'result') result = resultFromEvent(ev);
    else onEvent(ev);
  });
  const done = new Promise<RunResult>((resolve) => {
    child.on('error', (err) =>
      resolve({ ok: false, text: `无法启动 Claude Code（${err.message}）。请确认已安装并能在终端里运行 ${bin}。`, costUsd: 0, denials: 0 }),
    );
    child.on('close', (code) => {
      rl.close();
      if (stopped) resolve({ ok: false, text: '已被手动停止', costUsd: result?.costUsd ?? 0, denials: result?.denials ?? 0 });
      else if (result) resolve(result);
      else resolve({ ok: false, noResult: true, stderr, text: `Claude Code 意外退出（退出码 ${code}）${stderr ? `：${clip(stderr, 300)}` : ''}`, costUsd: 0, denials: 0 });
    });
  });
  return {
    done,
    stop() {
      stopped = true;
      child.kill('SIGTERM');
    },
  };
}

export function createCliRunner(opts: CliOptions = {}): Runner {
  const bin = opts.bin ?? 'claude';
  const model = opts.model ? ['--model', opts.model] : [];
  let mode = opts.permissionMode ?? 'auto';
  return {
    permissionMode: () => mode,
    plan({ cwd, prompt, schema, budgetUsd }) {
      // 只给只读工具：既保证不改文件，也避免大量探索导致超预算（RESEARCH.md 第六节）
      const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema),
        '--tools', 'Read,Glob,Grep', '--max-budget-usd', String(budgetUsd), ...model];
      return runCli(bin, args, cwd, () => {});
    },
    work({ cwd, prompt, role, budgetUsd, onActivity }) {
      // 调研员只给只读工具和上网工具，并预先允许上网（D16）
      const tools = role === 'research' ? ['--tools', RESEARCH_TOOLS, '--allowedTools', 'WebSearch', 'WebFetch'] : [];
      const start = () =>
        runCli(bin, ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...tools, '--permission-mode', mode, '--max-budget-usd', String(budgetUsd), ...model], cwd, (ev) =>
          activitiesFromEvent(ev, Date.now(), cwd).forEach(onActivity),
        );
      let current = start();
      let stopped = false;
      const done = current.done.then((r) => {
        // auto 模式不可用（账号或版本不支持）：本次及以后都改用 acceptEdits（只自动允许改文件）
        if (!stopped && !r.ok && r.noResult && mode === 'auto' && /permission|auto/i.test(r.stderr ?? '')) {
          mode = 'acceptEdits';
          onActivity({ at: Date.now(), kind: 'info', text: '你的 Claude Code 不支持自动权限模式，已改用"自动允许改文件"模式重新开始' });
          current = start();
          return current.done;
        }
        return r;
      });
      return {
        done,
        stop() {
          stopped = true;
          current.stop();
        },
      };
    },
  };
}

// ---------- 规划 ----------

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    understanding: { type: 'string', description: '用一两句中文说明你理解的愿望' },
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['research', 'develop'], description: 'research=只调研出报告，不改文件；develop=改代码' },
          dependsOn: { type: 'array', items: { type: 'integer' }, description: '必须先完成的任务序号（从 1 开始，只能是排在前面的任务）' },
          title: { type: 'string', description: '简短标题，动词开头' },
          goal: { type: 'string', description: '要达成什么' },
          deliverable: { type: 'string', description: '产出是什么：改哪些文件 / 写什么报告' },
          boundaries: { type: 'string', description: '不要碰什么、不做什么' },
          acceptance: { type: 'string', description: '怎样算做完，最好能检验' },
        },
        required: ['role', 'dependsOn', 'title', 'goal', 'deliverable', 'boundaries', 'acceptance'],
      },
    },
  },
  required: ['understanding', 'tasks'],
} as const;

export function planPrompt(wish: string): string {
  return [
    '你是 agent-board 的规划员。用户用一句话许了一个愿，请先阅读当前项目了解情况，再把愿望拆成 1 到 8 个小任务，交给多个 agent 同时去做。',
    '要求：',
    '- 每个任务一个人一次能做完；能少拆就少拆，简单的愿望一个任务就够。',
    '- 每个任务选一个角色：research（调研员：只读代码、可以上网查资料，产出一份报告，不改文件）或 develop（开发者：改代码）。只有确实需要先查资料或先摸清情况时才安排调研。',
    '- 用 dependsOn 写清依赖：必须等哪些任务做完才能开始（填排在前面的任务序号，从 1 开始）。没有依赖的任务会同时开工。',
    '- 会改到同一批文件的开发任务不能同时做，必须用 dependsOn 排成先后。',
    '- 调研任务的产出就是一份直接回答的报告，不要让它写文件；需要落到项目里的内容交给开发任务。',
    '- 每个任务写清：目标、产出、边界（不要碰什么）、验收标准。',
    '- 全部用中文，用普通人看得懂的话。',
    '- 你只负责规划，不要修改任何文件。',
    '',
    `用户的愿望：${wish}`,
  ].join('\n');
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 校验规划结果；不合格返回 undefined。 */
export function parsePlan(structured: unknown): { understanding: string; tasks: PlannedTask[] } | undefined {
  if (typeof structured !== 'object' || structured === null) return undefined;
  const s = structured as Record<string, unknown>;
  if (!Array.isArray(s.tasks)) return undefined;
  // 依赖用的是规划里的序号（从 1 开始），先记下每个序号对应的新 id，再换算
  const kept: { n: number; r: Record<string, unknown> }[] = [];
  s.tasks.forEach((t, i) => {
    if (typeof t === 'object' && t !== null && asText((t as Record<string, unknown>).title)) kept.push({ n: i + 1, r: t as Record<string, unknown> });
  });
  const idOf = new Map(kept.map((k, i) => [k.n, String(i + 1)]));
  const tasks = kept.map(({ n, r }, i): PlannedTask => {
    const deps = Array.isArray(r.dependsOn) ? r.dependsOn : [];
    const dependsOn = [...new Set(deps.filter((d): d is number => Number.isInteger(d) && d < n && idOf.has(d)).map((d) => idOf.get(d)!))];
    return {
      id: String(i + 1),
      role: r.role === 'research' ? 'research' : 'develop',
      dependsOn,
      title: asText(r.title),
      goal: asText(r.goal),
      deliverable: asText(r.deliverable),
      boundaries: asText(r.boundaries),
      acceptance: asText(r.acceptance),
    };
  });
  return tasks.length ? { understanding: asText(s.understanding), tasks } : undefined;
}

export function resolvePrompt(wish: string, branch: string, files: string[]): string {
  return [
    '你是 agent-board 派来的开发者。用户许的愿已经做完，但在合并进用户项目时，和项目里别的新改动（可能是另一个愿望刚合并的）冲突了。',
    '',
    `用户的愿望：${wish}`,
    '',
    `当前目录正在把项目最新的代码（分支 ${branch}）合并进这次许愿的改动，以下文件有冲突，里面有 <<<<<<< ======= >>>>>>> 冲突标记：`,
    '',
    '## 冲突文件',
    ...files.map((f) => `- ${f}`),
    '',
    '## 规则',
    '- 逐个解决冲突：两边的改动通常都要保留，合理地合在一起；删掉所有冲突标记。',
    '- 只处理冲突，不要做别的改动。',
    '- 不要执行 git commit、git merge --abort、切换分支——看板会自动提交。',
    '- 做完后用几句中文说明每个文件是怎么合的。',
  ].join('\n');
}

export interface PriorResult {
  title: string;
  role: TaskRole;
  result?: string;
}

export function workPrompt(wish: string, task: PlannedTask, total: number, previous: PriorResult[], note?: string): string {
  const research = task.role === 'research';
  const lines = [
    research
      ? `你是 agent-board 派来的调研员。用户许了一个愿，规划员把它拆成了 ${total} 个任务，分给几位同事同时做，你负责其中一个调研任务。`
      : `你是 agent-board 派来的开发者。用户许了一个愿，规划员把它拆成了 ${total} 个任务，分给几位同事同时做，你负责其中一个开发任务。`,
    '',
    `用户的愿望：${wish}`,
    '',
    `## 你的任务：${task.title}`,
    `- 目标：${task.goal}`,
    `- 产出：${task.deliverable}`,
    `- 边界：${task.boundaries}`,
    `- 验收标准：${task.acceptance}`,
  ];
  if (previous.length) {
    lines.push('', '## 你依赖的任务已经完成，结果如下');
    for (const p of previous) {
      if (p.role === 'research') lines.push(`### 调研报告：${p.title}`, truncate(p.result ?? '（没有报告）', 4000), '');
      else lines.push(`- 开发：${p.title}${p.result ? `：${clip(p.result, 300)}` : ''}`);
    }
  }
  if (note) lines.push('', `## 注意`, note);
  lines.push('', '## 规则');
  if (research) {
    lines.push(
      '- 你只能读代码、上网查资料，不要修改任何文件，也不要尝试把报告存成文件。',
      '- 全程用中文说明你在做什么。',
      '- 只做本任务。',
      '- 最后直接输出调研报告（中文、Markdown）：结论放最前面，然后是依据和建议，引用网上资料时附上链接。这份报告会交给后续的开发者。',
    );
  } else {
    lines.push(
      '- 当前目录是专门给你建的独立 git 工作区，放心修改。其他同事在别的工作区里同时干活。',
      '- 不要执行 git commit、git push、切换或新建分支——看板会自动提交并合并，用户审核后才会进入正式项目。',
      '- 只做本任务，不要顺手改不相关的文件，免得和同事的改动冲突。',
      '- 运行代码或测试产生的临时文件（缓存、日志等）做完后删掉。',
      '- 全程用中文说明你在做什么。',
      '- 做完后用几句中文总结：做了什么、怎么验证的、有什么需要用户注意。',
    );
  }
  return lines.join('\n');
}
