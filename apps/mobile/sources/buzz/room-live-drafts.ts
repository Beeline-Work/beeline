import { useEffect, useMemo, useState } from 'react';
import { sharedLiveConnection } from '@/sync/transport/live-connection';

/**
 * Each agent's streaming reply in one Room, by agent id, from the shared live
 * socket. A draft is cumulative, so the newest text replaces the last; it ends
 * on its retract or when its turn stops working. Thoughts are private and are
 * never read here.
 */
export function useRoomLiveDrafts(roomId: string | undefined): ReadonlyMap<string, string> {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, { turnId: string; text: string }>>(
    () => new Map(),
  );
  useEffect(() => {
    setDrafts(new Map());
    if (!roomId) return;
    let active = true;
    let stop: (() => void) | undefined;
    const end = (agentId: string, turnId: string) =>
      setDrafts((current) => {
        if (current.get(agentId)?.turnId !== turnId) return current;
        const next = new Map(current);
        next.delete(agentId);
        return next;
      });
    void sharedLiveConnection()
      .register([{ '#h': [roomId] }], (event) => {
        if (!active || !('monolithLive' in event)) return;
        const live = event.monolithLive;
        if (!('roomId' in live) || live.roomId !== roomId) return;
        if (live.type === 'draft')
          setDrafts((current) =>
            new Map(current).set(live.agentId, { turnId: live.turnId, text: live.text }),
          );
        else if (live.type === 'retract' && live.kind === 'draft') end(live.agentId, live.turnId);
        else if (live.type === 'turn-delta' && live.turn.status !== 'working')
          end(live.turn.agentPubkey, live.turn.requestId);
      })
      .then((unregister) => {
        if (active) stop = unregister;
        else unregister();
      });
    return () => {
      active = false;
      stop?.();
    };
  }, [roomId]);
  return useMemo(() => {
    const texts = new Map<string, string>();
    for (const [agentId, draft] of drafts) if (draft.text.trim()) texts.set(agentId, draft.text);
    return texts;
  }, [drafts]);
}
