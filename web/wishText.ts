// 许愿界面用到的文字和分组规则（纯函数，方便测试）。
import type { TaskRole, TaskStatus, Wish, WishStatus, WishTask } from '../src/shared/wish.ts';

export const WISH_STATUS: Record<WishStatus, { label: string; tone: 'busy' | 'action' | 'done' | 'muted' | 'bad' }> = {
  planning: { label: '正在拆任务', tone: 'busy' },
  plan_failed: { label: '没拆成功', tone: 'bad' },
  awaiting_confirm: { label: '等你确认', tone: 'action' },
  running: { label: '干活中', tone: 'busy' },
  failed: { label: '卡住了', tone: 'bad' },
  stopped: { label: '已停止', tone: 'action' },
  awaiting_review: { label: '等你验收', tone: 'action' },
  merged: { label: '已完成', tone: 'done' },
  discarded: { label: '已打回', tone: 'muted' },
};

export const ROLE: Record<TaskRole, string> = {
  research: '调研',
  develop: '开发',
};

export const TASK_STATUS: Record<TaskStatus, string> = {
  todo: '等待开工',
  running: '进行中',
  done: '完成',
  failed: '没完成',
  skipped: '已跳过',
};

export type WishGroup = 'action' | 'busy' | 'ended';

export function groupOf(w: Wish): WishGroup {
  switch (w.status) {
    case 'awaiting_confirm':
    case 'awaiting_review':
    case 'failed':
    case 'stopped':
      return 'action';
    case 'planning':
    case 'running':
      return 'busy';
    default:
      return 'ended';
  }
}

export function groupWishes(wishes: Wish[]): Record<WishGroup, Wish[]> {
  const out: Record<WishGroup, Wish[]> = { action: [], busy: [], ended: [] };
  for (const w of wishes) out[groupOf(w)].push(w);
  return out;
}

export function money(usd: number): string {
  if (usd <= 0) return '$0';
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

export function doneCount(w: Wish): number {
  return w.tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;
}

/** 还没开工的任务在等什么，给用户看的一句话 */
export function waitingFor(w: Wish, t: WishTask): string {
  const pending = t.dependsOn
    .map((id) => w.tasks.findIndex((x) => x.id === id))
    .filter((i) => i >= 0 && w.tasks[i].status !== 'done' && w.tasks[i].status !== 'skipped');
  if (pending.length) {
    const failed = pending.some((i) => w.tasks[i].status === 'failed');
    return `${failed ? '依赖的任务没完成：' : '等 '}${pending.map((i) => `#${i + 1}`).join('、')}${failed ? '' : ' 做完'}`;
  }
  return w.status === 'running' ? '等空出名额' : '';
}
