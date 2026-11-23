import { useState } from 'react';
import { ObserveView } from './ObserveView.tsx';
import { useBoard, type Connection } from './useBoard.ts';
import { WishView } from './WishView.tsx';

type Tab = 'wish' | 'observe';

export function App() {
  const { state, wishes, connection } = useBoard();
  const [tab, setTab] = useState<Tab>('wish');
  const needYou = wishes?.wishes.filter((w) => ['awaiting_confirm', 'awaiting_review', 'failed', 'stopped'].includes(w.status)).length ?? 0;

  return (
    <div className="app">
      <header className="top">
        <h1>agent-board</h1>
        {wishes && !wishes.project.problem && (
          <span className="project small">
            {wishes.project.name}
            {wishes.project.branch && <code>{wishes.project.branch}</code>}
          </span>
        )}
        {wishes?.fake && <span className="pill pill-action small" title="agent 是假的，不调用 Claude、不花钱">演示模式</span>}
        <ConnectionDot connection={connection} />
      </header>
      <nav className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'wish'} className={tab === 'wish' ? 'active' : ''} onClick={() => setTab('wish')}>
          许愿{needYou > 0 && <span className="tab-badge">{needYou}</span>}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'observe'} className={tab === 'observe' ? 'active' : ''} onClick={() => setTab('observe')}>
          Claude Code 任务
        </button>
      </nav>
      <main>{tab === 'wish' ? <WishView data={wishes} /> : <ObserveView state={state} />}</main>
    </div>
  );
}

function ConnectionDot({ connection }: { connection: Connection }) {
  const label = { connecting: '连接中', live: '实时', reconnecting: '重连中' }[connection];
  return (
    <span className={`conn conn-${connection}`} title="与看板服务器的连接状态">
      <i /> {label}
    </span>
  );
}
