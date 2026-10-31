import { useEffect } from 'react';
import { observeMessageOutbox } from './message-outbox-observer';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { getBuzzRuntimeConfig } from './runtime-config';
import { configureMessageOutboxDelivery, getMessageOutbox, resetMessageOutboxes } from './surface-storage';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { MonolithRigTransport } from '@/sync/transport/monolith-rig-transport';
import { MonolithPhoneOperationError } from '@/sync/transport/monolith-operation';
import { subscribeClientReset, clientResetGeneration } from '@/sync/client-reset';

let stop: (() => void) | undefined;
let starting: Promise<void> | undefined;
let active: ReturnType<typeof getMessageOutbox> | undefined;
export function startMessageOutbox(): Promise<void> {
  return starting ??= (async () => {
    const generation = clientResetGeneration();
    const identity = await loadBuzzIdentity();
    if (!identity || generation !== clientResetGeneration()) { starting = undefined; return; }
    const transport = new MonolithRigTransport(identity);
    const connection = sharedLiveConnection();
    configureMessageOutboxDelivery({
      send: async event => {
        try { return await transport.publishPreparedMessage(event); }
        catch (error) {
          if (connection.diagnostics().state !== 1) void active?.connectionChanged(false);
          throw error;
        }
      },
      rejection: error => error instanceof MonolithPhoneOperationError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)
        ? error.code : undefined,
    });
    const owner = getMessageOutbox(getBuzzRuntimeConfig().monolithUrl, identity);
    active = owner;
    const unwatch = observeMessageOutbox(owner);
    // Named integration hook for the shared connection's connected state.
    const onOutboxConnected = () => { void owner.connectionChanged(true); };
    const unconnected = connection.subscribeConnected(onOutboxConnected);
    let unhold: (() => void) | undefined;
    stop = () => { unwatch(); unconnected(); unhold?.(); };
    // Hold the app's connection even when no Room is mounted.
    unhold = await connection.register([], () => undefined);
    if (generation !== clientResetGeneration()) { unhold(); return; }
    await owner.restore();
    void owner.connectionChanged(connection.diagnostics().state === 1);
  })();
}

subscribeClientReset(() => {
  stop?.(); stop = undefined; starting = undefined; active = undefined;
  resetMessageOutboxes(); observeMessageOutbox();
  void startMessageOutbox();
});

export function useMessageOutbox(): void {
  useEffect(() => { void startMessageOutbox(); }, []);
}
