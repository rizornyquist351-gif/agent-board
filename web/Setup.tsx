// 第 3 阶段：自检面板、切换项目、提醒。
import { useEffect, useRef, useState } from 'react';
import type { HealthCheck, Wish } from '../src/shared/wish.ts';
import { post } from './useBoard.ts';

/** 自检有没通过的项时显示，告诉用户怎么办 */
export function HealthPanel({ checks }: { checks: HealthCheck[] }) {
  const [busy, setBusy] = useState(false);
  const failed = checks.filter((c) => !c.ok);
  if (!failed.length) return null;
  return (
    <section className="notice notice-bad health">
      <h2>开始之前，还差 {failed.length} 步</h2>
      <ul className="checks">
        {checks.map((c) => (
          <li key={c.id} className={c.ok ? 'ok' : 'bad'}>
            <span aria-hidden="true">{c.ok ? '✓' : '✗'}</span>
            <div>
              <div>{c.label}</div>
              {c.fix && <div className="small muted">{c.fix}</div>}
            </div>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await post('/api/recheck');
            setBusy(false);
          }}
        >
          {busy ? '检查中…' : '重新检查'}
        </button>
      </div>
    </section>
  );
}

/** 切换项目：输入路径，或从最近打开过的里面选 */
export function ProjectSwitcher(props: { current: string; recent: string[]; open?: boolean; onClose?: () => void }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const go = async (p: string) => {
    setBusy(true);
    const err = await post('/api/project', { path: p });
    setBusy(false);
    setError(err);
    if (!err) props.onClose?.();
  };

  return (
    <div className="switcher">
      <form
        className="switcher-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (path.trim()) void go(path.trim());
        }}
      >
        <input id="project-path" ref={input} value={path} placeholder="项目文件夹的完整路径，例如 ~/code/my-blog" onChange={(e) => setPath(e.target.value)} aria-label="项目路径" />
        <button type="submit" className="primary" disabled={busy || !path.trim()}>
          {busy ? '打开中…' : '打开'}
        </button>
        {props.onClose && (
          <button type="button" onClick={props.onClose}>
            取消
          </button>
        )}
      </form>
      {props.recent.length > 0 && (
        <div className="recent">
          <span className="small muted">最近打开过：</span>
          {props.recent.map((p) => (
            <button key={p} type="button" className="example" disabled={busy} onClick={() => void go(p)} title={p}>
              {p.split(/[\\/]/).filter(Boolean).pop()}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      <p className="small muted">需要是一个 git 仓库。切换后，原项目的愿望记录会保留，切回来还能看到。</p>
    </div>
  );
}

const NEEDS_YOU = ['awaiting_confirm', 'awaiting_review', 'failed', 'stopped'];
const NOTIFY_KEY = 'agent-board:notify';

function loadNotify(): boolean {
  try {
    return localStorage.getItem(NOTIFY_KEY) === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  } catch {
    return false;
  }
}

/** 标签页标题显示待处理数量；开启后，页面不在前台时用桌面通知提醒 */
export function useReminders(wishes: Wish[] | undefined) {
  const [notify, setNotify] = useState(loadNotify);
  const seen = useRef<Map<string, string> | undefined>(undefined);
  const count = wishes?.filter((w) => NEEDS_YOU.includes(w.status)).length ?? 0;

  useEffect(() => {
    document.title = count ? `(${count}) agent-board` : 'agent-board';
  }, [count]);

  useEffect(() => {
    if (!wishes) return;
    const prev = seen.current;
    seen.current = new Map(wishes.map((w) => [w.id, w.status]));
    if (!prev || !notify || !document.hidden) return;
    for (const w of wishes) {
      if (prev.get(w.id) === w.status || !NEEDS_YOU.includes(w.status)) continue;
      const what = { awaiting_confirm: '任务拆好了，等你确认', awaiting_review: '做完了，等你验收', failed: '卡住了，需要你看看', stopped: '已停止' }[w.status as string];
      try {
        new Notification(`agent-board：${what}`, { body: w.text, tag: w.id });
      } catch {
        /* 某些浏览器不支持 */
      }
    }
  }, [wishes, notify]);

  const supported = typeof Notification !== 'undefined';
  const toggle = async () => {
    if (!supported) return;
    let on = !notify;
    if (on && Notification.permission !== 'granted') on = (await Notification.requestPermission()) === 'granted';
    setNotify(on);
    try {
      localStorage.setItem(NOTIFY_KEY, on ? '1' : '0');
    } catch {
      /* 忽略 */
    }
  };
  return { count, notify, toggle, supported };
}
