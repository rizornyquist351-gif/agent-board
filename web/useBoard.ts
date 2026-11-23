import { useEffect, useState } from 'react';
import type { BoardState } from '../src/shared/types.ts';
import type { ProjectInfo, Wish } from '../src/shared/wish.ts';

export type Connection = 'connecting' | 'live' | 'reconnecting';

export interface WishesPayload {
  project: ProjectInfo;
  fake: boolean;
  wishes: Wish[];
}

/** 通过 SSE 订阅看板数据；断线后浏览器会自动重连（D10）。 */
export function useBoard(): { state: BoardState | undefined; wishes: WishesPayload | undefined; connection: Connection } {
  const [state, setState] = useState<BoardState>();
  const [wishes, setWishes] = useState<WishesPayload>();
  const [connection, setConnection] = useState<Connection>('connecting');

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('state', (e) => {
      setState(JSON.parse((e as MessageEvent<string>).data));
      setConnection('live');
    });
    es.addEventListener('wishes', (e) => {
      setWishes(JSON.parse((e as MessageEvent<string>).data));
      setConnection('live');
    });
    es.onerror = () => setConnection('reconnecting');
    return () => es.close();
  }, []);

  return { state, wishes, connection };
}

/** 调用写接口；失败时返回给用户看的错误信息。 */
export async function post(path: string, body: unknown = {}): Promise<string | undefined> {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) return undefined;
    const data = await res.json().catch(() => ({}));
    return data.error ?? `操作失败（${res.status}）`;
  } catch {
    return '连不上看板服务器，请确认它还在运行。';
  }
}
