import { describe, expect, it } from 'vitest';
import { activitiesFromEvent, describeTool, parsePlan, resultFromEvent, workPrompt } from './claude.ts';

describe('describeTool', () => {
  it('翻译成大白话', () => {
    expect(describeTool('Read', { file_path: '/a/b/src/app.ts' })).toBe('正在看 src/app.ts');
    expect(describeTool('Edit', { file_path: 'README.md' })).toBe('正在修改 README.md');
    expect(describeTool('Bash', { command: 'npm test', description: '运行测试' })).toBe('正在运行命令：运行测试');
    expect(describeTool('Bash', { command: 'ls -la' })).toBe('正在运行命令：ls -la');
    expect(describeTool('WebSearch', { query: 'vite' })).toBe('正在上网搜：vite');
    expect(describeTool('Mystery', {})).toBe('正在使用工具 Mystery');
    // 工作目录里的文件显示相对路径，不暴露看板内部的目录名
    expect(describeTool('Read', { file_path: '/home/u/.agent-board/worktrees/p-1/abc/t2/src/convert.py' }, '/home/u/.agent-board/worktrees/p-1/abc/t2')).toBe('正在看 src/convert.py');
    expect(describeTool('Edit', { file_path: 'docs/a.md' }, '/x')).toBe('正在修改 docs/a.md');
  });
});

describe('activitiesFromEvent（实测的事件格式）', () => {
  it('assistant 的工具调用和文字', () => {
    const ev = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: "printf 'hi\\n' > hello.txt", description: '创建 hello.txt' } }, { type: 'text', text: '完成了' }] },
    };
    expect(activitiesFromEvent(ev, 1)).toEqual([
      { at: 1, kind: 'tool', text: '正在运行命令：创建 hello.txt' },
      { at: 1, kind: 'text', text: '完成了' },
    ]);
  });
  it('出错的工具结果', () => {
    const ev = { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'command not found' }] } };
    expect(activitiesFromEvent(ev, 1)[0]).toMatchObject({ kind: 'error' });
  });
  it('其他事件忽略', () => {
    expect(activitiesFromEvent({ type: 'stream_event' })).toEqual([]);
    expect(activitiesFromEvent(null)).toEqual([]);
  });
});

describe('resultFromEvent', () => {
  it('成功', () => {
    const r = resultFromEvent({ type: 'result', subtype: 'success', is_error: false, result: '好了', total_cost_usd: 0.003, permission_denials: [{}] });
    expect(r).toMatchObject({ ok: true, text: '好了', costUsd: 0.003, denials: 1 });
  });
  it('超预算翻译成中文', () => {
    const r = resultFromEvent({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.15 });
    expect(r).toMatchObject({ ok: false, text: '超出了这一步的费用上限', costUsd: 0.15 });
  });
});

describe('parsePlan', () => {
  it('接受合格的规划，换算依赖', () => {
    const p = parsePlan({
      understanding: '理解',
      tasks: [
        { role: 'research', dependsOn: [], title: ' 查资料 ', goal: 'g', deliverable: 'd', boundaries: 'b', acceptance: 'a' },
        { role: 'develop', dependsOn: [1, 1, 2, 5], title: '写代码', goal: 'g', deliverable: 'd', boundaries: 'b', acceptance: 'a' },
      ],
    })!;
    expect(p.understanding).toBe('理解');
    expect(p.tasks.map((t) => [t.id, t.role, t.title, t.dependsOn])).toEqual([
      ['1', 'research', '查资料', []],
      ['2', 'develop', '写代码', ['1']],
    ]);
  });
  it('跳过没标题的任务时，依赖序号照样对得上', () => {
    const p = parsePlan({ tasks: [{ goal: '无标题' }, { title: 'A', dependsOn: [] }, { title: 'B', dependsOn: [1, 2] }] })!;
    expect(p.tasks.map((t) => [t.id, t.dependsOn])).toEqual([['1', []], ['2', ['1']]]);
    expect(p.tasks[0].role).toBe('develop');
  });
  it('拒绝空的或坏的规划', () => {
    expect(parsePlan(undefined)).toBeUndefined();
    expect(parsePlan({ tasks: [] })).toBeUndefined();
    expect(parsePlan({ tasks: [{ goal: '没有标题' }] })).toBeUndefined();
  });
});

describe('workPrompt', () => {
  const task = { title: '改样式', goal: 'g', deliverable: 'd', boundaries: 'b', acceptance: 'a', dependsOn: [] };
  it('开发者：包含任务、调研报告原文和规则', () => {
    const p = workPrompt('加暗色模式', { ...task, role: 'develop' }, 3, [{ title: '调研', role: 'research', result: '## 结论\n用 CSS 变量' }]);
    expect(p).toContain('你是 agent-board 派来的开发者');
    expect(p).toContain('## 你的任务：改样式');
    expect(p).toContain('### 调研报告：调研\n## 结论\n用 CSS 变量');
    expect(p).toContain('不要执行 git commit');
  });
  it('调研员：只读规则', () => {
    const p = workPrompt('加暗色模式', { ...task, role: 'research' }, 1, []);
    expect(p).toContain('调研员');
    expect(p).toContain('不要修改任何文件');
  });
  it('冲突重做时带上提示', () => {
    expect(workPrompt('x', { ...task, role: 'develop' }, 1, [], '冲突了')).toContain('## 注意\n冲突了');
  });
});
