// 许愿（第 1 阶段）的数据类型，前后端共用。

export type WishStatus =
  | 'planning' // 规划 agent 正在拆任务
  | 'plan_failed' // 拆任务失败
  | 'awaiting_confirm' // 等用户确认任务清单
  | 'running' // agent 正在按顺序干活
  | 'failed' // 某个任务失败，等用户决定重试 / 跳过
  | 'stopped' // 用户手动停止
  | 'awaiting_review' // 全部完成，等用户 通过 / 打回
  | 'merged' // 已通过并合并
  | 'discarded'; // 已打回，改动已丢弃

export type TaskStatus = 'todo' | 'running' | 'done' | 'failed' | 'skipped';

export interface Activity {
  at: number;
  kind: 'tool' | 'text' | 'error' | 'info';
  /** 给用户看的大白话 */
  text: string;
}

export interface WishTask {
  id: string;
  title: string;
  goal: string;
  deliverable: string;
  boundaries: string;
  acceptance: string;
  status: TaskStatus;
  /** 最近的活动，最新在最后 */
  activity: Activity[];
  /** agent 最后的总结 */
  resultText?: string;
  error?: string;
  costUsd: number;
  /** 被权限规则拦下的操作数 */
  denials: number;
}

export interface Wish {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  status: WishStatus;
  /** 规划 agent 对愿望的理解，一两句话 */
  understanding?: string;
  tasks: WishTask[];
  /** 本次许愿使用的分支 */
  branch?: string;
  /** 开始时主分支所在的提交 */
  baseCommit?: string;
  costUsd: number;
  error?: string;
  /** 待审核时的改动摘要（git diff --stat） */
  diffStat?: string;
  /** 待审核时的完整改动（可能被截断） */
  diff?: string;
}

export interface ProjectInfo {
  path: string;
  name: string;
  /** 当前所在分支 */
  branch?: string;
  /** 项目不可用的原因（不是 git 仓库、没有提交等），为空表示可用 */
  problem?: string;
}

/** 规划结果中单个任务的字段（用户确认前可以修改） */
export type PlannedTask = Pick<WishTask, 'title' | 'goal' | 'deliverable' | 'boundaries' | 'acceptance'>;
