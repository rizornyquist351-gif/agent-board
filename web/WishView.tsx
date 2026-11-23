// 第 1 阶段：许愿视图。用户只需要：写一句话 → 点"开始" → 看 → 点"通过"或"打回"。
import { useEffect, useRef, useState } from 'react';
import type { PlannedTask, Wish, WishTask } from '../src/shared/wish.ts';
import { timeAgo } from './board.ts';
import { post, type WishesPayload } from './useBoard.ts';
import { TASK_STATUS, WISH_STATUS, doneCount, groupWishes, money } from './wishText.ts';

export function WishView({ data }: { data: WishesPayload | undefined }) {
  if (!data) return <p className="muted center">正在连接看板服务器…</p>;
  if (data.project.problem) {
    return (
      <section className="notice notice-bad">
        <h2>这个项目暂时不能许愿</h2>
        <p>{data.project.problem}</p>
        <p className="muted small">项目目录：{data.project.path}</p>
      </section>
    );
  }
  const busy = data.wishes.find((w) => w.status === 'running' || w.status === 'planning');
  const groups = groupWishes(data.wishes);
  return (
    <>
      <WishInput projectName={data.project.name} />
      {groups.action.length > 0 && (
        <section>
          <h2 className="h-action">需要你处理 · {groups.action.length}</h2>
          <div className="wishes">{groups.action.map((w) => <WishCard key={w.id} wish={w} busyOther={busy && busy.id !== w.id ? busy : undefined} />)}</div>
        </section>
      )}
      {groups.busy.length > 0 && (
        <section>
          <h2>正在进行</h2>
          <div className="wishes">{groups.busy.map((w) => <WishCard key={w.id} wish={w} />)}</div>
        </section>
      )}
      {groups.ended.length > 0 && (
        <section>
          <h2>已结束</h2>
          <div className="wishes">{groups.ended.map((w) => <WishCard key={w.id} wish={w} />)}</div>
        </section>
      )}
      {data.wishes.length === 0 && (
        <section className="notice">
          <h2>怎么用</h2>
          <ol className="steps">
            <li>在上面写一句你想做的事，点"许愿"。</li>
            <li>规划员会读你的项目，把愿望拆成几个小任务，你看一眼，点"开始"。</li>
            <li>agent 在一个独立分支里干活，这里实时显示它在做什么。你的项目在你点"通过"之前不会被改动。</li>
            <li>做完后看看改了什么，满意就"通过"（合并），不满意就"打回"（丢弃）。</li>
          </ol>
        </section>
      )}
    </>
  );
}

const EXAMPLES = ['给 README 加上安装和使用说明', '加一个暗色模式', '找出并修复所有拼写错误', '为核心函数补上单元测试'];

