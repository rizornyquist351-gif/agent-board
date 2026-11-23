import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTask, parseTeamMembers, readBoardState } from './adapter.ts';

// 实测得到的真实格式（docs/RESEARCH.md 第五节）
const REAL_TASK = {
  id: '1',
  subject: '调研 Agent Teams 任务数据格式',
  description: '规划阶段最后一项',
  activeForm: '调研任务数据格式',
  status: 'in_progress',
  blocks: [],
  blockedBy: [],
  metadata: { probe: true },
  owner: 'main',
};

describe('parseTask', () => {
  it('解析真实格式', () => {
    const t = parseTask(REAL_TASK, 'list', '1', 123)!;
    expect(t).toMatchObject({ id: '1', status: 'in_progress', owner: 'main', metadata: { probe: true }, updatedAt: 123 });
  });

  it('字段缺失或类型不对时使用默认值', () => {
    const t = parseTask({ status: 'weird', blockedBy: ['2', 3], owner: '' }, 'list', '7', 0)!;
    expect(t).toMatchObject({ id: '7', subject: '(无标题)', status: 'unknown', blockedBy: ['2'], owner: undefined, metadata: {} });
  });

  it('不是对象时返回 undefined', () => {
    expect(parseTask(null, 'l', '1', 0)).toBeUndefined();
    expect(parseTask([1], 'l', '1', 0)).toBeUndefined();
  });
});

describe('parseTeamMembers', () => {
  it('取出名字和类型，忽略坏成员', () => {
    expect(parseTeamMembers({ members: [{ name: 'lead', agentType: 'team-lead' }, { name: 'dev' }, { foo: 1 }, 'x'] })).toEqual([
      { name: 'lead', agentType: 'team-lead' },
      { name: 'dev', agentType: undefined },
    ]);
    expect(parseTeamMembers({})).toEqual([]);
  });
});

describe('readBoardState', () => {
  let dir: string;

  async function put(path: string, content: unknown) {
    const full = join(dir, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, typeof content === 'string' ? content : JSON.stringify(content));
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-board-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('目录不存在时返回空快照', async () => {
    const s = await readBoardState(join(dir, 'nope'));
    expect(s).toMatchObject({ lists: [], tasks: [], agents: [], warnings: [] });
  });

  it('读取任务、计算阻塞、推出 agent 状态', async () => {
    await put('tasks/team-a/1.json', { ...REAL_TASK, id: '1', owner: 'dev', status: 'in_progress' });
    await put('tasks/team-a/2.json', { ...REAL_TASK, id: '2', owner: undefined, status: 'pending', blockedBy: ['1'] });
    await put('tasks/team-a/10.json', { ...REAL_TASK, id: '10', owner: 'researcher', status: 'completed' });
    await put('tasks/team-a/.lock', '');
    await put('teams/team-a/config.json', { members: [{ name: 'lead', agentType: 'team-lead' }, { name: 'dev' }] });

    const s = await readBoardState(dir);
    expect(s.lists).toEqual([expect.objectContaining({ id: 'team-a', kind: 'team', taskCount: 3 })]);
    expect(s.tasks.map((t) => t.id)).toEqual(['1', '2', '10']);
    expect(s.tasks.find((t) => t.id === '2')!.blocked).toBe(true);

    const byName = Object.fromEntries(s.agents.map((a) => [a.name, a]));
    expect(byName.lead).toMatchObject({ source: 'team', agentType: 'team-lead', status: 'idle' });
    expect(byName.dev).toMatchObject({ source: 'team', status: 'working', currentTaskIds: ['1'] });
    expect(byName.researcher).toMatchObject({ source: 'owner', status: 'idle' });
  });

  it('依赖完成后不再阻塞', async () => {
    await put('tasks/s/1.json', { ...REAL_TASK, id: '1', status: 'completed' });
    await put('tasks/s/2.json', { ...REAL_TASK, id: '2', status: 'pending', blockedBy: ['1'] });
    const s = await readBoardState(dir);
    expect(s.tasks.find((t) => t.id === '2')!.blocked).toBe(false);
    expect(s.lists[0].kind).toBe('session');
  });

  it('坏文件只产生 warning，不影响其他任务', async () => {
    await put('tasks/s/1.json', REAL_TASK);
    await put('tasks/s/2.json', '{ 写了一半');
    await put('tasks/s/3.json', '"不是对象"');
    const s = await readBoardState(dir);
    expect(s.tasks).toHaveLength(1);
    expect(s.warnings).toHaveLength(2);
  });
});
