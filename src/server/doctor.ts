// 启动自检：看板需要的东西是否齐全。缺什么就用大白话告诉用户怎么办（第 3 阶段）。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HealthCheck } from '../shared/wish.ts';

const exec = promisify(execFile);

async function run(bin: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await exec(bin, args, { timeout: 20_000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export async function checkHealth(opts: { claudeBin?: string; fake?: boolean } = {}): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];

  const gitVersion = await run('git', ['--version']);
  checks.push(
    gitVersion
      ? { id: 'git', ok: true, label: `已安装 git（${gitVersion.replace('git version ', '')}）` }
      : { id: 'git', ok: false, label: '没有找到 git', fix: 'agent-board 用 git 分支隔离 agent 的改动。请先安装 git：https://git-scm.com/downloads ，装好后点"重新检查"。' },
  );

  if (opts.fake) {
    checks.push({ id: 'claude', ok: true, label: '演示模式：不需要 Claude Code' });
    return checks;
  }

  const bin = opts.claudeBin ?? 'claude';
  const version = await run(bin, ['--version']);
  if (!version) {
    checks.push({
      id: 'claude',
      ok: false,
      label: '没有找到 Claude Code',
      fix: '干活的 agent 是 Claude Code。请先安装：在终端运行 npm install -g @anthropic-ai/claude-code（或参考 https://code.claude.com ），装好后点"重新检查"。想先不花钱看看效果，可以用演示模式启动：AGENT_BOARD_FAKE=1。',
    });
    return checks;
  }
  checks.push({ id: 'claude', ok: true, label: `已安装 Claude Code（${version.split(' ')[0]}）` });

  const status = await run(bin, ['auth', 'status']);
  let loggedIn: boolean | undefined;
  try {
    loggedIn = JSON.parse(status ?? '').loggedIn;
  } catch {
    loggedIn = undefined; // 老版本没有这个命令：不拦着，真出问题时运行会报错
  }
  if (loggedIn === false) {
    checks.push({ id: 'login', ok: false, label: 'Claude Code 还没登录', fix: '请在终端运行 claude，按提示登录你的 Anthropic 账号，然后点"重新检查"。' });
  } else if (loggedIn === true) {
    checks.push({ id: 'login', ok: true, label: 'Claude Code 已登录' });
  }
  return checks;
}
