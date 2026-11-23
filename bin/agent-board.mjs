#!/usr/bin/env node
// 命令行入口：npx github:rizornyquist351-gif/agent-board [项目目录]
import { register } from 'tsx/esm/api';

const arg = process.argv[2];
if (arg === '--help' || arg === '-h') {
  console.log(`agent-board：许愿式的 agent 看板

用法：
  npx github:rizornyquist351-gif/agent-board [项目目录]

项目目录默认为当前目录，需要是一个 git 仓库。启动后会自动打开浏览器。

常用环境变量：
  AGENT_BOARD_FAKE=1         演示模式：假 agent，不调用 Claude、不花钱
  AGENT_BOARD_MAX_AGENTS=3   同时最多几个 agent 干活
  AGENT_BOARD_MODEL=sonnet   指定模型
  AGENT_BOARD_OPEN=0         不自动打开浏览器
  PORT=4317                  端口（被占用时自动往后找）

更多说明：https://github.com/rizornyquist351-gif/agent-board`);
  process.exit(0);
}

process.env.AGENT_BOARD_OPEN ??= '1';
register();
await import('../src/server/index.ts');
