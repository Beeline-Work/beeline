import { useEffect, useState } from 'react';
import type { RoomView } from '@beeline/api-contract/phone';

type ParentReader = { room(id: string): Promise<RoomView> };

/** Corner navigation needs no parent transcript until the second pane opens. */
export function useDesktopParentRoom(
  needed: boolean,
  parentId: string | undefined,
  client: ParentReader | null,
): RoomView | null {
  const [answer, setAnswer] = useState<{ id: string; room: RoomView } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!needed || !parentId || !client) {
      setAnswer(null);
      return;
    }
    void client.room(parentId).then(room => {
      if (!cancelled) setAnswer({ id: parentId, room });
    }).catch(() => { if (!cancelled) setAnswer(null); });
    return () => { cancelled = true; };
  }, [needed, parentId, client]);
  return needed && answer && answer.id === parentId ? answer.room : null;
}
