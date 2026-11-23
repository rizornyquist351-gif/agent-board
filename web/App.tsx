import { useState } from 'react';
import { ObserveView } from './ObserveView.tsx';
import { HealthPanel, ProjectSwitcher, useReminders } from './Setup.tsx';
import { useBoard, type Connection } from './useBoard.ts';
import { WishView } from './WishView.tsx';

type Tab = 'wish' | 'observe';

export function App() {
  const { state, wishes, connection } = useBoard();
  const [tab, setTab] = useState<Tab>('wish');
  const [switching, setSwitching] = useState(false);
  const { count, notify, toggle, supported } = useReminders(wishes?.wishes);
  const project = wishes?.project;

  return (
    <div className="app">
      <header className="top">
        <h1>agent-board</h1>
        {project && project.path && (
          <button type="button" className="project small" title={`${project.path}\n点击切换项目`} onClick={() => setSwitching((v) => !v)}>
            {project.name}
            {project.branch && <code>{project.branch}</code>}
            <span className="muted">切换 ▾</span>
          </button>
        )}
        {wishes?.fake && (
          <span className="pill pill-action small" title="agent 是假的，不调用 Claude、不花钱">
            演示模式
          </span>
        )}
        <span className="top-right">
          {supported && (
            <button type="button" className="link small" onClick={() => void toggle()} title="页面不在前台时，有事需要你处理就弹出桌面通知">
              {notify ? '🔔 桌面提醒已开' : '🔕 开启桌面提醒'}
            </button>
          )}
          <ConnectionDot connection={connection} />
        </span>
      </header>
      {switching && wishes && <ProjectSwitcher current={wishes.project.path} recent={wishes.recent} onClose={() => setSwitching(false)} />}
      {wishes && <HealthPanel checks={wishes.health} />}
      {wishes?.permissionMode === 'acceptEdits' && (
        <p className="small muted mode-note">
          当前是"自动允许改文件"模式：agent 可以自由改文件，但部分命令可能被安全规则拦下。你的 Claude Code 不支持全自动模式，升级后可获得更好的效果。
        </p>
      )}
      <nav className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'wish'} className={tab === 'wish' ? 'active' : ''} onClick={() => setTab('wish')}>
          许愿{count > 0 && <span className="tab-badge">{count}</span>}
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
