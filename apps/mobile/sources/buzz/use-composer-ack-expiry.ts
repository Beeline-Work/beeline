import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { COMPOSER_ACK_BOUND_MS, EXTERNAL_SENT_VISIBLE_MS, type PendingComposerAck } from './room-indicators';

/** One deadline for the sending bridge or the accepted external-send acknowledgement. */
export function useComposerAckExpiry(
  pending: PendingComposerAck | null,
  setPending: Dispatch<SetStateAction<PendingComposerAck | null>>,
) {
  useEffect(() => {
    if (!pending) return;
    const external = Boolean(pending.externalHandles?.length);
    const lifetime = external ? EXTERNAL_SENT_VISIBLE_MS : COMPOSER_ACK_BOUND_MS;
    const delay = Math.max(external ? 0 : 1, pending.sentAt + lifetime - Date.now() + (external ? 0 : 1));
    const timer = setTimeout(() => setPending((current) => current === pending ? null : current), delay);
    return () => clearTimeout(timer);
  }, [pending, setPending]);
}
