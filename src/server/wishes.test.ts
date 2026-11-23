// 用真实的 git 仓库 + 假的 Runner 测试完整的许愿流程。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Wish, WishStatus } from '../shared/wish.ts';
import { createFakeRunner, type FakeOptions } from './fake-runner.ts';
import { normalizeTasks, WishManager } from './wishes.ts';

let project: string;
const sh = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();

async function until(m: WishManager, id: string, status: WishStatus): Promise<Wish> {
  for (let i = 0; i < 400; i++) {
    const w = m.list().find((x) => x.id === id)!;
    if (w.status === status) return w;
    await new Promise((r) => setTimeout(r, 10));
  }
  const w = m.list().find((x) => x.id === id);
  throw new Error(`等待状态 ${status} 超时，当前 ${w?.status}：${w?.error}；${JSON.stringify(w?.tasks.map((t) => [t.status, t.error]))}`);
}

const managers: WishManager[] = [];

async function manager(fake: FakeOptions = {}, maxAgents = 3) {
  const m = new WishManager(project, createFakeRunner({ stepMs: 1, ...fake }), { planUsd: 0.5, taskUsd: 2 }, { worktreeRoot: `${project}-worktrees`, maxAgents });
  await m.load();
  managers.push(m);
  return m;
}

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'agent-board-proj-'));
  sh('init', '-q', '-b', 'main');
  await writeFile(join(project, 'README.md'), '# demo\n');
  sh('add', '-A');
  sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
  await rm(project, { recursive: true, force: true });
  await rm(`${project}-worktrees`, { recursive: true, force: true });
});

