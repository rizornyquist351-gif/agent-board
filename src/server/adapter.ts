// 适配器：读取 Claude Code 写在磁盘上的任务与团队数据，转换成看板自己的类型。
//
// 这里是整个项目里**唯一**知道 Claude Code 文件格式的地方（见 docs/DECISIONS.md D9）。
// 格式是实测得来、官方未承诺的，所以：
//   - 每个字段都做类型检查，缺失就用默认值；
//   - 单个文件坏了只记一条 warning，绝不让整个读取失败。
//
// 磁盘布局（见 docs/RESEARCH.md 第五节）：
//   {claudeDir}/tasks/{listId}/{n}.json        每个任务一个文件
//   {claudeDir}/teams/{teamName}/config.json   Agent Teams 的团队配置（members 数组）

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Agent, BoardState, Task, TaskList, TaskStatus } from '../shared/types.ts';

const STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return []; // 目录不存在 = 还没有数据，不是错误
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** 把一个任务 JSON 转成 Task；格式不对返回 undefined。 */
export function parseTask(raw: unknown, listId: string, fallbackId: string, updatedAt: number): Task | undefined {
  if (!isRecord(raw)) return undefined;
  const rawStatus = str(raw.status);
  const status: TaskStatus = STATUSES.includes(rawStatus as TaskStatus) ? (rawStatus as TaskStatus) : 'unknown';
  const owner = str(raw.owner);
  return {
    id: str(raw.id) ?? (typeof raw.id === 'number' ? String(raw.id) : fallbackId),
    listId,
    subject: str(raw.subject) ?? '(无标题)',
    description: str(raw.description) ?? '',
    activeForm: str(raw.activeForm),
    status,
    owner: owner && owner.length > 0 ? owner : undefined,
    blocks: strArray(raw.blocks),
    blockedBy: strArray(raw.blockedBy),
    blocked: false, // 等整个列表读完后再算
    metadata: isRecord(raw.metadata) ? raw.metadata : {},
    updatedAt,
  };
}

interface TeamMember {
  name: string;
  agentType?: string;
}

/** 从团队配置里取出成员；格式不对返回空数组。 */
export function parseTeamMembers(raw: unknown): TeamMember[] {
  if (!isRecord(raw) || !Array.isArray(raw.members)) return [];
  return raw.members.flatMap((m): TeamMember[] => {
    if (!isRecord(m)) return [];
    const name = str(m.name);
    return name ? [{ name, agentType: str(m.agentType) }] : [];
  });
}

async function readTaskList(claudeDir: string, listId: string, warnings: string[]): Promise<Task[]> {
  const dir = join(claudeDir, 'tasks', listId);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const tasks: Task[] = [];
  for (const file of files) {
    const path = join(dir, file);
    try {
      const [raw, info] = await Promise.all([readJson(path), stat(path)]);
      const task = parseTask(raw, listId, file.replace(/\.json$/, ''), info.mtimeMs);
      if (task) tasks.push(task);
      else warnings.push(`无法识别的任务文件：${path}`);
    } catch (err) {
      // 常见原因：Claude Code 正在写这个文件。下一轮读取会恢复。
      warnings.push(`读取失败：${path}（${(err as Error).message}）`);
    }
  }
  // 按 id 的数字顺序排列，非数字 id 排在后面
  tasks.sort((a, b) => (Number(a.id) || Infinity) - (Number(b.id) || Infinity) || a.id.localeCompare(b.id));

  const done = new Set(tasks.filter((t) => t.status === 'completed').map((t) => t.id));
  const known = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    // 依赖的任务已被删除（不在列表里）视为不再阻塞
    t.blocked = t.status === 'pending' && t.blockedBy.some((id) => known.has(id) && !done.has(id));
  }
  return tasks;
}

async function readTeamMembers(claudeDir: string, warnings: string[]): Promise<Map<string, TeamMember[]>> {
  const teams = new Map<string, TeamMember[]>();
  for (const team of await listDirs(join(claudeDir, 'teams'))) {
    const path = join(claudeDir, 'teams', team, 'config.json');
    try {
      teams.set(team, parseTeamMembers(await readJson(path)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        warnings.push(`读取失败：${path}（${(err as Error).message}）`);
      }
    }
  }
  return teams;
}

/** 根据团队成员和任务的 owner 推出 agent 列表及其状态。 */
export function deriveAgents(listId: string, tasks: Task[], members: TeamMember[] | undefined): Agent[] {
  const agents = new Map<string, Agent>();
  for (const m of members ?? []) {
    agents.set(m.name, { name: m.name, listId, agentType: m.agentType, source: 'team', status: 'idle', currentTaskIds: [] });
  }
  for (const t of tasks) {
    if (!t.owner) continue;
    let a = agents.get(t.owner);
    if (!a) {
      a = { name: t.owner, listId, source: 'owner', status: 'idle', currentTaskIds: [] };
      agents.set(t.owner, a);
    }
    if (t.status === 'in_progress') {
      a.currentTaskIds.push(t.id);
      a.status = 'working';
    }
  }
  return [...agents.values()];
}

/** 读取全部数据，生成一份看板快照。 */
export async function readBoardState(claudeDir: string): Promise<BoardState> {
  const warnings: string[] = [];
  const teams = await readTeamMembers(claudeDir, warnings);
  const lists: TaskList[] = [];
  const tasks: Task[] = [];
  const agents: Agent[] = [];

  for (const listId of await listDirs(join(claudeDir, 'tasks'))) {
    const listTasks = await readTaskList(claudeDir, listId, warnings);
    const members = teams.get(listId);
    lists.push({
      id: listId,
      kind: members ? 'team' : 'session',
      taskCount: listTasks.length,
      updatedAt: Math.max(0, ...listTasks.map((t) => t.updatedAt)),
    });
    tasks.push(...listTasks);
    agents.push(...deriveAgents(listId, listTasks, members));
  }
  lists.sort((a, b) => b.updatedAt - a.updatedAt);

  return { generatedAt: Date.now(), claudeDir, lists, tasks, agents, warnings };
}
