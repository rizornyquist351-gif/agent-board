import { useEffect, useMemo, useState } from 'react';
import type { Agent, BoardState, Task } from '../src/shared/types.ts';
import { groupByColumn, shortId, timeAgo } from './board.ts';
import { useBoard, type Connection } from './useBoard.ts';

const ALL = '__all__';
const LIST_KEY = 'agent-board:list';

function loadList(): string | undefined {
  try {
    return localStorage.getItem(LIST_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveList(id: string) {
  try {
    localStorage.setItem(LIST_KEY, id);
  } catch {
    /* 隐私模式等情况下忽略 */
  }
}

export function App() {
  const { state, connection } = useBoard();
  const [picked, setPicked] = useState<string | undefined>(loadList);
  const [, tick] = useState(0);

  // 每 30 秒刷新一次"几分钟前"
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // 记住的列表不存在了，就退回到最近更新的那个
  const listId = useMemo(() => {
    if (!state) return ALL;
    if (picked === ALL || (picked && state.lists.some((l) => l.id === picked))) return picked;
    return state.lists[0]?.id ?? ALL;
  }, [state, picked]);

  const choose = (id: string) => {
    setPicked(id);
    saveList(id);
  };

  if (!state) return <Shell connection={connection}><p className="muted center">正在连接看板服务器…</p></Shell>;

  const tasks = listId === ALL ? state.tasks : state.tasks.filter((t) => t.listId === listId);
  const agents = listId === ALL ? state.agents : state.agents.filter((a) => a.listId === listId);

  return (
    <Shell connection={connection} state={state} listId={listId} onChoose={choose}>
      {state.lists.length === 0 ? (
        <EmptyState claudeDir={state.claudeDir} />
      ) : (
        <>
          <Summary tasks={tasks} agents={agents} />
          <AgentPanel agents={agents} tasks={tasks} showList={listId === ALL} />
          <Board tasks={tasks} showList={listId === ALL} />
        </>
      )}
      {state.warnings.length > 0 && (
        <details className="warnings">
          <summary>读取时有 {state.warnings.length} 个问题（不影响其他数据）</summary>
          <ul>{state.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </details>
      )}
    </Shell>
  );
}

function Shell(props: {
  connection: Connection;
  state?: BoardState;
  listId?: string;
  onChoose?: (id: string) => void;
  children: React.ReactNode;
}) {
  const { connection, state, listId, onChoose } = props;
  const label = { connecting: '连接中', live: '实时', reconnecting: '重连中' }[connection];
  return (
    <div className="app">
      <header className="top">
        <h1>agent-board</h1>
        {state && state.lists.length > 0 && onChoose && (
          <label className="picker">
            <span className="muted">任务列表</span>
            <select value={listId} onChange={(e) => onChoose(e.target.value)}>
              {state.lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.kind === 'team' ? '团队' : '会话'} {shortId(l.id)} · {l.taskCount} 个任务 · {timeAgo(l.updatedAt)}
                </option>
              ))}
              <option value={ALL}>全部（{state.lists.length} 个列表）</option>
            </select>
          </label>
        )}
        <span className={`conn conn-${connection}`} title="与看板服务器的连接状态">
          <i /> {label}
        </span>
      </header>
      <main>{props.children}</main>
    </div>
  );
}

function Summary({ tasks, agents }: { tasks: Task[]; agents: Agent[] }) {
  const done = tasks.filter((t) => t.status === 'completed').length;
  const doing = tasks.filter((t) => t.status === 'in_progress').length;
  const blocked = tasks.filter((t) => t.blocked).length;
  const working = agents.filter((a) => a.status === 'working').length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  return (
    <section className="summary">
      <div className="progress">
        <div className="progress-label">
          <strong>{pct}%</strong>
          <span className="muted">完成 {done} / {tasks.length}</span>
        </div>
        <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${pct}%` }} />
        </div>
      </div>
      <Stat label="进行中" value={doing} />
      <Stat label="阻塞" value={blocked} warn={blocked > 0} />
      <Stat label="工作中的 agent" value={`${working} / ${agents.length}`} />
    </section>
  );
}

function Stat({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className={`stat${warn ? ' warn' : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="muted">{label}</div>
    </div>
  );
}

function AgentPanel({ agents, tasks, showList }: { agents: Agent[]; tasks: Task[]; showList: boolean }) {
  if (agents.length === 0) return null;
  const sorted = [...agents].sort((a, b) => Number(b.status === 'working') - Number(a.status === 'working') || a.name.localeCompare(b.name));
  return (
    <section>
      <h2>Agent</h2>
      <div className="agents">
        {sorted.map((a) => {
          const current = a.currentTaskIds.map((id) => tasks.find((t) => t.listId === a.listId && t.id === id)).filter((t): t is Task => !!t);
          return (
            <article key={`${a.listId}/${a.name}`} className={`agent agent-${a.status}`}>
              <div className="agent-head">
                <strong>{a.name}</strong>
                <span className={`badge badge-${a.status}`}>{a.status === 'working' ? '工作中' : '空闲'}</span>
              </div>
              <div className="muted small">
                {a.agentType === 'team-lead' ? '组长' : a.agentType ?? (a.source === 'owner' ? '任务认领人' : '队友')}
                {showList && ` · ${shortId(a.listId)}`}
              </div>
              <div className="agent-task">
                {current.length > 0 ? current.map((t) => <div key={t.id}>#{t.id} {t.activeForm ?? t.subject}</div>) : <span className="muted">没有进行中的任务</span>}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Board({ tasks, showList }: { tasks: Task[]; showList: boolean }) {
  const { columns, byColumn } = groupByColumn(tasks);
  return (
    <section>
      <h2>任务</h2>
      <div className="board">
        {columns.map((c) => {
          const items = byColumn.get(c.id)!;
          return (
            <div key={c.id} className={`column col-${c.id}`}>
              <div className="column-head" title={c.hint}>
                <span>{c.title}</span>
                <span className="count">{items.length}</span>
              </div>
              {items.length === 0 ? <div className="muted small empty">—</div> : items.map((t) => <Card key={`${t.listId}/${t.id}`} task={t} showList={showList} />)}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Card({ task: t, showList }: { task: Task; showList: boolean }) {
  return (
    <details className="card">
      <summary>
        <div className="card-title">
          <span className="muted">#{t.id}</span> {t.subject}
        </div>
        {t.status === 'in_progress' && t.activeForm && <div className="small active">{t.activeForm}…</div>}
        <div className="card-meta small">
          {t.owner && <span className="chip">{t.owner}</span>}
          {t.blocked && <span className="chip chip-warn">等待 {t.blockedBy.map((id) => `#${id}`).join(' ')}</span>}
          {showList && <span className="muted">{shortId(t.listId)}</span>}
          <span className="muted">{timeAgo(t.updatedAt)}</span>
        </div>
      </summary>
      <div className="card-body small">
        {t.description ? <p>{t.description}</p> : <p className="muted">（没有描述）</p>}
        {t.blocks.length > 0 && <p className="muted">完成后解锁：{t.blocks.map((id) => `#${id}`).join(' ')}</p>}
        {Object.keys(t.metadata).length > 0 && <pre>{JSON.stringify(t.metadata, null, 2)}</pre>}
      </div>
    </details>
  );
}

function EmptyState({ claudeDir }: { claudeDir: string }) {
  return (
    <section className="empty-state">
      <h2>还没有任务</h2>
      <p>
        看板读取的是 <code>{claudeDir}/tasks/</code>。在 Claude Code 里让它用任务列表工作（例如开启 Agent Teams，或者让 Claude
        把工作拆成任务），任务就会出现在这里。
      </p>
    </section>
  );
}
