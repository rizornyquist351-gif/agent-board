// 调用 Claude Code 命令行（非交互模式），并把它的输出翻译成看板能用的东西。
// 输出格式见 docs/RESEARCH.md 第六节。
//
// 为了能测试、能离线演示，看板只依赖 Runner 接口；真实实现是 createCliRunner()。

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Activity, PlannedTask } from '../shared/wish.ts';

export interface RunResult {
  ok: boolean;
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
  /** 执行：可以改文件、跑命令，过程中不断回调活动 */
  work(opts: { cwd: string; prompt: string; budgetUsd: number; onActivity: (a: Activity) => void }): RunHandle;
}

// ---------- 把工具调用翻译成大白话 ----------

function shortPath(p: unknown): string {
  if (typeof p !== 'string') return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
}

function clip(s: string, n = 80): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export function describeTool(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (name) {
    case 'Read':
      return `正在看 ${shortPath(input.file_path)}`;
    case 'Write':
      return `正在写 ${shortPath(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `正在修改 ${shortPath(input.file_path ?? input.notebook_path)}`;
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
export function activitiesFromEvent(e: unknown, now = Date.now()): Activity[] {
  if (typeof e !== 'object' || e === null) return [];
  const ev = e as Record<string, any>;
  const out: Activity[] = [];
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    for (const c of ev.message.content) {
      if (c?.type === 'tool_use') out.push({ at: now, kind: 'tool', text: describeTool(String(c.name), c.input ?? {}) });
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
      else resolve({ ok: false, text: `Claude Code 意外退出（退出码 ${code}）${stderr ? `：${clip(stderr, 300)}` : ''}`, costUsd: 0, denials: 0 });
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
  return {
    plan({ cwd, prompt, schema, budgetUsd }) {
      // 只给只读工具：既保证不改文件，也避免大量探索导致超预算（RESEARCH.md 第六节）
      const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema),
        '--tools', 'Read,Glob,Grep', '--max-budget-usd', String(budgetUsd), ...model];
      return runCli(bin, args, cwd, () => {});
    },
    work({ cwd, prompt, budgetUsd, onActivity }) {
      const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
        '--permission-mode', opts.permissionMode ?? 'auto', '--max-budget-usd', String(budgetUsd), ...model];
      return runCli(bin, args, cwd, (ev) => activitiesFromEvent(ev).forEach(onActivity));
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
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '简短标题，动词开头' },
          goal: { type: 'string', description: '要达成什么' },
          deliverable: { type: 'string', description: '产出是什么：改哪些文件 / 写什么报告' },
          boundaries: { type: 'string', description: '不要碰什么、不做什么' },
          acceptance: { type: 'string', description: '怎样算做完，最好能检验' },
        },
        required: ['title', 'goal', 'deliverable', 'boundaries', 'acceptance'],
      },
    },
  },
  required: ['understanding', 'tasks'],
} as const;

export function planPrompt(wish: string): string {
  return [
    '你是 agent-board 的规划员。用户用一句话许了一个愿，请先阅读当前项目了解情况，再把愿望拆成 1 到 6 个按顺序执行的小任务。',
    '要求：',
    '- 每个任务一个人一次能做完；能少拆就少拆，简单的愿望一个任务就够。',
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
  const tasks = s.tasks.flatMap((t): PlannedTask[] => {
    if (typeof t !== 'object' || t === null) return [];
    const r = t as Record<string, unknown>;
    const title = asText(r.title);
    return title
      ? [{ title, goal: asText(r.goal), deliverable: asText(r.deliverable), boundaries: asText(r.boundaries), acceptance: asText(r.acceptance) }]
      : [];
  });
  return tasks.length ? { understanding: asText(s.understanding), tasks } : undefined;
}

export function workPrompt(wish: string, task: PlannedTask, index: number, total: number, previous: { title: string; result?: string }[]): string {
  const lines = [
    `你是 agent-board 派来干活的开发者。用户许了一个愿，规划员把它拆成了 ${total} 个任务，你现在做第 ${index + 1} 个。`,
    '',
    `用户的愿望：${wish}`,
    '',
    `## 本任务：${task.title}`,
    `- 目标：${task.goal}`,
    `- 产出：${task.deliverable}`,
    `- 边界：${task.boundaries}`,
    `- 验收标准：${task.acceptance}`,
  ];
  if (previous.length) {
    lines.push('', '## 之前已完成的任务');
    for (const p of previous) lines.push(`- ${p.title}${p.result ? `：${clip(p.result, 300)}` : ''}`);
  }
  lines.push(
    '',
    '## 规则',
    '- 当前目录是专门为这次许愿建的独立 git 工作区，放心修改。',
    '- 不要执行 git commit、git push、切换或新建分支——看板会自动提交，用户审核后才会合并。',
    '- 只做本任务，不要提前做后面的任务。',
    '- 做完后用几句中文总结：做了什么、怎么验证的、有什么需要用户注意。',
  );
  return lines.join('\n');
}
