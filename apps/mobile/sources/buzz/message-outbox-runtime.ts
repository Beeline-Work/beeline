import { markDictatedMessageAccepted } from './dictation-timing';
import { observeMessageOutbox } from './message-outbox-observer';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { getBuzzRuntimeConfig } from './runtime-config';
import { configureMessageOutboxDelivery, getMessageOutbox, resetMessageOutboxes } from './message-outbox-storage';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { MonolithRigTransport } from '@/sync/transport/monolith-rig-transport';
import { MonolithPhoneOperationError } from '@/sync/transport/monolith-operation';
import { subscribeClientReset, clientResetGeneration } from '@/sync/client-reset';

let stop: (() => void) | undefined;
let starting: Promise<void> | undefined;
const rejection = (error: unknown) => error instanceof MonolithPhoneOperationError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)
  ? error.code : undefined;
export function startMessageOutbox(): Promise<void> {
  return starting ??= (async () => {
    const generation = clientResetGeneration();
    const identity = await loadBuzzIdentity();
    if (!identity || generation !== clientResetGeneration()) { starting = undefined; return; }
    const transport = new MonolithRigTransport(identity);
    const connection = sharedLiveConnection();
    const owner = getMessageOutbox(getBuzzRuntimeConfig().monolithUrl, identity);
    configureMessageOutboxDelivery({
      send: async (event, cause) => {
        const socketGeneration = connection.diagnostics().generation;
        try {
          const result = await transport.publishPreparedMessage(event);
          markDictatedMessageAccepted(event.id);
          return result;
        }
        catch (error) {
          if (!rejection(error) && generation === clientResetGeneration()) {
            if (socketGeneration === connection.diagnostics().generation) void owner.connectionChanged(false);
            // The reconnect owns one replay. A failed replacement becomes
            // explicitly retryable rather than starting a recovery loop.
            if (cause === 'send') void connection.reconnectAfterFailedSend(socketGeneration)
              .catch(() => owner.fail(event.id));
          }
          throw error;
        }
      },
      rejection,
    });
    const unwatch = observeMessageOutbox(owner);
    // Named integration hook for the shared connection's connected state.
    const onOutboxConnected = () => { void owner.connectionChanged(true); };
    const unconnected = connection.subscribeConnected(onOutboxConnected);
    const undisconnected = connection.subscribeDisconnected(() => { void owner.connectionChanged(false); });
    let unhold: (() => void) | undefined;
    stop = () => { unwatch(); unconnected(); undisconnected(); unhold?.(); };
    // Hold the app's connection even when no Room is mounted.
    unhold = await connection.register([], () => undefined);
    if (generation !== clientResetGeneration()) { unhold(); return; }
    await owner.restore();
    void owner.connectionChanged(connection.diagnostics().state === 1);
  })();
}

subscribeClientReset(() => {
  stop?.(); stop = undefined; starting = undefined;
  resetMessageOutboxes(); observeMessageOutbox();
  void startMessageOutbox();
});
