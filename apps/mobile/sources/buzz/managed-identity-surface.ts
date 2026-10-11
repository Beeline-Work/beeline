import type { ManagedIdentityResult, PhoneOperationMap, PushLevel } from '@beeline/api-contract/phone';
import { isWorkspaceListView, type RoomViewIdentity } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { clientResetGeneration } from '@/sync/client-reset';
import { MonolithWorkbenchSource } from './workbench-source';
import { isWorkbenchView } from './workbench-surface';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';

export const isManagedIdentity = (value: unknown): value is ManagedIdentityResult => {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<ManagedIdentityResult>;
  return typeof result.personId === 'string' && typeof result.name === 'string' &&
    typeof result.pushLevel === 'string';
};

async function scope() {
  const [identity, relay] = await Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]);
  if (!identity) throw new Error('Identity unavailable');
  return { relay, pubkey: identity.publicKey };
}

export async function readManagedIdentity(reconcile = false): Promise<ManagedIdentityResult> {
  const { relay, pubkey } = await scope();
  const address = surfaceAddress(relay, pubkey, '/identity/managed');
  if (!reconcile) {
    const held = await mobileSurfaceCache.read(address, isManagedIdentity);
    if (held) return held;
  }
  const result = await mobileSurfaceCache.fetch(address, isManagedIdentity, () =>
    monolithPhoneOperation('getManagedIdentity', {}));
  if (result) return result;
  const held = mobileSurfaceCache.peek(address, isManagedIdentity);
  if (held) return held;
  throw new Error('Managed identity response was superseded');
}

export async function publishManagedIdentity(result: ManagedIdentityResult): Promise<void> {
  const { relay, pubkey } = await scope();
  await mobileSurfaceCache.write(surfaceAddress(relay, pubkey, '/identity/managed'),
    result, isManagedIdentity);
}

/** One wire envelope feeds the existing owners; no route retains the envelope. */
const settingsReads = new Map<string, Promise<PhoneOperationMap['readIdentitySettings']['output']>>();
export async function readIdentitySettings(workspaceId?: string) {
  const { relay, pubkey } = await scope();
  const identityAddress = surfaceAddress(relay, pubkey, '/identity/managed');
  const workspacesAddress = surfaceAddress(relay, pubkey, '/workspaces');
  const [heldIdentity, heldWorkspaces] = await Promise.all([
    mobileSurfaceCache.read(identityAddress, isManagedIdentity),
    mobileSurfaceCache.read(workspacesAddress, isWorkspaceListView),
  ]);
  const heldSelected = heldWorkspaces?.workspaces.find((item) => item.id === workspaceId) ??
    heldWorkspaces?.workspaces[0];
  const heldWorkbench = heldSelected && await mobileSurfaceCache.read(surfaceAddress(relay, pubkey,
    '/workspace/:id/workbench', { workspaceId: heldSelected.id, viewerId: pubkey }), isWorkbenchView);
  if (heldIdentity && heldWorkspaces && (!heldSelected || heldWorkbench))
    return { identity: heldIdentity };
  const key = `${relay}\u0000${pubkey}\u0000${workspaceId ?? ''}`;
  let pending = settingsReads.get(key);
  if (!pending) {
    const generation = clientResetGeneration();
    pending = (async () => {
      const result = await monolithPhoneOperation('readIdentitySettings',
        workspaceId ? { workspaceId } : {});
      if (generation !== clientResetGeneration()) throw new Error('Settings answer superseded');
      await Promise.all([
        mobileSurfaceCache.write(identityAddress, result.identity, isManagedIdentity),
        mobileSurfaceCache.write(workspacesAddress, result.workspaces, isWorkspaceListView),
      ]);
      const selected = result.workspaces.workspaces.find((item) => item.id === workspaceId) ??
        result.workspaces.workspaces[0];
      if (selected && result.workbench) {
        const scope = { workspaceId: selected.id, viewerId: pubkey };
        const view = await new MonolithWorkbenchSource().readWorkbench(scope, result.workbench);
        await mobileSurfaceCache.write(surfaceAddress(relay, pubkey,
          '/workspace/:id/workbench', scope), view, isWorkbenchView);
      }
      return result;
    })().finally(() => { settingsReads.delete(key); });
    settingsReads.set(key, pending);
  }
  return pending;
}

/** Apply an authoritative live identity delta to the held settings projection. */
export async function applyManagedIdentityLive(person: RoomViewIdentity, pushLevel?: PushLevel) {
  const { relay, pubkey } = await scope();
  if (person.pubkey !== pubkey) return;
  const address = surfaceAddress(relay, pubkey, '/identity/managed');
  const held = mobileSurfaceCache.peek(address, isManagedIdentity);
  if (!held) return;
  await mobileSurfaceCache.write(address, { ...held, name: person.name,
    ...(person.handle ? { handle: person.handle } : {}),
    ...(person.face ? { face: person.face } : {}),
    ...(pushLevel ? { pushLevel } : {}) }, isManagedIdentity);
}
