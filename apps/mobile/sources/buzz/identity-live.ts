import { isWorkspaceListView, isWorkspaceView, type RoomViewIdentity } from '@beeline/buzz-client';
import type { PushLevel } from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { saveStoredPushLevel } from '@/push/push-level-storage';
import { clientResetGeneration } from '@/sync/client-reset';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { savePreferredPersonName } from './person-name';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';
import { recordIdentityChange } from './workspace-records';

export type WorkspaceHeaderChange = { id: string; name: string; avatar?: string };

type Visit = (value: Record<string, unknown>) => Record<string, unknown> | undefined;

/** Copy only the containers on the path to a replaced object; untouched values keep their identity. */
function rewrite(value: unknown, visit: Visit): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const rewritten = rewrite(item, visit);
      if (rewritten !== item) changed = true;
      return rewritten;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const replaced = visit(record);
  if (replaced) return replaced;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    const rewritten = rewrite(item, visit);
    if (rewritten !== item) changed = true;
    next[key] = rewritten;
  }
  return changed ? next : value;
}

function withOptional(
  record: Record<string, unknown>,
  fields: Record<string, string | undefined>,
): Record<string, unknown> {
  const next = { ...record };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

/** Every Workspace header (rail, list, chat list, settings) named by `change.id`. */
export function patchWorkspaceHeader(value: unknown, change: WorkspaceHeaderChange): unknown {
  return rewrite(value, (record) => {
    if (record.id !== change.id || typeof record.name !== 'string' ||
        typeof record.role !== 'string' || typeof record.updatedAt !== 'number')
      return undefined;
    if (record.name === change.name && record.avatar === change.avatar) return undefined;
    return withOptional(record, { name: change.name, avatar: change.avatar });
  });
}

/** Every embedded identity of `person`: members, owners, bylines, DM headers. */
export function patchIdentity(value: unknown, person: RoomViewIdentity): unknown {
  return rewrite(value, (record) => {
    if (record.pubkey !== person.pubkey || typeof record.name !== 'string' ||
        (record.kind !== 'human' && record.kind !== 'agent'))
      return undefined;
    if (record.name === person.name && record.handle === person.handle &&
        record.avatar === person.avatar && record.face === person.face)
      return undefined;
    return withOptional(record, {
      name: person.name, handle: person.handle, avatar: person.avatar, face: person.face,
    });
  });
}

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

/** A server `workspace-changed` frame: patch every cached copy of that header. */
export async function applyWorkspaceChanged(change: WorkspaceHeaderChange): Promise<void> {
  const generation = clientResetGeneration();
  const [identity, relayUrl] = await Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]);
  if (!identity || generation !== clientResetGeneration()) return;
  // The rail and settings entries may be cold; load them so they are patched too.
  await Promise.all([
    mobileSurfaceCache.read(surfaceAddress(relayUrl, identity.publicKey, '/workspaces'),
      isWorkspaceListView),
    mobileSurfaceCache.read(surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id',
      { workspaceId: change.id }), isWorkspaceView),
  ]);
  // A frame read for the previous account must not patch the new one.
  if (generation !== clientResetGeneration()) return;
  await mobileSurfaceCache.patchViewer(relayUrl, identity.publicKey,
    (value) => patchWorkspaceHeader(value, change));
}

/** A server `person-changed` frame: patch every cached identity, and the
 * device hints of the viewer's own name and push level. */
export async function applyPersonChanged(
  person: RoomViewIdentity,
  pushLevel?: PushLevel,
): Promise<void> {
  const generation = clientResetGeneration();
  const [identity, relayUrl] = await Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]);
  if (!identity || generation !== clientResetGeneration()) return;
  recordIdentityChange(relayUrl, identity.publicKey, person);
  await mobileSurfaceCache.patchViewer(relayUrl, identity.publicKey,
    (value) => patchIdentity(value, person));
  if (person.pubkey !== identity.publicKey) return;
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
