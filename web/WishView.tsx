// 许愿视图。用户只需要：写一句话 → 点"开始" → 看 → 点"通过"或"打回"。
import { useEffect, useRef, useState } from 'react';
import type { PlannedTask, RunningAgent, TaskRole, Wish, WishTask } from '../src/shared/wish.ts';
import { timeAgo } from './board.ts';
import { ProjectSwitcher } from './Setup.tsx';
import { post, type WishesPayload } from './useBoard.ts';
import { ROLE, TASK_STATUS, WISH_STATUS, doneCount, groupWishes, money, waitingFor } from './wishText.ts';

export function WishView({ data }: { data: WishesPayload | undefined }) {
  if (!data) return <p className="muted center">正在连接看板服务器…</p>;
  if (data.project.problem) {
    return (
      <section className="notice notice-bad">
        <h2>这个项目暂时不能许愿</h2>
        <p>{data.project.problem}</p>
        {data.project.path && <p className="muted small">项目目录：{data.project.path}</p>}
        <h3 className="small">换一个项目</h3>
        <ProjectSwitcher current={data.project.path} recent={data.recent} />
      </section>
    );
  }
  const groups = groupWishes(data.wishes);
  return (
    <>
      <WishInput projectName={data.project.name} />
      {(data.agents.length > 0 || groups.busy.length > 0) && <AgentPanel agents={data.agents} max={data.maxAgents} />}
      {groups.action.length > 0 && (
        <section>
          <h2 className="h-action">需要你处理 · {groups.action.length}</h2>
          <div className="wishes">{groups.action.map((w) => <WishCard key={w.id} wish={w} />)}</div>
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
      {data.wishes.length === 0 && <Guide />}
    </>
  );
}

function Guide() {
  return (
    <section className="notice">
      <h2>怎么用</h2>
      <ol className="steps">
        <li>在上面写一句你想做的事，点"许愿"。</li>
        <li>规划员会读你的项目，把愿望拆成几个小任务，分给调研员和开发者。你看一眼，点"开始"。</li>
        <li>没有先后关系的任务会同时开工，每个 agent 在自己的独立分支里干活。上面的面板实时显示谁在做什么。</li>
        <li>做完后看看报告和改动，满意就"通过"（合并到你的项目），不满意就"打回"（丢弃）。点"通过"之前，你的项目不会有任何变化。</li>
      </ol>
    </section>
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

function AgentPanel({ agents, max }: { agents: RunningAgent[]; max: number }) {
  const idle = Math.max(0, max - agents.length);
  return (
    <section>
      <h2>
        谁在干活 · {agents.length} / {max}
      </h2>
      <div className="crew">
        {agents.map((a) => (
          <article key={`${a.wishId}:${a.taskId}`} className={`crew-card crew-${a.role}`}>
            <div className="crew-head">
              <span className={`avatar avatar-${a.role}`} aria-hidden="true">
                {a.role === 'research' ? '调' : '开'}
              </span>
              <strong>{a.name}</strong>
              <span className="small muted">{timeAgo(a.since)}开工</span>
            </div>
            <div className="crew-task">{a.taskTitle}</div>
            <div className="small muted crew-wish">愿望：{a.wishText}</div>
            {a.doing && (
              <p className="working-line small">
                <span className="spinner" aria-hidden="true" />
                {a.doing}
              </p>
            )}
          </article>
        ))}
        {idle > 0 && (
          <div className="crew-idle small muted">
            {agents.length === 0 ? `${max} 个名额都空着，正在等任务。` : `还有 ${idle} 个名额空着，等有能开工的任务就派出去。`}
          </div>
        )}
      </div>
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

function WishCard({ wish: w }: { wish: Wish }) {
  const s = WISH_STATUS[w.status];
  const { pending, error, run } = useAction(w.id);
  const btn = (action: string, label: string, kind = '', body?: unknown) => (
    <button type="button" className={kind} disabled={!!pending} onClick={() => void run(action, body)}>
      {pending === action ? '处理中…' : label}
    </button>
  );
  const active = w.tasks.filter((t) => t.status === 'running').length;
  const failedCount = w.tasks.filter((t) => t.status === 'failed').length;

  return (
    <article className={`wish tone-${s.tone}`}>
      <header className="wish-head">
        <div className="wish-title">{w.text}</div>
        <span className={`pill pill-${s.tone}`}>{s.label}</span>
      </header>
      <div className="wish-meta small muted">
        <span>{timeAgo(w.createdAt)}许愿</span>
        {w.tasks.length > 0 && (
          <span>
            任务 {doneCount(w)} / {w.tasks.length}
          </span>
        )}
        {active > 0 && <span>{active} 个 agent 在干活</span>}
        <span>花费 {money(w.costUsd)}</span>
        {w.branch && w.status !== 'merged' && w.status !== 'discarded' && (
          <span>
            分支 <code>{w.branch}</code>
          </span>
        )}
      </div>

      {w.understanding && w.status !== 'merged' && w.status !== 'discarded' && <p className="understanding">{w.understanding}</p>}
      {w.error && (w.status === 'failed' || w.status === 'stopped' || w.status === 'plan_failed') && <p className="banner banner-bad">{w.error}</p>}

      {w.status === 'planning' && (
        <>
          <p className="working-line">
            <span className="spinner" aria-hidden="true" />
            规划员正在读你的项目、拆任务…
          </p>
          <div className="actions">{btn('stop', '停止')}</div>
        </>
      )}

      {w.status === 'awaiting_confirm' && <ConfirmTasks wish={w} run={run} pending={pending} />}

      {(w.status === 'running' || w.status === 'failed' || w.status === 'stopped' || w.status === 'awaiting_review') && <TaskList wish={w} />}

      {w.status === 'running' && <div className="actions">{btn('stop', '全部停止')}</div>}

      {(w.status === 'failed' || w.status === 'stopped') && (
        <div className="actions">
          {btn('retry', failedCount > 1 ? '重试没完成的任务' : '重试', 'primary')}
          {w.status === 'failed' && btn('skip', failedCount > 1 ? '跳过这些任务' : '跳过这个任务')}
          {btn('discard', '打回（丢弃改动）', 'danger')}
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

const FIELDS: { key: 'goal' | 'deliverable' | 'boundaries' | 'acceptance'; label: string }[] = [
  { key: 'goal', label: '目标' },
  { key: 'deliverable', label: '产出' },
  { key: 'boundaries', label: '不要碰' },
  { key: 'acceptance', label: '怎样算做完' },
];

function ConfirmTasks(props: { wish: Wish; pending?: string; run: (action: string, body?: unknown) => Promise<void> }) {
  const { wish: w, pending, run } = props;
  const [tasks, setTasks] = useState<PlannedTask[]>(() =>
    w.tasks.map(({ id, role, dependsOn, title, goal, deliverable, boundaries, acceptance }) => ({ id, role, dependsOn, title, goal, deliverable, boundaries, acceptance })),
  );
  const update = (i: number, patch: Partial<PlannedTask>) => setTasks((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const remove = (i: number) =>
    setTasks((ts) => {
      const gone = ts[i].id;
      return ts.filter((_, j) => j !== i).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== gone) }));
    });
  const numberOf = (id: string) => tasks.findIndex((t) => t.id === id) + 1;
  const parallel = tasks.filter((t) => t.dependsOn.length === 0).length;

  return (
    <>
      <p className="small muted">
        规划员拆出了 {tasks.length} 个任务，{parallel > 1 ? `其中 ${parallel} 个会同时开工，` : ''}其余的等它依赖的任务做完再开始。可以直接改，点角色可以切换。
      </p>
      <ol className="plan">
        {tasks.map((t, i) => (
          <li key={t.id ?? i} className="plan-item">
            <div className="plan-row">
              <RoleChip role={t.role} onClick={() => update(i, { role: t.role === 'research' ? 'develop' : 'research' })} />
              <input id={`plan-${w.id}-${t.id}-title`} aria-label="任务标题" value={t.title} onChange={(e) => update(i, { title: e.target.value })} />
              {tasks.length > 1 && (
                <button type="button" className="link" onClick={() => remove(i)}>
                  删除
                </button>
              )}
            </div>
            <div className="small muted plan-deps">{t.dependsOn.length ? `等 ${t.dependsOn.map((d) => `#${numberOf(d)}`).join('、')} 做完再开始` : '一开始就开工'}</div>
            <details>
              <summary className="small muted">详细要求</summary>
              <div className="plan-fields">
                {FIELDS.map((f) => (
                  <label key={f.key} className="small">
                    <span className="muted">{f.label}</span>
                    <textarea id={`plan-${w.id}-${t.id}-${f.key}`} rows={2} value={t[f.key]} onChange={(e) => update(i, { [f.key]: e.target.value })} />
                  </label>
                ))}
              </div>
            </details>
          </li>
        ))}
      </ol>
      <div className="actions">
        <button type="button" className="primary" disabled={!!pending} onClick={() => void run('start', { tasks })}>
          {pending === 'start' ? '启动中…' : '开始'}
        </button>
        <button type="button" className="danger" disabled={!!pending} onClick={() => void run('discard')}>
          不要了
        </button>
      </div>
    </>
  );
}

function RoleChip({ role, onClick }: { role: TaskRole; onClick?: () => void }) {
  const label = ROLE[role];
  if (!onClick) return <span className={`role role-${role}`}>{label}</span>;
  return (
    <button type="button" className={`role role-${role}`} title="点击切换：调研（只读、可上网、出报告）/ 开发（改代码）" onClick={onClick}>
      {label}
    </button>
  );
}

function TaskList({ wish: w }: { wish: Wish }) {
  return (
    <ol className="tasks">
      {w.tasks.map((t, i) => (
        <TaskRow key={t.id} wish={w} task={t} n={i + 1} />
      ))}
    </ol>
  );
}

function TaskRow({ wish: w, task: t, n }: { wish: Wish; task: WishTask; n: number }) {
  const live = t.status === 'running';
  const last = t.activity[t.activity.length - 1];
  const waiting = t.status === 'todo' ? waitingFor(w, t) : '';
  return (
    <li className={`task task-${t.status}`}>
      <div className="task-head">
        <span className={`dot dot-${t.status}`} aria-hidden="true" />
        <span className="muted small">#{n}</span>
        <RoleChip role={t.role} />
        <span className="task-title">{t.title}</span>
        <span className="small muted task-state">{live && t.agent ? `${t.agent} 正在做` : TASK_STATUS[t.status]}</span>
      </div>
      {waiting && <p className="small muted task-note">{waiting}</p>}
      {live && last && (
        <p className="working-line small">
          <span className="spinner" aria-hidden="true" />
          {last.text}
        </p>
      )}
      {t.status === 'failed' && t.error && <p className="small error-text">{t.error}</p>}
      {t.attempts > 1 && t.status !== 'failed' && <p className="small muted task-note">和同事的改动冲突过，已基于最新代码重做。</p>}
      {t.denials > 0 && <p className="small muted task-note">有 {t.denials} 个操作被安全规则拦下了。</p>}
      {t.status === 'done' && t.role === 'research' && t.resultText && (
        <details className="report">
          <summary className="small">看调研报告</summary>
          <div className="report-body">{t.resultText}</div>
        </details>
      )}
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
  const finished = w.tasks.filter((t) => t.status === 'done' || t.status === 'skipped');
  return (
    <div className="review">
      <h3>每个任务做了什么</h3>
      {finished.map((t) => (
        <div key={t.id} className={`result result-${t.status === 'skipped' ? 'skipped' : t.role}`}>
          <div className="small muted">
            <RoleChip role={t.role} /> {t.title}
            {t.status === 'skipped' && '（已跳过）'}
          </div>
          {t.role === 'research' && t.resultText ? (
            <details>
              <summary className="small">看调研报告</summary>
              <div className="report-body">{t.resultText}</div>
            </details>
          ) : (
            t.resultText && <p>{t.resultText}</p>
          )}
          {t.diffStat && <pre className="stat-block small">{t.diffStat}</pre>}
        </div>
      ))}
      <h3>合起来改动了哪些文件</h3>
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
