// 前后端共用的数据类型。看板只认这里的类型，不直接依赖 Claude Code 的文件格式。

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'unknown';

export interface Task {
  /** 在所属任务列表内的 id（Claude Code 的 "1"、"2"…） */
  id: string;
  /** 所属任务列表（= ~/.claude/tasks 下的目录名） */
  listId: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  /** 依赖的任务里还有没完成的 → 阻塞（Claude Code 中只是显示状态，不是真正的 status） */
  blocked: boolean;
  metadata: Record<string, unknown>;
  /** 文件最后修改时间（毫秒） */
  updatedAt: number;
}

export type AgentStatus = 'working' | 'idle';

export interface Agent {
  name: string;
  listId: string;
  /** 来自团队配置的 agent 类型，组长为 team-lead */
  agentType?: string;
  /** team：来自团队配置；owner：只在任务 owner 字段里出现过 */
  source: 'team' | 'owner';
  status: AgentStatus;
  /** 正在进行中的任务 id */
  currentTaskIds: string[];
}

export interface TaskList {
  id: string;
  /** team：有对应的团队配置（Agent Teams）；session：普通会话的任务列表 */
  kind: 'team' | 'session';
  taskCount: number;
  updatedAt: number;
}

export interface BoardState {
  generatedAt: number;
  claudeDir: string;
  lists: TaskList[];
  tasks: Task[];
  agents: Agent[];
  /** 读取时遇到的问题（坏文件、未知字段等），不影响其余数据 */
  warnings: string[];
}