function WishInput({ projectName }: { projectName: string }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    const err = await post('/api/wishes', { text });
    setSending(false);
    setError(err);
    if (!err) setText('');
  };

  return (
    <section className="wish-input">
      <label htmlFor="wish-text" className="wish-label">
        你想让 <strong>{projectName}</strong> 变成什么样？
      </label>
      <textarea
        id="wish-text"
        rows={3}
        value={text}
        placeholder={`例如：${EXAMPLES[0]}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
        }}
      />
      <div className="wish-input-row">
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="example" onClick={() => setText(ex)}>
              {ex}
            </button>
          ))}
        </div>
        <button type="button" className="primary" disabled={!text.trim() || sending} onClick={() => void submit()}>
          {sending ? '发送中…' : '许愿'}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

function useAction(wishId: string) {
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const run = async (action: string, body?: unknown) => {
    setPending(action);
    setError(await post(`/api/wishes/${wishId}/${action}`, body));
    setPending(undefined);
  };
  return { pending, error, run };
}

function WishCard({ wish: w, busyOther }: { wish: Wish; busyOther?: Wish }) {
  const s = WISH_STATUS[w.status];
  const { pending, error, run } = useAction(w.id);
  const btn = (action: string, label: string, kind = '', body?: unknown) => (
    <button type="button" className={kind} disabled={!!pending} onClick={() => void run(action, body)}>
      {pending === action ? '处理中…' : label}
    </button>
  );

  return (
    <article className={`wish tone-${s.tone}`}>
      <header className="wish-head">
        <div className="wish-title">{w.text}</div>
        <span className={`pill pill-${s.tone}`}>{s.label}</span>
      </header>
      <div className="wish-meta small muted">
        <span>{timeAgo(w.createdAt)}许愿</span>
        {w.tasks.length > 0 && <span>任务 {doneCount(w)} / {w.tasks.length}</span>}
        <span>花费 {money(w.costUsd)}</span>
        {w.branch && w.status !== 'merged' && w.status !== 'discarded' && <span>分支 <code>{w.branch}</code></span>}
      </div>

      {w.understanding && w.status !== 'merged' && w.status !== 'discarded' && <p className="understanding">{w.understanding}</p>}
      {w.error && (w.status === 'failed' || w.status === 'stopped' || w.status === 'plan_failed') && <p className="banner banner-bad">{w.error}</p>}

      {w.status === 'planning' && (
        <>
          <p className="working-line"><span className="spinner" aria-hidden="true" />规划员正在读你的项目、拆任务…</p>
          <div className="actions">{btn('stop', '停止')}</div>
        </>
      )}

      {w.status === 'awaiting_confirm' && <ConfirmTasks wish={w} busyOther={busyOther} run={run} pending={pending} />}

      {(w.status === 'running' || w.status === 'failed' || w.status === 'stopped' || w.status === 'awaiting_review') && <TaskList wish={w} />}

      {w.status === 'running' && <div className="actions">{btn('stop', '停止')}</div>}

      {(w.status === 'failed' || w.status === 'stopped') && (
        <div className="actions">
          {btn('retry', '重试', 'primary')}
          {w.status === 'failed' && btn('skip', '跳过这个任务')}
          {btn('discard', '打回（丢弃改动）', 'danger')}
          {busyOther && <span className="small muted">另一个愿望正在进行，等它完成后才能重试。</span>}
        </div>
      )}

      {w.status === 'awaiting_review' && (
        <>
          <Review wish={w} />
          <div className="actions">
            {btn('approve', '通过，合并到我的项目', 'primary')}
            {btn('discard', '打回（丢弃改动）', 'danger')}
          </div>
        </>
      )}

      {w.status === 'merged' && <p className="small">已合并到你的项目。{btn('remove', '从列表移除', 'link')}</p>}
      {w.status === 'discarded' && <p className="small muted">改动已丢弃，你的项目没有变化。{btn('remove', '从列表移除', 'link')}</p>}
      {w.status === 'plan_failed' && <div className="actions">{btn('remove', '从列表移除')}</div>}

      {error && <p className="error-text">{error}</p>}
    </article>
  );
}

const FIELDS: { key: keyof PlannedTask; label: string }[] = [
  { key: 'goal', label: '目标' },
  { key: 'deliverable', label: '产出' },
  { key: 'boundaries', label: '不要碰' },
  { key: 'acceptance', label: '怎样算做完' },
];

function ConfirmTasks(props: { wish: Wish; busyOther?: Wish; pending?: string; run: (action: string, body?: unknown) => Promise<void> }) {
  const { wish: w, busyOther, pending, run } = props;
  const [tasks, setTasks] = useState<PlannedTask[]>(() => w.tasks.map(({ title, goal, deliverable, boundaries, acceptance }) => ({ title, goal, deliverable, boundaries, acceptance })));
  const update = (i: number, patch: Partial<PlannedTask>) => setTasks((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  return (
    <>
      <p className="small muted">规划员拆出了 {tasks.length} 个任务，会按顺序一个个做。可以直接改，或删掉不要的。</p>
      <ol className="plan">
        {tasks.map((t, i) => (
          <li key={i} className="plan-item">
            <div className="plan-row">
              <input id={`plan-${w.id}-${i}-title`} aria-label="任务标题" value={t.title} onChange={(e) => update(i, { title: e.target.value })} />
              {tasks.length > 1 && (
                <button type="button" className="link" onClick={() => setTasks((ts) => ts.filter((_, j) => j !== i))}>
                  删除
                </button>
              )}
            </div>
            <details>
              <summary className="small muted">详细要求</summary>
              <div className="plan-fields">
                {FIELDS.map((f) => (
                  <label key={f.key} className="small">
                    <span className="muted">{f.label}</span>
                    <textarea id={`plan-${w.id}-${i}-${f.key}`} rows={2} value={t[f.key]} onChange={(e) => update(i, { [f.key]: e.target.value })} />
                  </label>
                ))}
              </div>
            </details>
          </li>
        ))}
      </ol>
      <div className="actions">
        <button type="button" className="primary" disabled={!!pending || !!busyOther} onClick={() => void run('start', { tasks })}>
          {pending === 'start' ? '启动中…' : '开始'}
        </button>
        <button type="button" className="danger" disabled={!!pending} onClick={() => void run('discard')}>
          不要了
        </button>
        {busyOther && <span className="small muted">另一个愿望正在进行，等它完成后才能开始。</span>}
      </div>
    </>
  );
}

function TaskList({ wish: w }: { wish: Wish }) {
  return (
    <ol className="tasks">
      {w.tasks.map((t) => (
        <TaskRow key={t.id} task={t} />
      ))}
    </ol>
  );
}

function TaskRow({ task: t }: { task: WishTask }) {
  const live = t.status === 'running';
  const last = t.activity[t.activity.length - 1];
  return (
    <li className={`task task-${t.status}`}>
      <div className="task-head">
        <span className={`dot dot-${t.status}`} aria-hidden="true" />
        <span className="task-title">{t.title}</span>
        <span className="small muted">{TASK_STATUS[t.status]}</span>
      </div>
      {live && last && (
        <p className="working-line small">
          <span className="spinner" aria-hidden="true" />
          {last.text}
        </p>
      )}
      {t.status === 'failed' && t.error && <p className="small error-text">{t.error}</p>}
      {t.denials > 0 && <p className="small muted">有 {t.denials} 个操作被安全规则拦下了。</p>}
      {t.activity.length > 0 && <ActivityLog task={t} open={live} />}
    </li>
  );
}

function ActivityLog({ task: t, open }: { task: WishTask; open: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [open, t.activity.length]);
  return (
    <details className="log" open={open}>
      <summary className="small muted">过程记录（{t.activity.length} 条）</summary>
      <div className="log-body" ref={ref}>
        {t.activity.map((a, i) => (
          <div key={i} className={`log-line log-${a.kind}`}>
            <time className="muted">{new Date(a.at).toLocaleTimeString()}</time>
            <span>{a.text}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function Review({ wish: w }: { wish: Wish }) {
  const summaries = w.tasks.filter((t) => t.resultText);
  return (
    <div className="review">
      {summaries.length > 0 && (
        <>
          <h3>agent 说它做了这些</h3>
          {summaries.map((t) => (
            <div key={t.id} className="result">
              <div className="small muted">{t.title}</div>
              <p>{t.resultText}</p>
            </div>
          ))}
        </>
      )}
      <h3>改动了哪些文件</h3>
      {w.diffStat ? <pre className="stat-block">{w.diffStat}</pre> : <p className="muted small">没有改动任何文件。</p>}
      {w.diff && (
        <details className="diff">
          <summary className="small">查看全部改动</summary>
          <pre>
            {w.diff.split('\n').map((line, i) => (
              <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>
                {line}
                {'\n'}
              </span>
            ))}
          </pre>
        </details>
      )}
    </div>
  );
}
