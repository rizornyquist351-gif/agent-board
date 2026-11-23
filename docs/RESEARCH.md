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

## 五、未完成的调研

- 各小项目的活跃度（最近提交、issue 数）未逐一核实。
- Claude Code Agent Teams 任务数据的存储位置与格式（第 0 阶段开工前必须查清）。
