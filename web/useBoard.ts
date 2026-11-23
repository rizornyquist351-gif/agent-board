import { useEffect, useState } from 'react';
import type { BoardState } from '../src/shared/types.ts';

export type Connection = 'connecting' | 'live' | 'reconnecting';

/** 通过 SSE 订阅看板数据；断线后浏览器会自动重连（D10）。 */
export function useBoard(): { state: BoardState | undefined; connection: Connection } {
  const [state, setState] = useState<BoardState>();
  const [connection, setConnection] = useState<Connection>('connecting');

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('state', (e) => {
      setState(JSON.parse((e as MessageEvent<string>).data));
      setConnection('live');
    });
    es.onerror = () => setConnection('reconnecting');
    return () => es.close();
  }, []);

  return { state, connection };
}
