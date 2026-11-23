// 许愿调度：规划 → 等确认 → 按依赖并行执行 → 等审核 → 合并 / 丢弃（D16）。
//
// 分支与 worktree：
//   愿望分支  agent-board/{愿望}          worktree：{worktreeRoot}/{愿望}/main
//   开发任务  agent-board/{愿望}-t{任务}   worktree：{worktreeRoot}/{愿望}/t{任务}
// 开发任务从愿望分支的最新状态开出，完成后合并回愿望分支（冲突时基于最新代码自动重做一次）。
// 调研任务只读，直接在愿望分支的 worktree 里运行，不建分支。
//
// 状态保存在 {项目}/.agent-board/state.json，看板重启后能恢复。

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Activity, PlannedTask, RunningAgent, Wish, WishTask } from '../shared/wish.ts';
import { PLAN_SCHEMA, parsePlan, planPrompt, resolvePrompt, workPrompt, type RunHandle, type Runner } from './claude.ts';
import * as g from './git.ts';

const MAX_ACTIVITY = 200;
/** 开发任务因合并冲突最多做几次 */
const MAX_ATTEMPTS = 2;

export interface Budgets {
  planUsd: number;
  taskUsd: number;
}

export interface ManagerOptions {
  /** worktree 放在哪里。必须在项目目录之外，否则用户项目的测试 / 构建工具会扫到其中的副本（D14）。 */
  worktreeRoot: string;
  /** 全局同时最多几个 agent 干活（规划不算） */
  maxAgents: number;
}

export class WishError extends Error {}

export class WishManager {
  private wishes: Wish[] = [];
  /** 规划：key 为愿望 id；任务：key 为 "愿望:任务" */
  private running = new Map<string, RunHandle>();
  /** 每个愿望的合并锁，保证同一时间只有一个任务往愿望分支里合并 */
  private mergeLocks = new Map<string, Promise<unknown>>();
  private listeners = new Set<() => void>();
  private saveTimer?: NodeJS.Timeout;

  constructor(
    readonly project: string,
    private runner: Runner,
    private budgets: Budgets,
    private opts: ManagerOptions,
  ) {}

  get boardDir() {
    return join(this.project, '.agent-board');
  }

  get maxAgents() {
    return this.opts.maxAgents;
  }

  private wishDir(id: string) {
    return join(this.opts.worktreeRoot, id, 'main');
  }

  private taskDir(wishId: string, taskId: string) {
    return join(this.opts.worktreeRoot, wishId, `t${taskId}`);
  }

  private taskBranch(w: Wish, t: WishTask) {
    return `${w.branch}-t${t.id}`;
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
    for (const w of this.wishes) {
      // 第 1 阶段的旧数据没有角色和依赖：当作按顺序执行的开发任务
      w.tasks.forEach((t, i) => {
        t.role ??= 'develop';
        t.dependsOn ??= i > 0 ? [w.tasks[i - 1].id] : [];
        t.attempts ??= 0;
        t.agent = undefined;
      });
      // 看板重启时正在进行的工作已经中断
      if (w.status === 'planning') {
        w.status = 'plan_failed';
        w.error = '看板重启，规划被中断了。可以重新许愿。';
      } else if (w.status === 'running') {
        w.status = 'failed';
        w.error = '看板重启，执行被中断了。可以点"重试"继续。';
        for (const t of w.tasks) {
          if (t.status === 'running') {
            t.status = 'failed';
            t.error = '看板重启时中断';
          }
        }
      }
    }
  }

  list(): Wish[] {
    return this.wishes;
  }

