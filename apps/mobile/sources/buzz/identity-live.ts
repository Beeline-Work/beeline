import type { RoomViewIdentity } from '@beeline/buzz-client';
import type { PushLevel } from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { saveStoredPushLevel } from '@/push/push-level-storage';
import { clientResetGeneration } from '@/sync/client-reset';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { identityScope, recordPerson, recordWorkspaceHeader, type WorkspaceHeaderChange } from './identity-records';
import { savePreferredPersonName } from './person-name';
import { mobileSurfaceCache } from './surface-storage';
import { applyManagedIdentityLive } from './managed-identity-surface';

const ownIdentityListeners = new Set<(person: RoomViewIdentity) => void>();

/** The viewer's own server identity after a change on any device. */
export function subscribeOwnIdentityChange(
  listener: (person: RoomViewIdentity) => void,
): () => void {
  ownIdentityListeners.add(listener);
  return () => {
    ownIdentityListeners.delete(listener);
  };
}

/** A server `workspace-changed` frame: every surface selects the new header. */
export async function applyWorkspaceChanged(change: WorkspaceHeaderChange): Promise<void> {
  const generation = clientResetGeneration();
  const [identity, relayUrl] = await Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]);
  // A frame read for the previous account must not reach the new one.
  if (!identity || generation !== clientResetGeneration()) return;
  const scope = identityScope(relayUrl, identity.publicKey);
  mobileSurfaceCache.fenceViewer(relayUrl, identity.publicKey,
    (stamp) => recordWorkspaceHeader(scope, change, stamp));
}

/** A server `person-changed` frame: every surface selects the new identity,
 * and the device hints of the viewer's own name and push level follow it. */
export async function applyPersonChanged(
  person: RoomViewIdentity,
  pushLevel?: PushLevel,
): Promise<void> {
  const generation = clientResetGeneration();
  const [identity, relayUrl] = await Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]);
  if (!identity || generation !== clientResetGeneration()) return;
  const scope = identityScope(relayUrl, identity.publicKey);
  mobileSurfaceCache.fenceViewer(relayUrl, identity.publicKey,
    (stamp) => recordPerson(scope, person, stamp));
  if (person.pubkey !== identity.publicKey) return;
  await applyManagedIdentityLive(person, pushLevel).catch(() => undefined);
  await savePreferredPersonName(identity.publicKey, person.name).catch(() => undefined);
  if (pushLevel) await saveStoredPushLevel(identity.publicKey, pushLevel);
  for (const listener of ownIdentityListeners) listener(person);
}

/** App-wide: apply every Workspace and identity change the server sends this viewer. */
export function startIdentityLive(): () => void {
  let cancelled = false;
  let stop: (() => void) | undefined;
  void sharedLiveConnection().register([], (event) => {
    if (!('monolithLive' in event)) return;
    const live = event.monolithLive;
    if (live.type === 'workspace-changed')
      void applyWorkspaceChanged(live.workspace).catch(() => undefined);
    else if (live.type === 'person-changed')
      void applyPersonChanged(live.person, live.pushLevel).catch(() => undefined);
  }).then((release) => {
    if (cancelled) release();
    else stop = release;
  }).catch(() => undefined);
  return () => {
    cancelled = true;
    stop?.();
  };
}
