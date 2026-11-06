import { useEffect, useState } from 'react';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { subscribeClientReset } from '@/sync/client-reset';

/** Workflow detail paints the current full draft delivered by its Room subscription. */
export function useRoomLiveDrafts(roomId: string | undefined): ReadonlyMap<string, string> {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    setDrafts(new Map());
    if (!roomId) return;
    const connection = sharedLiveConnection();
    const stopReset = subscribeClientReset(() => setDrafts(new Map()));
    let active = true;
    let stop: (() => void) | undefined;
    void connection
      .register([{ '#h': [roomId] }], (event) => {
        if (!active || !('monolithLive' in event)) return;
        const live = event.monolithLive;
        if (!('roomId' in live) || live.roomId !== roomId) return;
        if (live.type === 'subscribed') setDrafts(new Map());
        else if (live.type === 'draft' || live.type === 'retract' || live.type === 'turn-delta') {
          setDrafts((current) => {
            const next = new Map(current);
            if (live.type === 'draft')
              next.set(`${live.agentId}:${live.turnId}`, live.latestChunk ?? live.text);
            else if (live.type === 'retract') next.delete(`${live.agentId}:${live.turnId}`);
            else if (live.type === 'turn-delta' && live.turn.status !== 'working')
              next.delete(`${live.turn.agentPubkey}:${live.turn.requestId}`);
            return next;
          });
        }
      })
      .then((unregister) => {
        if (active) stop = unregister;
        else unregister();
      });
    return () => {
      active = false;
      stop?.();
      stopReset();
    };
  }, [roomId]);
  return drafts;
}
