# agent-board

多 agent 可视化看板：一眼看清项目状态、哪些 agent 在调研、哪些在开发；发布任务后由 agent 按角色自动认领，产出经人工审核才算完成。

> 状态：**第 0 阶段（只读可视化）**。进度见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。

## 现在能做什么

![看板截图（模拟数据）](docs/screenshot.png)

读取 Claude Code 写在 `~/.claude/tasks/` 下的任务列表，在网页上实时显示：

- **总览**：完成百分比、进行中、阻塞、工作中的 agent 数
- **Agent 面板**：每个 agent 的名字、角色、状态（工作中 / 空闲）、正在做的任务
- **任务看板**：待认领 / 已认领 / 阻塞 / 进行中 / 已完成，点开卡片看详情
- **实时更新**：任务文件一变化，页面 1 秒内自动更新，不用刷新

只读，不会修改 Claude Code 的任何文件。

## 启动

需要 Node.js 22 或更高版本，并且和 Claude Code 在**同一台机器**上运行。

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

然后在浏览器打开 http://localhost:4317 。

### 开发模式（改代码后自动刷新）

```bash
npm run dev
```

打开 http://localhost:5173 。

### 可选环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `PORT` | `4317` | 看板服务器端口 |
| `CLAUDE_DIR` | `~/.claude` | Claude Code 数据目录 |

## 怎样让任务出现在看板上

看板显示的是 Claude Code 的任务列表。两种方式：

1. **普通会话**：让 Claude 把工作拆成任务（例如"先把这件事拆成任务清单再做"），它会用自带的任务工具记录。
2. **Agent Teams**（多个 agent 协作，实验性功能）：设置环境变量 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 后在交互式会话里使用。团队成员和角色会显示在 Agent 面板上。详见[官方文档](https://code.claude.com/docs/en/agent-teams)。

## 测试

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
