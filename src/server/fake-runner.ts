// 假的 Runner：不调用 Claude，不花钱。用于测试和离线演示（AGENT_BOARD_FAKE=1）。
// 规划时把愿望拆成两个任务；执行时模拟几步活动，并真的写一个文件，好让审核时有改动可看。

import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Activity } from '../shared/wish.ts';
import type { RunHandle, RunResult, Runner } from './claude.ts';

export interface FakeOptions {
  /** 每一步的间隔，毫秒 */
  stepMs?: number;
  /** 让第 n 次 work 调用失败（从 1 开始），用于测试 */
  failOnWork?: number;
}

function handle(steps: (() => Promise<void> | void)[], stepMs: number, finish: () => Promise<RunResult> | RunResult): RunHandle {
  let stopped = false;
  const done = (async () => {
    for (const s of steps) {
      await new Promise((r) => setTimeout(r, stepMs));
      if (stopped) return { ok: false, text: '已被手动停止', costUsd: 0, denials: 0 };
      await s();
    }
    await new Promise((r) => setTimeout(r, stepMs));
    if (stopped) return { ok: false, text: '已被手动停止', costUsd: 0, denials: 0 };
    return finish();
  })();
  return { done, stop: () => (stopped = true) };
}

export function createFakeRunner(opts: FakeOptions = {}): Runner {
  const stepMs = opts.stepMs ?? 800;
  let works = 0;
  return {
    plan({ prompt }) {
      const wish = prompt.split('用户的愿望：')[1]?.trim() ?? '愿望';
      return handle([], stepMs, () => ({
        ok: true,
        text: '',
        costUsd: 0.002,
        denials: 0,
        structured: {
          understanding: `你想要：${wish}。我会先摸清现状，再动手实现。`,
          tasks: [
            { title: '摸清现状', goal: '了解项目里和这个愿望相关的部分', deliverable: '一份简短的说明（写在 NOTES.md）', boundaries: '不改业务代码', acceptance: 'NOTES.md 说清楚要改哪些地方' },
            { title: '动手实现', goal: wish, deliverable: '对应的文件改动', boundaries: '只改和愿望相关的文件', acceptance: '改动完成并自查一遍' },
          ],
        },
      }));
    },
    work({ cwd, prompt, onActivity }) {
      works += 1;
      const n = works;
      const title = prompt.match(/## 本任务：(.+)/)?.[1] ?? '任务';
      const act = (kind: Activity['kind'], text: string) => () => onActivity({ at: Date.now(), kind, text });
      const steps = [
        act('tool', '正在找文件：**/*'),
        act('tool', '正在看 README.md'),
        act('text', `我先看了看项目结构，接下来处理"${title}"。`),
        act('tool', '正在写 NOTES.md'),
        async () => appendFile(join(cwd, 'NOTES.md'), `- ${title}（演示 agent 写入）\n`),
        act('tool', '正在运行命令：检查改动'),
      ];
      return handle(steps, stepMs, () =>
        n === opts.failOnWork
          ? { ok: false, text: '超出了这一步的费用上限', costUsd: 0.01, denials: 0 }
          : { ok: true, text: `完成了"${title}"：在 NOTES.md 里记了一笔（演示模式）。`, costUsd: 0.01, denials: 0 },
      );
    },
  };
}
