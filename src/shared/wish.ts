// 许愿（第 1 阶段）的数据类型，前后端共用。

export type WishStatus =
  | 'planning' // 规划 agent 正在拆任务
  | 'plan_failed' // 拆任务失败
  | 'awaiting_confirm' // 等用户确认任务清单
  | 'running' // agent 正在干活（可能多个并行）
  | 'failed' // 有任务失败、其余能做的都做完了，等用户决定重试 / 跳过
  | 'stopped' // 用户手动停止
  | 'awaiting_review' // 全部完成，等用户 通过 / 打回
  | 'merged' // 已通过并合并
  | 'discarded'; // 已打回，改动已丢弃

export type TaskStatus = 'todo' | 'running' | 'done' | 'failed' | 'skipped';

/** research：调研员，只读 + 可上网，产出报告；develop：开发者，改代码（D16） */
export type TaskRole = 'research' | 'develop';

export interface Activity {
  at: number;
  kind: 'tool' | 'text' | 'error' | 'info';
  /** 给用户看的大白话 */
  text: string;
}

export interface WishTask {
  id: string;
  role: TaskRole;
  /** resolve：验收合并时和项目最新代码冲突，自动追加的"解决冲突"任务 */
  kind?: 'resolve';
  /** 依赖的任务 id；这些任务完成（或跳过）后才开始 */
  dependsOn: string[];
  /** 正在干活的 agent 的名字，如"开发者 2" */
  agent?: string;
  /** 第几次尝试（合并冲突时会自动重做） */
  attempts: number;
  /** 开发任务合并进愿望分支时的改动摘要 */
  diffStat?: string;
  title: string;
  goal: string;
  deliverable: string;
  boundaries: string;
  acceptance: string;
  status: TaskStatus;
  /** 最近的活动，最新在最后 */
  activity: Activity[];
  /** agent 最后的总结；调研任务就是调研报告 */
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
export type PlannedTask = Pick<WishTask, 'title' | 'goal' | 'deliverable' | 'boundaries' | 'acceptance' | 'role' | 'dependsOn'> & {
  /** 修改后的清单里保留原来的 id，依赖关系才对得上 */
  id?: string;
};

/** 正在干活的 agent（Agent 面板用） */
export interface RunningAgent {
  name: string;
  role: TaskRole;
  wishId: string;
  wishText: string;
  taskId: string;
  taskTitle: string;
  /** 最近一条活动 */
  doing?: string;
  since: number;
}

/** 启动自检的一项 */
export interface HealthCheck {
  id: string;
  ok: boolean;
  label: string;
  /** 不通过时告诉用户怎么办 */
  fix?: string;
}

/** 服务器推给网页的许愿数据 */
export interface WishesPayload {
  project: ProjectInfo;
  fake: boolean;
  wishes: Wish[];
  agents: RunningAgent[];
  maxAgents: number;
  health: HealthCheck[];
  /** 最近打开过的项目，方便切换 */
  recent: string[];
  /** 执行 agent 实际使用的权限模式（auto 不可用时会自动降级） */
  permissionMode: string;
}
