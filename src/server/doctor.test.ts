import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkHealth } from './doctor.ts';

describe('checkHealth', () => {
  it('找不到 Claude Code 时给出安装办法', async () => {
    const checks = await checkHealth({ claudeBin: '/nonexistent/claude' });
    expect(checks.find((c) => c.id === 'git')?.ok).toBe(true);
    const claude = checks.find((c) => c.id === 'claude')!;
    expect(claude.ok).toBe(false);
    expect(claude.fix).toContain('npm install -g @anthropic-ai/claude-code');
  });
  it('演示模式不检查 Claude Code', async () => {
    const checks = await checkHealth({ fake: true });
    expect(checks.every((c) => c.ok)).toBe(true);
  });
  it('能运行 claude 时通过（用假脚本，auth status 不是 JSON 时不拦着）', async () => {
    const bin = fileURLToPath(new URL('../../test-fixtures/fake-claude.sh', import.meta.url));
    const checks = await checkHealth({ claudeBin: bin });
    expect(checks.find((c) => c.id === 'claude')?.ok).toBe(true);
    expect(checks.some((c) => !c.ok)).toBe(false);
  });
});