describe('WishManager', () => {
  it('完整流程：规划出角色和依赖 → 调研 → 两个开发并行 → 合并进愿望分支 → 通过', async () => {
    const m = await manager({ stepMs: 5 });
    const w = m.create('加一个说明文件');
    await until(m, w.id, 'awaiting_confirm');
    expect(w.tasks.map((t) => [t.role, t.dependsOn])).toEqual([
      ['research', []],
      ['develop', ['1']],
      ['develop', ['1']],
    ]);

    await m.start(w.id);
    // 调研没完成前，开发任务不开工
    expect(w.tasks.map((t) => t.status)).toEqual(['running', 'todo', 'todo']);
    expect(w.tasks[0].agent).toBe('调研员 1');

    // 调研完成后，两个开发任务同时开工，名字不同
    for (let i = 0; i < 400 && w.tasks[1].status !== 'running'; i++) await new Promise((r) => setTimeout(r, 2));
    expect(w.tasks[1].status).toBe('running');
    expect(w.tasks[2].status).toBe('running');
    expect(new Set(m.agents().map((a) => a.name))).toEqual(new Set(['开发者 1', '开发者 2']));

    await until(m, w.id, 'awaiting_review');
    await new Promise((r) => setTimeout(r, 50)); // 等改动摘要生成
    expect(w.tasks[0].resultText).toContain('## 结论');
    expect(w.tasks[1].diffStat).toContain('notes/');
    expect(w.diffStat).toContain('2 files changed');
    expect(m.agents()).toEqual([]);
    // 审核前用户项目没变
    expect(existsSync(join(project, 'notes'))).toBe(false);

    await m.approve(w.id);
    expect(w.status).toBe('merged');
    expect(await readFile(join(project, 'notes', '实现主要功能.md'), 'utf8')).toContain('实现主要功能');
    expect(await readFile(join(project, 'notes', '补上说明文档.md'), 'utf8')).toContain('补上说明文档');
    expect(sh('branch', '--list', 'agent-board/*')).toBe('');
    expect(sh('worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('提交时排除临时文件', async () => {
    const { commitAll, git } = await import('./git.ts');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(project, '__pycache__'), { recursive: true });
    await writeFile(join(project, '__pycache__', 'x.cpython-313.pyc'), 'junk');
    await writeFile(join(project, 'debug.log'), 'junk');
    await writeFile(join(project, 'real.py'), 'print(1)\n');
    expect(await commitAll(project, 'test')).toBe(true);
    expect((await git(project, 'show', '--name-only', '--format=', 'HEAD')).split('\n')).toEqual(['real.py']);
  });

  it('并行开发改了同一个文件：冲突后自动重做并成功', async () => {
    const m = await manager({ stepMs: 2, sameFile: true });
    const w = m.create('制造冲突');
    await until(m, w.id, 'awaiting_confirm');
    await m.start(w.id);
    await until(m, w.id, 'awaiting_review');
    const attempts = w.tasks.filter((t) => t.role === 'develop').map((t) => t.attempts).sort();
    expect(attempts).toEqual([1, 2]);
    expect(w.tasks.some((t) => t.activity.some((a) => a.text.includes('冲突')))).toBe(true);
    await m.approve(w.id);
    const notes = await readFile(join(project, 'NOTES.md'), 'utf8');
    expect(notes).toContain('实现主要功能');
    expect(notes).toContain('补上说明文档');
  });

  it('两个愿望改了同一个文件：后合并的那个自动派人解决冲突，再验收', async () => {
    const m = await manager({ stepMs: 2 });
    const a = m.create('愿望甲');
    const b = m.create('愿望乙');
    await until(m, a.id, 'awaiting_confirm');
    await until(m, b.id, 'awaiting_confirm');
    await m.start(a.id);
    await m.start(b.id);
    await until(m, a.id, 'awaiting_review');
    await until(m, b.id, 'awaiting_review');

    await m.approve(a.id);
    expect(a.status).toBe('merged');
    await m.approve(b.id); // 冲突：不报错，自动追加"解决冲突"任务
    expect(b.status).toBe('running');
    expect(b.tasks.at(-1)).toMatchObject({ kind: 'resolve', title: '解决和项目最新代码的冲突' });
    await until(m, b.id, 'awaiting_review');
    expect(b.tasks.at(-1)!.activity.some((x) => x.text.includes('个文件冲突'))).toBe(true);
    // 验收看到的改动只包含乙自己的
    expect(b.diffStat).toContain('notes/');

    await m.approve(b.id);
    expect(b.status).toBe('merged');
    const notes = await readFile(join(project, 'notes', '实现主要功能.md'), 'utf8');
    expect(notes.match(/实现主要功能/g)).toHaveLength(2);
    expect(notes).not.toMatch(/<{7}|>{7}/);
  });

  it('全局名额：最多 N 个 agent 同时干活', async () => {
    const m = await manager({ stepMs: 5 }, 1);
    const a = m.create('一');
    const b = m.create('二');
    await until(m, a.id, 'awaiting_confirm');
    await until(m, b.id, 'awaiting_confirm');
    await m.start(a.id);
    await m.start(b.id);
    let max = 0;
    while (a.status === 'running' || b.status === 'running') {
      max = Math.max(max, m.agents().length);
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(max).toBe(1);
    expect([a.status, b.status]).toEqual(['awaiting_review', 'awaiting_review']);
  });

  it('可以修改任务清单再开始，删掉的任务从依赖里去掉', async () => {
    const m = await manager();
    const w = m.create('随便');
    await until(m, w.id, 'awaiting_confirm');
    const [, second] = w.tasks;
    await m.start(w.id, [{ ...second, title: '只做这一件' }]);
    expect(w.tasks.map((t) => [t.title, t.dependsOn])).toEqual([['只做这一件', []]]);
    await until(m, w.id, 'awaiting_review');
  });

  it('依赖的任务失败：后续任务不开工，愿望卡住；重试后继续', async () => {
    const m = await manager({ failOnWork: 1 });
    const w = m.create('调研会失败');
    await until(m, w.id, 'awaiting_confirm');
    await m.start(w.id);
    await until(m, w.id, 'failed');
    expect(w.tasks.map((t) => t.status)).toEqual(['failed', 'todo', 'todo']);
    expect(w.error).toContain('费用上限');

    await m.retry(w.id);
    await until(m, w.id, 'awaiting_review');
    expect(w.tasks.map((t) => t.status)).toEqual(['done', 'done', 'done']);
  });

  it('跳过失败的任务，后续任务照样开工', async () => {
    const m = await manager({ failOnWork: 1 });
    const w = m.create('跳过调研');
    await until(m, w.id, 'awaiting_confirm');
    await m.start(w.id);
    await until(m, w.id, 'failed');
    await m.skip(w.id);
    await until(m, w.id, 'awaiting_review');
    expect(w.tasks.map((t) => t.status)).toEqual(['skipped', 'done', 'done']);
  });

  it('打回会删除所有分支和工作区，用户项目不变', async () => {
    const m = await manager();
    const w = m.create('不要了');
    await until(m, w.id, 'awaiting_confirm');
    await m.start(w.id);
    await until(m, w.id, 'awaiting_review');
    await m.discard(w.id);
    expect(w.status).toBe('discarded');
    expect(sh('branch', '--list', 'agent-board/*')).toBe('');
    expect(existsSync(join(project, 'notes'))).toBe(false);
  });

  it('用户有未提交改动时拒绝合并', async () => {
    const m = await manager();
    const w = m.create('合并保护');
    await until(m, w.id, 'awaiting_confirm');
    await m.start(w.id);
    await until(m, w.id, 'awaiting_review');
    await writeFile(join(project, 'README.md'), '# 用户正在改\n');
    await expect(m.approve(w.id)).rejects.toThrow('还没提交的改动');
    expect(w.status).toBe('awaiting_review');
  });

  it('停止：所有在干活的 agent 都停下', async () => {
    const m = await manager({ stepMs: 20 });
    const w = m.create('停下');
    await until(m, w.id, 'awaiting_confirm');
    await m.start(w.id);
    m.stop(w.id);
    expect(w.status).toBe('stopped');
    expect(m.agents()).toEqual([]);
    await m.retry(w.id);
    await until(m, w.id, 'awaiting_review');
  });

  it('状态保存到磁盘，重启后恢复；旧数据补上角色和依赖', async () => {
    const m = await manager();
    const w = m.create('记住我');
    await until(m, w.id, 'awaiting_confirm');
    await m.save();
    const m2 = await manager();
    expect(m2.list()[0]).toMatchObject({ id: w.id, status: 'awaiting_confirm' });
    expect(sh('status', '--porcelain')).toBe('');

    // 第 1 阶段格式（没有 role / dependsOn）
    const old = { wishes: [{ ...w, tasks: w.tasks.map(({ role, dependsOn, attempts, ...rest }) => rest) }] };
    await writeFile(join(project, '.agent-board', 'state.json'), JSON.stringify(old));
    const m3 = await manager();
    expect(m3.list()[0].tasks.map((t) => [t.role, t.dependsOn])).toEqual([
      ['develop', []],
      ['develop', ['1']],
      ['develop', ['2']],
    ]);
  });
});

describe('normalizeTasks', () => {
  it('只保留指向前面任务的依赖', () => {
    const base = { goal: '', deliverable: '', boundaries: '', acceptance: '', role: 'develop' as const };
    const ts = normalizeTasks([
      { ...base, id: '1', title: 'a', dependsOn: ['2', '1'] },
      { ...base, id: '2', title: 'b', dependsOn: ['1', '9'] },
    ]);
    expect(ts.map((t) => t.dependsOn)).toEqual([[], ['1']]);
  });
});
