import { describe, expect, it } from 'vitest';
import type { Task } from '../src/shared/types.ts';
import { columnOf, groupByColumn, shortId, timeAgo } from './board.ts';

function task(p: Partial<Task>): Task {
  return { id: '1', listId: 'l', subject: 's', description: '', status: 'pending', blocks: [], blockedBy: [], blocked: false, metadata: {}, updatedAt: 0, ...p };
}

describe('columnOf', () => {
  it('pending 按 owner 和阻塞细分', () => {
    expect(columnOf(task({}))).toBe('unclaimed');
    expect(columnOf(task({ owner: 'dev' }))).toBe('claimed');
    expect(columnOf(task({ owner: 'dev', blocked: true }))).toBe('blocked');
  });
  it('其他状态', () => {
    expect(columnOf(task({ status: 'in_progress' }))).toBe('in_progress');
    expect(columnOf(task({ status: 'completed' }))).toBe('completed');
    expect(columnOf(task({ status: 'unknown' }))).toBe('unknown');
  });
});

describe('groupByColumn', () => {
  it('只有出现未知状态时才多一列', () => {
    expect(groupByColumn([task({})]).columns).toHaveLength(5);
    expect(groupByColumn([task({ status: 'unknown' })]).columns).toHaveLength(6);
  });
});

describe('shortId', () => {
  it('团队名去前缀，UUID 取前 8 位', () => {
    expect(shortId('session-ab12cd34')).toBe('ab12cd34');
    expect(shortId('e6577d4a-d10c-5382-8cb8-03a63e3256e1')).toBe('e6577d4a');
    expect(shortId('mylist')).toBe('mylist');
  });
});

describe('timeAgo', () => {
  it('格式化', () => {
    expect(timeAgo(0, 30_000)).toBe('刚刚');
    expect(timeAgo(0, 5 * 60_000)).toBe('5 分钟前');
    expect(timeAgo(0, 3 * 3600_000)).toBe('3 小时前');
  });
});
