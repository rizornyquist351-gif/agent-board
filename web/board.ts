// 纯函数：把任务分到看板的各列。和界面分开，方便测试。
import type { Task } from '../src/shared/types.ts';

export type ColumnId = 'unclaimed' | 'claimed' | 'blocked' | 'in_progress' | 'completed' | 'unknown';

export interface Column {
  id: ColumnId;
  title: string;
  hint: string;
}

// Claude Code 只有 pending / in_progress / completed 三种状态，
// 看板把 pending 再细分成 待认领 / 已认领 / 阻塞，更直观。
export const COLUMNS: Column[] = [
  { id: 'unclaimed', title: '待认领', hint: '还没有 agent 领走' },
  { id: 'claimed', title: '已认领', hint: '已分配，尚未开始' },
  { id: 'blocked', title: '阻塞', hint: '等待依赖的任务完成' },
  { id: 'in_progress', title: '进行中', hint: 'agent 正在做' },
  { id: 'completed', title: '已完成', hint: '' },
];

const UNKNOWN_COLUMN: Column = { id: 'unknown', title: '未知状态', hint: 'Claude Code 写入了看板不认识的状态' };

export function columnOf(t: Task): ColumnId {
  switch (t.status) {
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'pending':
      if (t.blocked) return 'blocked';
      return t.owner ? 'claimed' : 'unclaimed';
    default:
      return 'unknown';
  }
}

export function groupByColumn(tasks: Task[]): { columns: Column[]; byColumn: Map<ColumnId, Task[]> } {
  const byColumn = new Map<ColumnId, Task[]>();
  for (const c of [...COLUMNS, UNKNOWN_COLUMN]) byColumn.set(c.id, []);
  for (const t of tasks) byColumn.get(columnOf(t))!.push(t);
  // 只有真的出现未知状态时才显示这一列
  const columns = byColumn.get('unknown')!.length > 0 ? [...COLUMNS, UNKNOWN_COLUMN] : COLUMNS;
  return { columns, byColumn };
}

/** 列表 id 的简短显示：团队名 "session-ab12cd34…" 去掉前缀，会话 UUID 取前 8 位。 */
export function shortId(listId: string): string {
  return listId.replace(/^session-/, '').slice(0, 8);
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
