// 看板需要的几个 git 操作。全部通过 execFile 调用 git，参数不经过 shell。

import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectInfo } from '../shared/wish.ts';

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  // core.quotePath=false：中文文件名原样显示，而不是 "\346\226\207" 这样的转义
  const { stdout } = await exec('git', ['-c', 'core.quotePath=false', ...args], { cwd, maxBuffer: 20 * 1024 * 1024 });
  return stdout.trim();
}

export async function projectInfo(path: string): Promise<ProjectInfo> {
  const info: ProjectInfo = { path, name: basename(path) };
  try {
    const top = await git(path, 'rev-parse', '--show-toplevel');
    info.path = top;
    info.name = basename(top);
  } catch {
    info.problem = '这个目录不是 git 仓库。agent-board 需要用 git 分支来隔离 agent 的改动，请先运行 git init 并提交一次。';
    return info;
  }
  try {
    await git(info.path, 'rev-parse', 'HEAD');
  } catch {
    info.problem = '这个仓库还没有任何提交。请先提交一次（例如 git commit --allow-empty -m init）。';
    return info;
  }
  try {
    info.branch = await git(info.path, 'symbolic-ref', '--short', 'HEAD');
  } catch {
    info.problem = '当前不在任何分支上（detached HEAD）。请先切换到一个分支。';
  }
  return info;
}

/** 让 git 忽略 .agent-board/，不改用户的 .gitignore。 */
export async function ignoreBoardDir(project: string): Promise<void> {
  const { appendFile, readFile } = await import('node:fs/promises');
  const exclude = await git(project, 'rev-parse', '--git-path', 'info/exclude');
  const path = exclude.startsWith('/') ? exclude : `${project}/${exclude}`;
  let content = '';
  try {
    content = await readFile(path, 'utf8');
  } catch {
    /* 文件不存在 */
  }
  if (!content.split('\n').includes('/.agent-board/')) {
    await appendFile(path, `${content && !content.endsWith('\n') ? '\n' : ''}/.agent-board/\n`);
  }
}

export async function addWorktree(project: string, dir: string, branch: string, startPoint = 'HEAD'): Promise<string> {
  const base = await git(project, 'rev-parse', startPoint);
  await git(project, 'worktree', 'add', '-b', branch, dir, base);
  return base;
}

/** 为已有分支建 worktree（看板重启后补建用）。 */
export async function addWorktreeForBranch(project: string, dir: string, branch: string): Promise<void> {
  await git(project, 'worktree', 'prune');
  await git(project, 'worktree', 'add', dir, branch);
}

/** 在 dir（愿望分支的 worktree）里合并 branch；冲突时撤销并返回 conflict。 */
export async function mergeInto(dir: string, branch: string, message: string): Promise<{ ok: true; stat: string } | { ok: false; conflict: boolean; message: string }> {
  const before = await git(dir, 'rev-parse', 'HEAD');
  try {
    await git(dir, '-c', 'user.name=agent-board', '-c', 'user.email=agent-board@localhost', 'merge', '--no-ff', '-m', message, branch);
  } catch (err) {
    // CONFLICT 提示在标准输出里，不在错误信息里；直接问 git 有没有未解决的冲突文件
    let conflict = false;
    try {
      conflict = (await git(dir, 'diff', '--name-only', '--diff-filter=U')).length > 0;
    } catch {
      /* 忽略 */
    }
    try {
      await git(dir, 'merge', '--abort');
    } catch {
      /* 没有进行中的合并 */
    }
    return { ok: false, conflict, message: (err as Error).message.split('\n')[0] };
  }
  const stat = await git(dir, 'diff', '--stat', before, 'HEAD');
  return { ok: true, stat };
}

/** 把工作区的全部改动提交；没有改动返回 false。 */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await git(dir, 'add', '-A');
  const status = await git(dir, 'status', '--porcelain');
  if (!status) return false;
  await git(dir, '-c', 'user.name=agent-board', '-c', 'user.email=agent-board@localhost', 'commit', '-q', '-m', message);
  return true;
}

export async function diffSummary(project: string, base: string, branch: string, maxChars = 200_000): Promise<{ stat: string; diff: string }> {
  const stat = await git(project, 'diff', '--stat', `${base}...${branch}`);
  let diff = await git(project, 'diff', `${base}...${branch}`);
  if (diff.length > maxChars) diff = `${diff.slice(0, maxChars)}\n\n…（改动太多，只显示前 ${maxChars} 个字符）`;
  return { stat, diff };
}

export async function removeWorktree(project: string, dir: string, branch: string): Promise<void> {
  try {
    await git(project, 'worktree', 'remove', '--force', dir);
  } catch {
    /* 可能已被删除 */
  }
  try {
    await git(project, 'branch', '-D', branch);
  } catch {
    /* 可能已被删除 */
  }
}

/** 合并到用户当前分支。用户工作区有未提交改动时拒绝，避免弄乱用户的东西。 */
export async function unmergedFiles(dir: string): Promise<string[]> {
  const out = await git(dir, 'diff', '--name-only', '--diff-filter=U');
  return out ? out.split('\n') : [];
}

/** 在 dir 里开始合并 branch；有冲突时保留冲突现场（不撤销），返回冲突文件。 */
export async function startMerge(dir: string, branch: string, message: string): Promise<{ ok: true } | { ok: false; files: string[]; message: string }> {
  try {
    await git(dir, '-c', 'user.name=agent-board', '-c', 'user.email=agent-board@localhost', 'merge', '--no-ff', '-m', message, branch);
    return { ok: true };
  } catch (err) {
    return { ok: false, files: await unmergedFiles(dir).catch(() => []), message: (err as Error).message.split('\n')[0] };
  }
}

/** 冲突解决后提交合并；仍有冲突标记或未解决文件时返回问题描述。 */
export async function finishMerge(dir: string, files: string[]): Promise<string | undefined> {
  const { readFile } = await import('node:fs/promises');
  for (const f of files) {
    try {
      if (/^(<{7}|>{7})( |$)/m.test(await readFile(`${dir}/${f}`, 'utf8'))) return `${f} 里还有冲突标记`;
    } catch {
      /* 文件被删除也算一种解决 */
    }
  }
  await git(dir, 'add', '-A');
  const left = await unmergedFiles(dir);
  if (left.length) return `还有文件没解决：${left.join('、')}`;
  await git(dir, '-c', 'user.name=agent-board', '-c', 'user.email=agent-board@localhost', 'commit', '-q', '--no-edit');
  return undefined;
}

export async function abortMerge(dir: string): Promise<void> {
  try {
    await git(dir, 'merge', '--abort');
  } catch {
    /* 没有进行中的合并 */
  }
}

export async function mergeBranch(project: string, branch: string, message: string): Promise<{ ok: boolean; conflict?: boolean; problem?: string }> {
  const dirty = await git(project, 'status', '--porcelain', '--untracked-files=no');
  if (dirty) {
    return { ok: false, problem: '你的项目里有还没提交的改动。为了不弄乱它们，请先提交或暂存（git stash），再点"通过"。' };
  }
  try {
    await git(project, '-c', 'user.name=agent-board', '-c', 'user.email=agent-board@localhost', 'merge', '--no-ff', '-m', message, branch);
    return { ok: true };
  } catch (err) {
    const conflict = (await unmergedFiles(project).catch(() => [])).length > 0;
    await abortMerge(project);
    return { ok: false, conflict, problem: `合并失败，已撤销，你的项目没有变化。（${(err as Error).message.split('\n')[0]}）` };
  }
}
