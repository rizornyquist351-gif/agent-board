# 前期调研（2026-11-23）

## 一、同类项目

| 项目 | 特点 | 可借鉴 |
|---|---|---|
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | 最知名，Apache 2.0，支持十多种 agent；2026-04 停止商业运营，转为本地、社区维护 | 卡片拖到"进行中"自动建 git worktree 并启动 agent |
| [agent-kanban (saltbo)](https://github.com/saltbo/agent-kanban) | agent 有身份；worker 认领提 PR，leader 审核合并；FSL 许可 | 原子认领、SSE 实时更新 |
| [kanban-md](https://github.com/antopolskiy/kanban-md) | 纯文件，无数据库/服务器，MIT | `pick --claim` 认领，终端看板 |
| [Marcus](https://github.com/painted-porch/marcus) | 编排服务器，MIT | 通过看板协调，而非聊天 |
| [Emerge Factory](https://github.com/tryemerge/code-factory) | 看板 + "工厂车间"视图 | 网格实时显示每个 agent 输出 |
| [Orchestro MCP](https://www.indiehackers.com/product/orchestro-mcp) | Next.js + MCP 服务器 | 依赖图、事件时间线 |
| [Claude Code Kanban](https://github.com/NikiforovAll/claude-code-kanban) | 只读观察，用 hooks 收集状态，SSE 推送 | 不改变 agent 运行方式 |
| [Cline Kanban](https://github.com/cline/kanban) | 研究预览版 | 任务依赖、自动提交与 PR、人工介入 |
| [agent-task-board](https://github.com/davidcjw/agent-task-board) / [HiveBoard](https://github.com/boengai/hiveboard) | 派发 Claude CLI 做任务 | 排队 → 运行 → 审核 → 完成 |

**共性**：几乎都只围绕"写代码"。按角色（调研 / 开发）分工、支持非编码任务的较少——这是本项目的特色方向。

## 二、市场与官方能力

- Vibe Kanban 约 2.88 万星，2026-04-10 宣布关停商业服务，原因是绝大多数为免费用户、找不到满意的商业模式。来源：[关停 PR](https://github.com/BloopAI/vibe-kanban/pull/3387)、[DEV](https://dev.to/agentverateam/vibe-kanban-alternatives-after-the-bloop-shutdown-2026-p80)、[first-tree](https://first-tree.ai/compare/vs-vibe-kanban)
- HN 评价这类工具普遍是"原型级编排器"，尚无共识。来源：[HN](https://news.ycombinator.com/item?id=46864977)
- Claude Code **Agent Teams**（实验性）：共享任务列表，队友可自主认领或由组长分配，支持依赖阻塞。来源：[官方文档](https://code.claude.com/docs/en/agent-teams)

## 三、踩坑经验

1. **人工审核是真正的瓶颈**：经验上 3–8 个 agent 并行就到上限（个人经验，非严格测量）。来源：[DEV](https://dev.to/battyterm/5-lessons-from-running-ai-coding-agents-in-parallel-53on)、[agentsroom](https://agentsroom.dev/blog/run-coding-agents-in-parallel)、[devdojo](https://devdojo.academy/en/blog/parallel-coding-agents-what-breaks-at-merge)
2. **隔离也会冲突**：路由表、配置等"中心文件"几乎每个功能都要改；改同一批文件的任务应顺序执行，合并走统一队列。
3. **共享待办池会重复领取**：有作者报告两个 agent 领了同一个功能 → 需要原子认领。
4. **任务描述要具体**：Anthropic 要求每个子任务写清目标、产出格式、工具/来源、任务边界。来源：[Anthropic 工程博客](https://www.anthropic.com/engineering/multi-agent-research-system)
5. **成本高**：多 agent 约为普通对话 15 倍 token；内部调研评测比单 agent 强 90.2%。同上来源。
6. **调研适合并行，开发不太适合**：只读任务并行安全，强依赖的开发任务效果差。
7. **失败多源于设计与协调**：UC Berkeley [MAST](https://arxiv.org/abs/2503.13657)（NeurIPS 2025）归纳 14 种失败模式、三大类：系统设计、agent 间失调、结果验证不足。

## 四、个人项目为何半途而废

"80% 做不完"之类的统计大多无可靠来源，但原因一致：**范围膨胀、没定义"做完"**。对策：每个功能问"是核心必需还是看起来很酷"；第一版只做能验证想法的最小版本。来源：[DEV](https://dev.to/teamcamp/the-side-project-paradox-why-80-fail-and-how-to-be-the-20-39jn)、[MindStudio](https://mindstudio.ai/blog/why-side-projects-never-ship)

## 五、第 0 阶段数据来源：Claude Code 任务数据（2026-11-23 调研，Claude Code 2.1.330）

### 官方文档说明的（[agent-teams](https://code.claude.com/docs/en/agent-teams)）

| 数据 | 路径 | 生命周期 |
|---|---|---|
| 任务列表 | `~/.claude/tasks/{team-name}/` | 会话结束后保留，按 `cleanupPeriodDays` 清理 |
| 团队配置 | `~/.claude/teams/{team-name}/config.json` | **会话结束时删除** |
| 每个 agent 的信箱 | `~/.claude/teams/{team-name}/inboxes/{agent-name}.json` | 同上 |

- 团队名 = `session-` + 会话 ID 前 8 位。
- `config.json` 有 `members` 数组：每个成员的名字、agent ID、agent 类型（组长固定为 `team-lead`）。
- 任务三种状态：`pending` / `in_progress` / `completed`；"阻塞"只是显示状态。认领用文件锁防竞争。
- 可用于观察的 hooks：`TaskCreated`、`TaskCompleted`、`TeammateIdle`。
- 限制：实验性功能；需交互式会话（`-p` 模式不会创建队友）；一个会话一个团队；任务状态可能滞后；队友有时忘记标记完成。
- **文档没有说明任务文件的字段格式，也没说直接读这些文件是受支持的接口。**

### 实测得到的（用 Claude Code 自带任务工具创建了一个测试任务）

- 普通会话（不开 Agent Teams）也会写任务文件：`~/.claude/tasks/{会话 ID}/`
- **每个任务一个文件** `{id}.json`，目录下另有一个空的 `.lock` 文件。
- 任务文件内容：

```json
{
  "id": "1",
  "subject": "调研 Agent Teams 任务数据格式",
  "description": "……",
  "activeForm": "调研任务数据格式",
  "status": "in_progress",
  "blocks": [],
  "blockedBy": [],
  "metadata": { "probe": true },
  "owner": "main"
}
```

- `metadata` 可以放任意字段 → 以后可以用来存"角色""验收标准"等，不用另建存储。

### 风险

格式是实测得来、未被官方文档承诺，Claude Code 升级可能改变 → 读取逻辑必须**集中在一个适配器模块里**，字段缺失或多出时容错，不能让整个看板崩掉。

## 六、后台运行 Claude Code（第 1 阶段，2026-11-23 实测，Claude Code 2.1.330）

**执行 agent**：`claude -p "<任务>" --output-format stream-json --verbose --permission-mode <模式> --max-budget-usd <上限>`
- 每行一个 JSON 事件。有用的几种：
  - `{"type":"system","subtype":"init", "session_id", "model", "permissionMode", ...}`
  - `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{...}}, {"type":"text","text":"..."}]}}` → agent 在做什么
  - `{"type":"user","message":{"content":[{"type":"tool_result","is_error":false,"content":"..."}]}}` → 执行结果
  - `{"type":"result","subtype":"success"|"error_max_budget_usd"|..., "is_error", "result", "total_cost_usd", "num_turns", "session_id", "permission_denials":[]}` → 结束
  - 另有大量 `stream_event`、`rate_limit_event` 等，可忽略。
- 实测"新建文件并 cat"：2 轮、约 0.003 美元（haiku）。

**规划 agent**：`claude -p "<拆任务>" --output-format json --json-schema '<schema>' --tools "Read,Glob,Grep"`
- 结果在 `structured_output` 字段，已按 schema 校验。
- **只读工具很重要**：用 `--permission-mode plan` 时 agent 自行大量探索，0.1 美元预算被用超（`error_max_budget_usd`）；改为只给 Read/Glob/Grep 后 6 轮约 0.002 美元。

**其他有用参数**：`-w/--worktree [name]`（自动建 worktree）、`--session-id`、`--resume`、`--model`、`--append-system-prompt`。

## 七、未完成的调研

- 各小项目的活跃度（最近提交、issue 数）未逐一核实。
- 开启 Agent Teams 后 `config.json` 的完整格式（需要在交互式会话中实测）。
