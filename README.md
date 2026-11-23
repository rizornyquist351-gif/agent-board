# agent-board

**许愿式的 agent 看板**：用一句话说想让项目变成什么样，规划员自动拆成任务，agent 在独立分支里干活，你在网页上实时看到它在做什么，满意了点"通过"才合并。

> 状态：**第 1 阶段（许愿最小闭环，单 agent）**。进度见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。

![验收页面截图（演示模式）](docs/screenshot.png)

## 你只需要做三件事

1. **启动**，指定要干活的项目（一个 git 仓库）。
2. **许愿**：在输入框写一句话，比如"给 README 加上安装和使用说明"。规划员会读你的项目，把愿望拆成几个小任务给你看，点"开始"。
3. **验收**：agent 干完后，看它说了什么、改了哪些文件，满意就"通过，合并到我的项目"，不满意就"打回"。

干活过程中页面会用大白话实时显示"正在看 src/app.ts""正在运行命令：运行测试"……需要你处理的事会排在最上面。

## 安全

- agent 在一个**独立的 git 分支**里干活（工作目录在 `~/.agent-board/worktrees/`，不在你的项目里）。**你点"通过"之前，你的项目不会有任何变化。**
- 合并时如果你的项目里有没提交的改动，看板会拒绝合并，免得弄乱你的东西。
- 每一步都有费用上限（默认规划 $0.5、每个任务 $2）。
- 看板只监听本机（127.0.0.1），并拒绝来自其他网站的请求。

## 启动

需要：Node.js 22+、已安装并登录的 [Claude Code](https://code.claude.com)（终端里能运行 `claude`）、git。

```bash
git clone https://github.com/rizornyquist351-gif/agent-board
```

```bash
cd agent-board && npm install && npm run build
```

然后指定你要许愿的项目目录：

```bash
npm start -- /path/to/your/project
```

在浏览器打开 http://localhost:4317 。

### 先不花钱试一试

演示模式用假 agent，不调用 Claude、不花钱，但会真的建分支、提交、合并，可以拿一个测试仓库体验完整流程：

```bash
AGENT_BOARD_FAKE=1 npm start -- /path/to/a/test/repo
```

### 可选设置

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `PORT` | `4317` | 看板端口 |
| `AGENT_BOARD_MODEL` | Claude Code 的默认模型 | 指定模型，如 `sonnet`、`haiku` |
| `AGENT_BOARD_PERMISSION` | `auto` | agent 的权限模式。如果你的账号不支持 `auto`，可改成 `acceptEdits`（只自动允许改文件） |
| `AGENT_BOARD_PLAN_BUDGET` | `0.5` | 规划的费用上限（美元） |
| `AGENT_BOARD_TASK_BUDGET` | `2` | 每个任务的费用上限（美元） |
| `AGENT_BOARD_FAKE` | — | 设为 `1` 使用演示模式 |
| `AGENT_BOARD_PROJECT` | 当前目录 | 要许愿的项目（也可以直接写在 `npm start --` 后面） |
| `CLAUDE_DIR` | `~/.claude` | "Claude Code 任务"标签页读取的数据目录 |

## 另一个标签页：Claude Code 任务

只读地显示你电脑上其他 Claude Code 会话自己的任务清单（第 0 阶段的功能），包括 Agent Teams 的成员和状态。

## 开发

```bash
AGENT_BOARD_PROJECT=/path/to/project npm run dev
```

打开 http://localhost:5173 。测试和类型检查：

```bash
npm test
```

```bash
npm run typecheck
```

## 文档

- [项目宪法 / 目标与不做的事](CLAUDE.md)
- [路线图](docs/ROADMAP.md)
- [工作日志](docs/PROGRESS.md)
- [决策记录](docs/DECISIONS.md)
- [前期调研](docs/RESEARCH.md)
