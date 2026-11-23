// 用真实的 git 仓库 + 假的 Runner 测试完整的许愿流程。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Wish, WishStatus } from '../shared/wish.ts';
import { createFakeRunner, type FakeOptions } from './fake-runner.ts';
import { WishManager } from './wishes.ts';

let project: string;
const sh = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();

async function until(m: WishManager, id: string, status: WishStatus): Promise<Wish> {
  for (let i = 0; i < 200; i++) {
    const w = m.list().find((x) => x.id === id)!;
    if (w.status === status) return w;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等待状态 ${status} 超时，当前 ${m.list().find((x) => x.id === id)?.status}`);
}

const managers: WishManager[] = [];

async function manager(fake: FakeOptions = {}) {
  const m = new WishManager(project, createFakeRunner({ stepMs: 1, ...fake }), { planUsd: 0.5, taskUsd: 2 });
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
});

describe('WishManager', () => {
  it('完整流程：许愿 → 规划 → 开始 → 完成 → 通过并合并', async () => {
    const m = await manager();
    const w = m.create('加一个说明文件');
    await until(m, w.id, 'awaiting_confirm');
    expect(w.tasks).toHaveLength(2);
    expect(w.understanding).toContain('加一个说明文件');

    await m.start(w.id);
    await until(m, w.id, 'awaiting_review');
    expect(w.tasks.every((t) => t.status === 'done')).toBe(true);
    expect(w.tasks[0].activity.some((a) => a.kind === 'tool')).toBe(true);
    expect(w.diffStat).toContain('NOTES.md');
    // 审核前，用户的工作区没有被动过
    expect(existsSync(join(project, 'NOTES.md'))).toBe(false);
    // 每个任务一个提交
    expect(sh('log', '--oneline', `main..${w.branch}`).split('\n')).toHaveLength(2);

    await m.approve(w.id);
    expect(w.status).toBe('merged');
    expect(await readFile(join(project, 'NOTES.md'), 'utf8')).toContain('动手实现');
    expect(sh('branch', '--list', w.branch!)).toBe('');
  });

  it('可以修改任务清单再开始', async () => {
    const m = await manager();
    const w = m.create('随便');
    await until(m, w.id, 'awaiting_confirm');
    await m.start(w.id, [{ title: '只做这一件', goal: 'g', deliverable: 'd', boundaries: 'b', acceptance: 'a' }]);
    await until(m, w.id, 'awaiting_review');
    expect(w.tasks.map((t) => t.title)).toEqual(['只做这一件']);
  });

  it('失败后重试，从失败的任务继续', async () => {
    const m = await manager({ failOnWork: 2 });
    const w = m.create('会失败一次');
    await until(m, w.id, 'awaiting_confirm');
    await m.start(w.id);
    await until(m, w.id, 'failed');
    expect(w.tasks.map((t) => t.status)).toEqual(['done', 'failed']);
    expect(w.error).toContain('费用上限');

    await m.retry(w.id);
    await until(m, w.id, 'awaiting_review');
    expect(w.tasks.map((t) => t.status)).toEqual(['done', 'done']);
  });

  it('失败后跳过', async () => {
    const m = await manager({ failOnWork: 2 });
    const w = m.create('跳过最后一个');
    await until(m, w.id, 'awaiting_confirm');
    await m.start(w.id);
    await until(m, w.id, 'failed');
    await m.skip(w.id);
    await until(m, w.id, 'awaiting_review');
    expect(w.tasks.map((t) => t.status)).toEqual(['done', 'skipped']);
  });

  it('打回会删除分支，用户项目不变', async () => {
    const m = await manager();
    const w = m.create('不要了');
    await until(m, w.id, 'awaiting_confirm');
    await m.start(w.id);
    await until(m, w.id, 'awaiting_review');
    await m.discard(w.id);
    expect(w.status).toBe('discarded');
    expect(sh('branch', '--list', w.branch!)).toBe('');
    expect(existsSync(join(project, 'NOTES.md'))).toBe(false);
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

  it('一次只运行一个愿望', async () => {
    const m = await manager({ stepMs: 20 });
    const a = m.create('第一个');
    const b = m.create('第二个');
    await until(m, a.id, 'awaiting_confirm');
    await until(m, b.id, 'awaiting_confirm');
    await m.start(a.id);
    await expect(m.start(b.id)).rejects.toThrow('另一个愿望正在进行');
    m.stop(a.id);
    expect(a.status).toBe('stopped');
  });

  it('状态保存到磁盘，重启后恢复', async () => {
    const m = await manager();
    const w = m.create('记住我');
    await until(m, w.id, 'awaiting_confirm');
    await m.save();
    const m2 = await manager();
    expect(m2.list()[0]).toMatchObject({ id: w.id, status: 'awaiting_confirm' });
    // .agent-board 被 git 忽略
    expect(sh('status', '--porcelain')).toBe('');
  });
});
