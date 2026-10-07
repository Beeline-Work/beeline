import { AppState } from 'react-native';
import type { NostrEvent } from '@beeline/nostr';
import type { AgentMessageWriteResult } from '@beeline/api-contract/phone';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { monolithSession } from '@/auth/monolith-session';
import { BuzzRigTransport } from '@/sync/transport';
import { MonolithPhoneOperationError } from '@/sync/transport/monolith-operation';
import { createRoomOutbox, pendingOutboxRoomIds } from './surface-storage';

type Publisher = Pick<BuzzRigTransport, 'publishPreparedMessage'>;

const inFlight = new Map<string, Promise<AgentMessageWriteResult>>();
const deliveredListeners = new Set<() => void>();

/**
 * One request per prepared event at a time, whichever path asks for it. The
 * server has stored the message once it acks, so the stored send is retired
 * then and never sent again. An ack also proves the server is reachable, which
 * is the cue to send anything still pending.
 */
export function publishOutboxEvent(
  transport: Publisher,
  event: NostrEvent,
): Promise<AgentMessageWriteResult> {
  const current = inFlight.get(event.id);
  if (current) return current;
  const request = transport
    .publishPreparedMessage(event)
    .then(async (result) => {
      const roomId = event.tags.find((tag) => tag[0] === 'h')?.[1];
      if (roomId) await createRoomOutbox({ publicKey: event.pubkey }, roomId).remove(event.id);
      for (const listener of deliveredListeners) listener();
      return result;
    })
    .finally(() => {
      inFlight.delete(event.id);
    });
  inFlight.set(event.id, request);
  return request;
}

/** The server answered and said no; sending the same frame again cannot help. */
function refused(error: unknown): boolean {
  return (
    error instanceof MonolithPhoneOperationError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

/**
 * Send every pending Room message for this viewer, whether or not its Room is
 * open. A stored send no longer waits for its Room screen to mount. The server
 * ignores a repeated messageId, so a send that already landed is harmless. A
 * retryable failure stays pending for the next cue; a refusal is marked failed
 * for the Room to show.
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
      } catch (error) {
        if (refused(error)) {
          await outbox.fail(record.event.id);
        } else {
          console.warn('[outbox] pending send failed; will retry', error);
        }
      }
    }
  }
}

/**
 * Send pending messages on launch, sign-in, foreground, live reconnect, and
 * whenever another send is acked. Nothing retries on a timer: each attempt
 * follows an event that shows the server can be reached.
 */
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
  // The flush's own acks are not a new cue; it already covers every Room.
  const onDelivered = () => {
    if (!flushing) void flush().catch(report);
  };
  deliveredListeners.add(onDelivered);
  const stopIdentity = monolithSession.subscribeIdentityChange(() => void flush().catch(report));
  void flush().catch(report);
  return () => {
    disposed = true;
    appState.remove();
    deliveredListeners.delete(onDelivered);
    stopIdentity();
    stopConnected?.();
  };
}
