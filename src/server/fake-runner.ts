// 假的 Runner：不调用 Claude，不花钱。用于测试和离线演示（AGENT_BOARD_FAKE=1）。
// 规划：1 个调研任务 + 2 个依赖它、可以同时做的开发任务。
// 执行：模拟几步活动；开发任务会真的写文件，好让合并和验收时有改动可看。

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Activity } from '../shared/wish.ts';
import type { RunHandle, RunResult, Runner } from './claude.ts';

export interface FakeOptions {
  /** 每一步的间隔，毫秒 */
  stepMs?: number;
  /** 让第 n 次 work 调用失败（从 1 开始），用于测试 */
  failOnWork?: number;
  /** 开发任务都写同一个文件，用于制造合并冲突 */
  sameFile?: boolean;
}

function handle(steps: (() => Promise<void> | void)[], stepMs: number, finish: () => Promise<RunResult> | RunResult): RunHandle {
  let stopped = false;
  const stoppedResult: RunResult = { ok: false, text: '已被手动停止', costUsd: 0, denials: 0 };
  const done = (async () => {
    for (const s of steps) {
      await new Promise((r) => setTimeout(r, stepMs));
      if (stopped) return stoppedResult;
      await s();
    }
    await new Promise((r) => setTimeout(r, stepMs));
    if (stopped) return stoppedResult;
    return finish();
  })();
  return { done, stop: () => (stopped = true) };
}

export function createFakeRunner(opts: FakeOptions = {}): Runner {
  const stepMs = opts.stepMs ?? 900;
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
          understanding: `你想要：${wish}。先派调研员摸清现状，再让两位开发者同时动手。`,
          tasks: [
            { role: 'research', dependsOn: [], title: '摸清现状', goal: '了解项目里和这个愿望相关的部分', deliverable: '一份简短的调研报告', boundaries: '不改任何文件', acceptance: '报告说清楚要改哪些地方' },
            { role: 'develop', dependsOn: [1], title: '实现主要功能', goal: wish, deliverable: '对应的文件改动', boundaries: '只改和愿望相关的文件', acceptance: '改动完成并自查一遍' },
            { role: 'develop', dependsOn: [1], title: '补上说明文档', goal: `为"${wish}"写使用说明`, deliverable: '文档改动', boundaries: '只改文档', acceptance: '说明清楚怎么用' },
          ],
        },
      }));
    },
    work({ cwd, prompt, role, onActivity }) {
      // 解决冲突：删掉冲突标记，两边内容都保留
      if (prompt.includes('## 冲突文件')) {
        const files = (prompt.split('## 冲突文件')[1].split('##')[0].match(/^- (.+)$/gm) ?? []).map((l) => l.slice(2));
        const steps = files.map((f) => async () => {
          onActivity({ at: Date.now(), kind: 'tool', text: `正在修改 ${f}` });
          const text = await readFile(join(cwd, f), 'utf8');
          await writeFile(join(cwd, f), text.split('\n').filter((l) => !/^(<{7}|={7}|>{7})/.test(l)).join('\n'));
        });
        return handle(steps, stepMs, () => ({ ok: true, text: `两边的内容都保留了（演示模式）：${files.join('、')}`, costUsd: 0.01, denials: 0 }));
      }
      works += 1;
      const n = works;
      const title = prompt.match(/## 你的任务：(.+)/)?.[1] ?? '任务';
      const act = (kind: Activity['kind'], text: string) => () => onActivity({ at: Date.now(), kind, text });
      const file = opts.sameFile ? 'NOTES.md' : join('notes', `${title}.md`);
      const steps =
        role === 'research'
          ? [act('tool', '正在找文件：**/*'), act('tool', '正在看 README.md'), act('tool', '正在上网搜：最佳实践'), act('text', '资料够了，开始写报告。')]
          : [
              act('tool', '正在看 README.md'),
              act('text', `我看了调研报告，开始"${title}"。`),
              act('tool', `正在写 ${file}`),
              async () => {
                await mkdir(join(cwd, 'notes'), { recursive: true });
                await appendFile(join(cwd, file), `- ${title}（演示 agent 写入，第 ${n} 次调用）\n`);
              },
              act('tool', '正在运行命令：检查改动'),
            ];
      return handle(steps, stepMs, () => {
        if (n === opts.failOnWork) return { ok: false, text: '超出了这一步的费用上限', costUsd: 0.01, denials: 0 };
        const text =
          role === 'research'
            ? `## 结论\n要实现"${title}"相关的愿望，主要改 README.md 和新增的说明文件。\n\n## 依据\n- 项目结构很简单\n- 没有现成的类似功能\n\n（演示模式生成的报告）`
            : `完成了"${title}"：写入了 ${file}（演示模式）。`;
        return { ok: true, text, costUsd: 0.01, denials: 0 };
      });
    },
  };
}
