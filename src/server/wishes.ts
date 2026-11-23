// 许愿调度：规划 → 等确认 → 按顺序执行 → 等审核 → 合并 / 丢弃。
// 第 1 阶段同一时间只运行一个 agent（CLAUDE.md「明确不做」）。
//
// 状态保存在 {项目}/.agent-board/state.json，看板重启后能恢复。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Activity, PlannedTask, Wish, WishTask } from '../shared/wish.ts';
import { PLAN_SCHEMA, parsePlan, planPrompt, workPrompt, type RunHandle, type Runner } from './claude.ts';
import * as g from './git.ts';

const MAX_ACTIVITY = 200;

export interface Budgets {
  planUsd: number;
  taskUsd: number;
}

export class WishError extends Error {}

export class WishManager {
  private wishes: Wish[] = [];
  private running = new Map<string, RunHandle>();
  private listeners = new Set<() => void>();
  private saveTimer?: NodeJS.Timeout;

  constructor(
    readonly project: string,
    private runner: Runner,
    private budgets: Budgets,
  ) {}

  get boardDir() {
    return join(this.project, '.agent-board');
  }

  private worktreeDir(id: string) {
    return join(this.boardDir, 'worktrees', id);
  }

  // ---------- 读写状态 ----------

  async load(): Promise<void> {
    await mkdir(this.boardDir, { recursive: true });
    await g.ignoreBoardDir(this.project);
    try {
      const saved = JSON.parse(await readFile(join(this.boardDir, 'state.json'), 'utf8'));
      this.wishes = Array.isArray(saved.wishes) ? saved.wishes : [];
    } catch {
      this.wishes = [];
    }
    // 看板重启时正在进行的工作已经中断
    for (const w of this.wishes) {
      if (w.status === 'planning') {
        w.status = 'plan_failed';
        w.error = '看板重启，规划被中断了。可以重新许愿。';
      } else if (w.status === 'running') {
        w.status = 'failed';
        w.error = '看板重启，执行被中断了。可以点"重试"继续。';
        for (const t of w.tasks) if (t.status === 'running') t.status = 'failed';
      }
    }
  }

  list(): Wish[] {
    return this.wishes;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(w?: Wish) {
    if (w) w.updatedAt = Date.now();
    for (const fn of this.listeners) fn();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save().catch((err) => console.error('保存状态失败：', err)), 300);
  }

  /** 停止所有运行中的 agent，并立即保存状态。 */
  async close(): Promise<void> {
    for (const h of this.running.values()) h.stop();
    clearTimeout(this.saveTimer);
    await this.save().catch(() => {});
  }

  async save(): Promise<void> {
    const file = join(this.boardDir, 'state.json');
    await writeFile(`${file}.tmp`, JSON.stringify({ wishes: this.wishes }, null, 1));
    await rename(`${file}.tmp`, file);
  }

  private get(id: string): Wish {
    const w = this.wishes.find((x) => x.id === id);
    if (!w) throw new WishError('找不到这个愿望');
    return w;
  }

  private busy(): Wish | undefined {
    return this.wishes.find((w) => w.status === 'running' || w.status === 'planning');
  }

  // ---------- 许愿与规划 ----------

  create(text: string): Wish {
    const trimmed = text.trim();
    if (!trimmed) throw new WishError('请先写下你想做什么');
    const now = Date.now();
    const w: Wish = { id: randomUUID().slice(0, 8), text: trimmed, createdAt: now, updatedAt: now, status: 'planning', tasks: [], costUsd: 0 };
    this.wishes.unshift(w);
    this.changed(w);
    void this.plan(w);
    return w;
  }

  private async plan(w: Wish) {
    const handle = this.runner.plan({ cwd: this.project, prompt: planPrompt(w.text), schema: PLAN_SCHEMA, budgetUsd: this.budgets.planUsd });
    this.running.set(w.id, handle);
    const r = await handle.done;
    this.running.delete(w.id);
    w.costUsd += r.costUsd;
    const plan = r.ok ? parsePlan(r.structured) : undefined;
    if (!plan) {
      w.status = 'plan_failed';
      w.error = r.ok ? '规划员没有给出有效的任务清单。可以换个说法再许一次。' : r.text;
    } else {
      w.status = 'awaiting_confirm';
      w.understanding = plan.understanding;
      w.tasks = plan.tasks.map((t, i) => newTask(t, i));
    }
    this.changed(w);
  }

  // ---------- 执行 ----------

  async start(id: string, edited?: PlannedTask[]): Promise<void> {
    const w = this.get(id);
    if (w.status !== 'awaiting_confirm') throw new WishError('只有等待确认的愿望才能开始');
    const other = this.busy();
    if (other) throw new WishError(`另一个愿望正在进行（"${other.text}"）。第 1 阶段一次只做一个，请等它完成。`);
    if (edited) {
      const tasks = edited.filter((t) => t.title?.trim());
      if (!tasks.length) throw new WishError('至少要保留一个任务');
      w.tasks = tasks.map((t, i) => newTask(t, i));
    }
    const info = await g.projectInfo(this.project);
    if (info.problem) throw new WishError(info.problem);
    w.branch = `agent-board/${w.id}`;
    w.baseCommit = await g.addWorktree(this.project, this.worktreeDir(w.id), w.branch);
    w.status = 'running';
    w.error = undefined;
    this.changed(w);
    void this.runTasks(w);
  }

