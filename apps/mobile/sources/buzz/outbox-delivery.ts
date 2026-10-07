import { AppState } from 'react-native';
import type { NostrEvent } from '@beeline/nostr';
import type { AgentMessageWriteResult } from '@beeline/api-contract/phone';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { monolithSession } from '@/auth/monolith-session';
import { BuzzRigTransport } from '@/sync/transport';
import { MonolithPhoneOperationError } from '@/sync/transport/monolith-operation';
import {
  createRoomOutbox,
  pendingOutboxRoomIds,
  subscribeOutboxSaved,
} from './surface-storage';

type Publisher = Pick<BuzzRigTransport, 'publishPreparedMessage'>;

const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 60_000;

const inFlight = new Map<string, Promise<AgentMessageWriteResult>>();

/**
 * One request per prepared event at a time, whichever path asks for it. The
 * server has stored the message once it acks, so the stored send is retired
 * then and no retry sends it again.
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
 * retryable failure stays pending; a refusal is marked failed for the Room to
 * show. Returns how many sends are still pending.
 */
async function flushPendingOutboxes(
  identity: { publicKey: string },
  transport: Publisher,
): Promise<number> {
  let pending = 0;
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
          pending += 1;
        }
      }
    }
  }
  return pending;
}

/**
 * Drive pending sends on launch, sign-in, foreground, live reconnect, and on a
 * backoff timer while the app is open, whichever screen is showing.
 */
export function startOutboxDelivery(): () => void {
  let disposed = false;
  let flushing = false;
  let again = false;
  let retryMs = RETRY_FIRST_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopConnected: (() => void) | undefined;

  const cancelTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const arm = () => {
    if (timer !== undefined || disposed || AppState.currentState === 'background') return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush().catch(report);
    }, retryMs);
  };
  const flush = async () => {
    if (flushing) {
      again = true;
      return;
    }
    flushing = true;
    cancelTimer();
    let pending = 0;
    try {
      do {
        again = false;
        const identity = await loadBuzzIdentity();
        if (!identity || disposed) return;
        const transport = new BuzzRigTransport(identity);
        if (!stopConnected) stopConnected = transport.subscribeConnected(() => void flush());
        pending = await flushPendingOutboxes(identity, transport);
      } while (again && !disposed);
    } finally {
      flushing = false;
    }
    if (pending > 0) {
      arm();
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    } else {
      retryMs = RETRY_FIRST_MS;
    }
  };
  const report = (error: unknown) => console.warn('[outbox]', error);

  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      retryMs = RETRY_FIRST_MS;
      void flush().catch(report);
    } else if (state === 'background') {
      cancelTimer();
    }
  });
  // A new or still-pending send arms the timer; the composer's own request
  // usually acks first and retires it, leaving the timer nothing to send.
  const stopSaved = subscribeOutboxSaved(() => {
    if (flushing) again = true;
    else arm();
  });
  const stopIdentity = monolithSession.subscribeIdentityChange(() => void flush().catch(report));
  void flush().catch(report);
  return () => {
    disposed = true;
    cancelTimer();
    appState.remove();
    stopSaved();
    stopIdentity();
    stopConnected?.();
  };
}
