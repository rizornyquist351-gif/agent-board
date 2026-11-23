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
  it('接受合格的规划', () => {
    const p = parsePlan({ understanding: '理解', tasks: [{ title: ' 加 LICENSE ', goal: 'g', deliverable: 'd', boundaries: 'b', acceptance: 'a' }] });
    expect(p).toEqual({ understanding: '理解', tasks: [{ title: '加 LICENSE', goal: 'g', deliverable: 'd', boundaries: 'b', acceptance: 'a' }] });
  });
  it('拒绝空的或坏的规划', () => {
    expect(parsePlan(undefined)).toBeUndefined();
    expect(parsePlan({ tasks: [] })).toBeUndefined();
    expect(parsePlan({ tasks: [{ goal: '没有标题' }] })).toBeUndefined();
  });
});

describe('workPrompt', () => {
  it('包含任务、前序结果和规则', () => {
    const p = workPrompt('加暗色模式', { title: '改样式', goal: 'g', deliverable: 'd', boundaries: 'b', acceptance: 'a' }, 1, 2, [{ title: '调研', result: '用 CSS 变量' }]);
    expect(p).toContain('第 2 个');
    expect(p).toContain('## 本任务：改样式');
    expect(p).toContain('调研：用 CSS 变量');
    expect(p).toContain('不要执行 git commit');
  });
});
