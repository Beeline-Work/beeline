import { useEffect, useState } from 'react';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { subscribeClientReset } from '@/sync/client-reset';

/** Workflow detail selects live text from the socket's one draft cache. */
export function useRoomLiveDrafts(roomId: string | undefined): ReadonlyMap<string, string> {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    setDrafts(new Map());
    if (!roomId) return;
    const connection = sharedLiveConnection();
    const stopReset = subscribeClientReset(() => setDrafts(new Map()));
    let active = true;
    let stop: (() => void) | undefined;
    void connection.register([{ '#h': [roomId] }], (event) => {
      if (!active || !('monolithLive' in event)) return;
      const live = event.monolithLive;
      if ('roomId' in live && live.roomId === roomId &&
          (live.type === 'subscribed' || live.type === 'draft' ||
           live.type === 'retract' || live.type === 'turn-delta'))
        setDrafts(connection.liveDrafts(roomId));
    }).then((unregister) => {
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
