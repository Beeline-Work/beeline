import { AppState } from 'react-native';
import type { NostrEvent } from '@beeline/nostr';
import type { AgentMessageWriteResult } from '@beeline/api-contract/phone';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { monolithSession } from '@/auth/monolith-session';
import { BuzzRigTransport } from '@/sync/transport';
import { createRoomOutbox, pendingOutboxRoomIds } from './surface-storage';

type Publisher = Pick<BuzzRigTransport, 'publishPreparedMessage'>;

const inFlight = new Map<string, Promise<AgentMessageWriteResult>>();

/** One request per prepared event at a time, whichever path asks for it. */
export function publishOutboxEvent(
  transport: Publisher,
  event: NostrEvent,
): Promise<AgentMessageWriteResult> {
  const current = inFlight.get(event.id);
  if (current) return current;
  const request = transport.publishPreparedMessage(event).finally(() => {
    inFlight.delete(event.id);
  });
  inFlight.set(event.id, request);
  return request;
}

/**
 * Send every pending Room message for this viewer, whether or not its Room is
 * open. A stored send no longer waits for its Room screen to mount. The server
 * ignores a repeated messageId, so a send that already landed is harmless. A
 * failure stays pending for the next foreground or reconnect.
 */
async function flushPendingOutboxes(
  identity: { publicKey: string },
  transport: Publisher,
): Promise<void> {
  for (const roomId of pendingOutboxRoomIds(identity.publicKey)) {
    const outbox = createRoomOutbox(identity, roomId);
    await outbox.restore();
    for (const record of outbox.list().filter((record) => record.status === 'pending')) {
      try {
        await publishOutboxEvent(transport, record.event);
        await outbox.remove(record.event.id);
      } catch (error) {
        console.warn('[outbox] pending send failed; will retry', error);
      }
    }
  }
}

/** Drive pending sends on launch, sign-in, foreground and live reconnect. */
export function startOutboxDelivery(): () => void {
  let disposed = false;
  let flushing = false;
  let again = false;
  let stopConnected: (() => void) | undefined;

  const flush = async () => {
    if (flushing) {
      again = true;
      return;
    }
    flushing = true;
    try {
      do {
        again = false;
        const identity = await loadBuzzIdentity();
        if (!identity || disposed) return;
        const transport = new BuzzRigTransport(identity);
        if (!stopConnected) stopConnected = transport.subscribeConnected(() => void flush());
        await flushPendingOutboxes(identity, transport);
      } while (again && !disposed);
    } finally {
      flushing = false;
    }
  };
  const report = (error: unknown) => console.warn('[outbox]', error);

  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') void flush().catch(report);
  });
  const stopIdentity = monolithSession.subscribeIdentityChange(() => void flush().catch(report));
  void flush().catch(report);
  return () => {
    disposed = true;
    appState.remove();
    stopIdentity();
    stopConnected?.();
  };
}