  private async runTasks(w: Wish) {
    const dir = this.worktreeDir(w.id);
    for (let i = 0; i < w.tasks.length; i++) {
      const t = w.tasks[i];
      if (t.status === 'done' || t.status === 'skipped') continue;
      if (w.status !== 'running') return;
      t.status = 'running';
      t.error = undefined;
      push(t, { at: Date.now(), kind: 'info', text: '开始干活' });
      this.changed(w);

      const previous = w.tasks.slice(0, i).filter((p) => p.status === 'done').map((p) => ({ title: p.title, result: p.resultText }));
      const handle = this.runner.work({
        cwd: dir,
        prompt: workPrompt(w.text, t, i, w.tasks.length, previous),
        budgetUsd: this.budgets.taskUsd,
        onActivity: (a) => {
          push(t, a);
          this.changed(w);
        },
      });
      this.running.set(w.id, handle);
      const r = await handle.done;
      this.running.delete(w.id);
      t.costUsd += r.costUsd;
      w.costUsd += r.costUsd;
      t.denials += r.denials;

      if (w.status !== 'running') return; // 被停止
      if (!r.ok) {
        t.status = 'failed';
        t.error = r.text;
        w.status = 'failed';
        w.error = `"${t.title}" 没有完成：${r.text}`;
        push(t, { at: Date.now(), kind: 'error', text: r.text });
        this.changed(w);
        return;
      }
      t.status = 'done';
      t.resultText = r.text;
      try {
        const committed = await g.commitAll(dir, `agent-board: ${t.title}`);
        push(t, { at: Date.now(), kind: 'info', text: committed ? '完成，改动已保存到分支' : '完成（没有改动文件）' });
      } catch (err) {
        push(t, { at: Date.now(), kind: 'error', text: `保存改动失败：${(err as Error).message}` });
      }
      this.changed(w);
    }
    await this.prepareReview(w);
  }

  private async prepareReview(w: Wish) {
    try {
      const { stat, diff } = await g.diffSummary(this.project, w.baseCommit!, w.branch!);
      w.diffStat = stat;
      w.diff = diff;
    } catch (err) {
      w.diffStat = `（无法生成改动摘要：${(err as Error).message}）`;
    }
    w.status = 'awaiting_review';
    this.changed(w);
  }

  async retry(id: string): Promise<void> {
    const w = this.get(id);
    if (w.status !== 'failed' && w.status !== 'stopped') throw new WishError('只有失败或已停止的愿望才能重试');
    const other = this.busy();
    if (other) throw new WishError(`另一个愿望正在进行（"${other.text}"），请等它完成。`);
    for (const t of w.tasks) if (t.status === 'failed' || t.status === 'running') t.status = 'todo';
    w.status = 'running';
    w.error = undefined;
    this.changed(w);
    void this.runTasks(w);
  }

  async skip(id: string): Promise<void> {
    const w = this.get(id);
    if (w.status !== 'failed') throw new WishError('只有失败的愿望才能跳过任务');
    const t = w.tasks.find((x) => x.status === 'failed');
    if (t) t.status = 'skipped';
    if (w.tasks.every((x) => x.status === 'done' || x.status === 'skipped')) {
      await this.prepareReview(w);
      return;
    }
    await this.retry(id);
  }

  stop(id: string): void {
    const w = this.get(id);
    if (w.status !== 'running' && w.status !== 'planning') throw new WishError('这个愿望没有在进行');
    this.running.get(id)?.stop();
    if (w.status === 'planning') {
      w.status = 'plan_failed';
      w.error = '已停止规划';
    } else {
      w.status = 'stopped';
      w.error = '已手动停止。可以点"重试"从没完成的任务继续，或者"打回"丢弃改动。';
      for (const t of w.tasks) if (t.status === 'running') t.status = 'failed';
    }
    this.changed(w);
  }

  // ---------- 审核 ----------

  async approve(id: string): Promise<void> {
    const w = this.get(id);
    if (w.status !== 'awaiting_review') throw new WishError('只有等待审核的愿望才能通过');
    const r = await g.mergeBranch(this.project, w.branch!, `agent-board: ${w.text}`);
    if (!r.ok) throw new WishError(r.problem!);
    await g.removeWorktree(this.project, this.worktreeDir(w.id), w.branch!);
    w.status = 'merged';
    w.diff = undefined; // 已合并，完整改动留在 git 历史里
    this.changed(w);
  }

  async discard(id: string): Promise<void> {
    const w = this.get(id);
    const allowed = ['awaiting_review', 'failed', 'stopped', 'awaiting_confirm', 'plan_failed'];
    if (!allowed.includes(w.status)) throw new WishError('现在不能打回这个愿望');
    if (w.branch) await g.removeWorktree(this.project, this.worktreeDir(w.id), w.branch);
    w.status = 'discarded';
    w.diff = undefined;
    this.changed(w);
  }

  /** 从列表中移除已结束的愿望 */
  remove(id: string): void {
    const w = this.get(id);
    if (!['merged', 'discarded', 'plan_failed'].includes(w.status)) throw new WishError('只能移除已结束的愿望');
    this.wishes = this.wishes.filter((x) => x !== w);
    this.changed();
  }
}

function newTask(t: PlannedTask, i: number): WishTask {
  return {
    id: String(i + 1),
    title: t.title.trim(),
    goal: t.goal ?? '',
    deliverable: t.deliverable ?? '',
    boundaries: t.boundaries ?? '',
    acceptance: t.acceptance ?? '',
    status: 'todo',
    activity: [],
    costUsd: 0,
    denials: 0,
  };
}

function push(t: WishTask, a: Activity) {
  t.activity.push(a);
  if (t.activity.length > MAX_ACTIVITY) t.activity.splice(0, t.activity.length - MAX_ACTIVITY);
}