  /** 正在干活的 agent，给 Agent 面板用 */
  agents(): RunningAgent[] {
    const out: RunningAgent[] = [];
    for (const w of this.wishes) {
      for (const t of w.tasks) {
        if (t.status !== 'running' || !t.agent) continue;
        const startedAt = [...t.activity].reverse().find((a) => a.text === '开始干活')?.at ?? w.updatedAt;
        out.push({ name: t.agent, role: t.role, wishId: w.id, wishText: w.text, taskId: t.id, taskTitle: t.title, doing: t.activity[t.activity.length - 1]?.text, since: startedAt });
      }
    }
    return out;
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

  async save(): Promise<void> {
    const file = join(this.boardDir, 'state.json');
    await writeFile(`${file}.tmp`, JSON.stringify({ wishes: this.wishes }, null, 1));
    await rename(`${file}.tmp`, file);
  }

  /** 停止所有运行中的 agent，并立即保存状态。 */
  async close(): Promise<void> {
    for (const h of this.running.values()) h.stop();
    clearTimeout(this.saveTimer);
    await this.save().catch(() => {});
  }

  private get(id: string): Wish {
    const w = this.wishes.find((x) => x.id === id);
    if (!w) throw new WishError('找不到这个愿望');
    return w;
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
    w.costUsd += r.costUsd;
    if (this.running.get(w.id) !== handle) return; // 被停止
    this.running.delete(w.id);
    const plan = r.ok ? parsePlan(r.structured) : undefined;
    if (!plan) {
      w.status = 'plan_failed';
      w.error = r.ok ? '规划员没有给出有效的任务清单。可以换个说法再许一次。' : r.text;
    } else {
      w.status = 'awaiting_confirm';
      w.understanding = plan.understanding;
      w.tasks = normalizeTasks(plan.tasks);
    }
    this.changed(w);
  }

  // ---------- 执行 ----------

  async start(id: string, edited?: PlannedTask[]): Promise<void> {
    const w = this.get(id);
    if (w.status !== 'awaiting_confirm') throw new WishError('只有等待确认的愿望才能开始');
    if (edited) {
      const tasks = normalizeTasks(edited.filter((t) => t.title?.trim()));
      if (!tasks.length) throw new WishError('至少要保留一个任务');
      w.tasks = tasks;
    }
    const info = await g.projectInfo(this.project);
    if (info.problem) throw new WishError(info.problem);
    w.branch = `agent-board/${w.id}`;
    w.baseCommit = await g.addWorktree(this.project, this.wishDir(w.id), w.branch);
    w.status = 'running';
    w.error = undefined;
    this.changed(w);
    this.schedule();
  }

  private runningCount(): number {
    let n = 0;
    for (const w of this.wishes) for (const t of w.tasks) if (t.status === 'running') n++;
    return n;
  }

  private isSatisfied(w: Wish, depId: string): boolean {
    const d = w.tasks.find((t) => t.id === depId);
    return !d || d.status === 'done' || d.status === 'skipped';
  }

  /** 给新开工的 agent 起名：同角色里没被占用的最小编号 */
  private agentName(role: WishTask['role']): string {
    const prefix = role === 'research' ? '调研员' : '开发者';
    const used = new Set(this.agents().filter((a) => a.role === role).map((a) => a.name));
    let n = 1;
    while (used.has(`${prefix} ${n}`)) n++;
    return `${prefix} ${n}`;
  }

  /** 按许愿先后，把能开工的任务派出去，直到占满名额；然后检查哪些愿望已经做完或卡住。 */
  private schedule() {
    const oldestFirst = [...this.wishes].reverse();
    for (const w of oldestFirst) {
      if (w.status !== 'running') continue;
      for (const t of w.tasks) {
        if (this.runningCount() >= this.opts.maxAgents) break;
        if (t.status !== 'todo' || !t.dependsOn.every((d) => this.isSatisfied(w, d))) continue;
        t.status = 'running';
        t.agent = this.agentName(t.role);
        t.error = undefined;
        push(t, { at: Date.now(), kind: 'info', text: '开始干活' });
        void this.runTask(w, t).catch((err) => this.taskFailed(w, t, `看板内部出错：${(err as Error).message}`));
      }
    }
    for (const w of this.wishes) if (w.status === 'running') void this.checkFinished(w);
    this.changed();
  }

  private async checkFinished(w: Wish) {
    if (w.tasks.some((t) => t.status === 'running')) return;
    if (w.tasks.every((t) => t.status === 'done' || t.status === 'skipped')) {
      if (w.status !== 'running') return;
      w.status = 'awaiting_review'; // 先改状态，防止重复进入
      await this.prepareReview(w);
      return;
    }
    // 还有没做完的任务，但没有一个能开工（依赖的任务失败了）
    const runnable = w.tasks.some((t) => t.status === 'todo' && t.dependsOn.every((d) => this.isSatisfied(w, d)));
    const failed = w.tasks.filter((t) => t.status === 'failed');
    if (!runnable && failed.length) {
      w.status = 'failed';
      w.error = failed.length === 1 ? `"${failed[0].title}" 没有完成：${failed[0].error ?? ''}` : `有 ${failed.length} 个任务没有完成。`;
      this.changed(w);
    }
  }

  private async ensureWishWorktree(w: Wish) {
    if (!existsSync(this.wishDir(w.id))) await g.addWorktreeForBranch(this.project, this.wishDir(w.id), w.branch!);
  }

  private async runTask(w: Wish, t: WishTask, note?: string): Promise<void> {
    await this.ensureWishWorktree(w);
    if (t.kind === 'resolve') return this.runResolve(w, t);
    t.attempts += 1;
    const research = t.role === 'research';
    let cwd = this.wishDir(w.id);
    if (!research) {
      cwd = this.taskDir(w.id, t.id);
      await g.removeWorktree(this.project, cwd, this.taskBranch(w, t)); // 清掉上次失败留下的
      await g.addWorktree(this.project, cwd, this.taskBranch(w, t), w.branch!);
    }
    const previous = t.dependsOn
      .map((id) => w.tasks.find((x) => x.id === id))
      .filter((x): x is WishTask => !!x && x.status === 'done')
      .map((x) => ({ title: x.title, role: x.role, result: x.resultText }));

    const handle = this.runner.work({
      cwd,
      role: t.role,
      prompt: workPrompt(w.text, t, w.tasks.length, previous, note),
      budgetUsd: this.budgets.taskUsd,
      onActivity: (a) => {
        push(t, a);
        this.changed(w);
      },
    });
    const key = `${w.id}:${t.id}`;
    this.running.set(key, handle);
    const r = await handle.done;
    t.costUsd += r.costUsd;
    w.costUsd += r.costUsd;
    t.denials += r.denials;
    // 被停止（stop 会把它从 running 里拿掉）；之后哪怕任务已被重试重新开工，这个过期结果也要丢掉
    if (this.running.get(key) !== handle) return;
    this.running.delete(key);
    if (!r.ok) return this.taskFailed(w, t, r.text);
    t.resultText = r.text;

    if (research) return this.taskDone(w, t, '调研完成，报告已交给后续任务');

    // 开发任务：提交 → 合并回愿望分支
    const committed = await g.commitAll(cwd, `agent-board: ${t.title}`);
    if (!committed) {
      await g.removeWorktree(this.project, cwd, this.taskBranch(w, t));
      return this.taskDone(w, t, '完成（没有改动文件）');
    }
    const merged = await this.withMergeLock(w.id, () => g.mergeInto(this.wishDir(w.id), this.taskBranch(w, t), `agent-board: ${t.title}`));
    if (merged.ok) {
      t.diffStat = merged.stat;
      await g.removeWorktree(this.project, cwd, this.taskBranch(w, t));
      return this.taskDone(w, t, '完成，改动已并入这次许愿的分支');
    }
    if (merged.conflict && t.attempts < MAX_ATTEMPTS) {
      push(t, { at: Date.now(), kind: 'info', text: '和同事的改动冲突了，基于最新代码自动重做一次' });
      this.changed(w);
      return this.runTask(w, t, '你上一次的改动和其他同事已经合并的改动冲突了。现在的代码已经包含同事的改动，请在此基础上重新完成你的任务，注意不要覆盖他们的修改。');
    }
    await g.removeWorktree(this.project, cwd, this.taskBranch(w, t));
    return this.taskFailed(w, t, merged.conflict ? '和其他任务改了同一处地方，自动重做后仍然冲突。可以点"重试"再试一次。' : `合并改动失败：${merged.message}`);
  }

  /** 把用户项目当前分支的最新代码合并进愿望分支；有冲突就让 agent 解决。 */
  private async runResolve(w: Wish, t: WishTask): Promise<void> {
    t.attempts += 1;
    const dir = this.wishDir(w.id);
    const info = await g.projectInfo(this.project);
    if (!info.branch) return this.taskFailed(w, t, info.problem ?? '找不到你项目当前所在的分支');
    await g.abortMerge(dir);
    const started = await g.startMerge(dir, info.branch, `agent-board: 合并项目最新代码（${info.branch}）`);
    if (started.ok) return this.taskDone(w, t, '项目最新代码已合并进来，没有冲突');
    if (!started.files.length) {
      await g.abortMerge(dir);
      return this.taskFailed(w, t, `合并项目最新代码失败：${started.message}`);
    }
    push(t, { at: Date.now(), kind: 'info', text: `有 ${started.files.length} 个文件冲突：${started.files.join('、')}` });
    this.changed(w);

    const handle = this.runner.work({
      cwd: dir,
      role: 'develop',
      prompt: resolvePrompt(w.text, info.branch, started.files),
      budgetUsd: this.budgets.taskUsd,
      onActivity: (a) => {
        push(t, a);
        this.changed(w);
      },
    });
    const key = `${w.id}:${t.id}`;
    this.running.set(key, handle);
    const r = await handle.done;
    t.costUsd += r.costUsd;
    w.costUsd += r.costUsd;
    if (this.running.get(key) !== handle) {
      await g.abortMerge(dir);
      return;
    }
    this.running.delete(key);
    if (!r.ok) {
      await g.abortMerge(dir);
      return this.taskFailed(w, t, r.text);
    }
    t.resultText = r.text;
    const problem = await g.finishMerge(dir, started.files);
    if (problem) {
      await g.abortMerge(dir);
      return this.taskFailed(w, t, `冲突没有解决干净：${problem}`);
    }
    return this.taskDone(w, t, '冲突已解决，请再验收一次');
  }

  private async withMergeLock<T>(wishId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mergeLocks.get(wishId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.mergeLocks.set(wishId, next.catch(() => {}));
    return next;
  }

  private taskDone(w: Wish, t: WishTask, message: string) {
    t.status = 'done';
    t.agent = undefined;
    push(t, { at: Date.now(), kind: 'info', text: message });
    this.schedule();
  }

  private taskFailed(w: Wish, t: WishTask, reason: string) {
    if (t.status !== 'running') return;
    t.status = 'failed';
    t.agent = undefined;
    t.error = reason;
    push(t, { at: Date.now(), kind: 'error', text: reason });
    this.schedule();
  }

  private async prepareReview(w: Wish) {
    try {
      // 和用户项目当前的代码比（三点比较：只看愿望分支自己的改动）
      const { stat, diff } = await g.diffSummary(this.project, 'HEAD', w.branch!);
      w.diffStat = stat;
      w.diff = diff;
    } catch (err) {
      w.diffStat = `（无法生成改动摘要：${(err as Error).message}）`;
    }
    this.changed(w);
  }

  async retry(id: string): Promise<void> {
    const w = this.get(id);
    if (w.status !== 'failed' && w.status !== 'stopped') throw new WishError('只有卡住或已停止的愿望才能重试');
    for (const t of w.tasks) {
      if (t.status === 'failed' || t.status === 'running') {
        t.status = 'todo';
        t.attempts = 0;
      }
    }
    w.status = 'running';
    w.error = undefined;
    this.changed(w);
    this.schedule();
  }

  async skip(id: string): Promise<void> {
    const w = this.get(id);
    if (w.status !== 'failed') throw new WishError('只有卡住的愿望才能跳过任务');
    for (const t of w.tasks) if (t.status === 'failed') t.status = 'skipped';
    w.status = 'running';
    w.error = undefined;
    this.changed(w);
    this.schedule();
  }

  stop(id: string): void {
    const w = this.get(id);
    if (w.status !== 'running' && w.status !== 'planning') throw new WishError('这个愿望没有在进行');
    if (w.status === 'planning') {
      this.running.get(id)?.stop();
      this.running.delete(id);
      w.status = 'plan_failed';
      w.error = '已停止规划';
    } else {
      w.status = 'stopped';
      w.error = '已手动停止。可以点"重试"把没完成的任务继续做完，或者"打回"丢弃改动。';
      for (const t of w.tasks) {
        if (t.status !== 'running') continue;
        const key = `${w.id}:${t.id}`;
        this.running.get(key)?.stop();
        this.running.delete(key);
        t.status = 'failed';
        t.agent = undefined;
        t.error = '已停止';
      }
    }
    this.changed(w);
    this.schedule();
  }

  // ---------- 审核 ----------

  private async cleanup(w: Wish) {
    for (const t of w.tasks) if (t.role === 'develop') await g.removeWorktree(this.project, this.taskDir(w.id, t.id), this.taskBranch(w, t));
    await g.removeWorktree(this.project, this.wishDir(w.id), w.branch!);
  }

  async approve(id: string): Promise<void> {
    const w = this.get(id);
    if (w.status !== 'awaiting_review') throw new WishError('只有等待验收的愿望才能通过');
    const r = await g.mergeBranch(this.project, w.branch!, `agent-board: ${w.text}`);
    if (!r.ok && r.conflict) {
      // 和项目里的新改动冲突（常见于另一个愿望刚合并）：自动派开发者解决，解决后再验收
      const n = Math.max(0, ...w.tasks.map((x) => Number(x.id) || 0)) + 1;
      const [t] = normalizeTasks([
        { id: String(n), role: 'develop', dependsOn: [], title: '解决和项目最新代码的冲突', goal: '把项目里的新改动合并进来，保留两边的修改', deliverable: '解决好冲突的代码', boundaries: '只处理冲突', acceptance: '没有冲突标记' },
      ]);
      t.kind = 'resolve';
      w.tasks.push(t);
      w.status = 'running';
      w.diff = undefined;
      this.changed(w);
      this.schedule();
      return;
    }
    if (!r.ok) throw new WishError(r.problem!);
    await this.cleanup(w);
    w.status = 'merged';
    w.diff = undefined; // 已合并，完整改动留在 git 历史里
    this.changed(w);
  }

  async discard(id: string): Promise<void> {
    const w = this.get(id);
    const allowed = ['awaiting_review', 'failed', 'stopped', 'awaiting_confirm', 'plan_failed'];
    if (!allowed.includes(w.status)) throw new WishError('现在不能打回这个愿望');
    if (w.branch) await this.cleanup(w);
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

/** 把规划 / 用户修改后的任务清单变成正式任务：保留 id，去掉指向已删除任务或自己的依赖。 */
export function normalizeTasks(planned: PlannedTask[]): WishTask[] {
  const ids = planned.map((t, i) => t.id ?? String(i + 1));
  const known = new Set(ids);
  return planned.map((t, i) => ({
    id: ids[i],
    role: t.role === 'research' ? 'research' : 'develop',
    // 只允许依赖排在前面的任务，杜绝循环
    dependsOn: [...new Set((t.dependsOn ?? []).filter((d) => known.has(d) && ids.indexOf(d) < i))],
    attempts: 0,
    title: t.title.trim(),
    goal: t.goal ?? '',
    deliverable: t.deliverable ?? '',
    boundaries: t.boundaries ?? '',
    acceptance: t.acceptance ?? '',
    status: 'todo',
    activity: [],
    costUsd: 0,
    denials: 0,
  }));
}

function push(t: WishTask, a: Activity) {
  t.activity.push(a);
  if (t.activity.length > MAX_ACTIVITY) t.activity.splice(0, t.activity.length - MAX_ACTIVITY);
}
