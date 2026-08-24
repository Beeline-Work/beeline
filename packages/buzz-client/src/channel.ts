/**
 * Channel control-plane ops over the HTTP bridge.
 *
 * Create (9007), put/remove-user (9000/9001), messages (9), membership/metadata read
 * (39002 / 39000). **Never treat an accepted publish as proof of effect** —
 * assert membership via query of 39002 (see assertMember / waitUntilMember).
 */
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CHANNEL_METADATA,
  KIND_CREATE_GROUP,
  KIND_DELETE_GROUP,
  KIND_EDIT_METADATA,
  KIND_PUT_USER,
  KIND_REMOVE_USER,
  KIND_STREAM_MESSAGE,
  TAG_AGENT_ACTIVITY,
  TAG_AGENT,
  TAG_COMMUNITY,
  TAG_DIRECT_MESSAGE,
  TAG_PARENT,
  TAG_ROOM_LIFECYCLE,
} from './kinds.js';
import { publishEvent, type AuthenticatedHttpBridgeOptions } from './http.js';
import { isArchivedChannelError } from './archived-channel.js';
import {
  parseMembersEvent,
  parseMetadataEvent,
  sortEventsChronological,
  tagValue,
  tagValues,
} from './parse.js';
import { query } from './query.js';
import type {
  ChannelFilterOpts,
  ChannelMember,
  ChannelMetadata,
  Identity,
  MessageSubmitOpts,
  PublishResult,
  RepositoryBinding,
} from './types.js';
import type { RelayWs } from './ws.js';

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function newChannelUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Fallback UUID v4
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function sign(identity: Identity, kind: number, tags: string[][], content = ''): NostrEvent {
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: now(),
      kind,
      tags,
      content,
    },
    identity.secretKey,
  );
}

/**
 * True when `pubkey` has self-signed the durable first-class agent record
 * (`#t=buzz-agent`, kind:9). This classification is independent of channel
 * roles — promoting an agent to admin never turns its key into a human key.
 */
export async function isRegisteredAgentKey(
  ctx: ChannelOpsContext,
  pubkey: string,
): Promise<boolean> {
  const events = await query(ctx, [
    { kinds: [KIND_STREAM_MESSAGE], authors: [pubkey], '#t': [TAG_AGENT], limit: 20 },
  ]);
  return events.some(
    (event) =>
      event.pubkey === pubkey &&
      verifyEvent(event) &&
      event.tags.some((tag) => tag[0] === 't' && tag[1] === TAG_AGENT),
  );
}

export interface ChannelOpsContext {
  http: AuthenticatedHttpBridgeOptions;
  identity: Identity;
  /**
   * Optional accessor for the caller's live socket. When it returns an
   * already-connected RelayWs, the waitUntilMember family (below) resolves
   * off the relay's own push instead of polling. Opportunistic only — see
   * waitForRelayProjection.
   */
  ws?: () => RelayWs | null;
}

export type ChannelRole = 'owner' | 'admin' | 'member';

/**
 * Room creation is a HUMAN action. A registered agent identity must never
 * author a top-level Room (kind:9007 without a `parent` tag) — that is the
 * write that makes an agent the relay-recorded `created_by` of a Room and is
 * how pairing once silently bound a foreign repository into a Workspace.
 * Enforcement lives here, at the single funnel every creation event in this
 * codebase is assembled and signed through, keyed on the durable self-signed
 * agent registry — not on roles, which an operator can change. Child channels
 * (corners, `parentChannelId` set) stay agent-creatable by design: they are
 * work items inside a human-governed Room, not Rooms.
 */
async function assertTopLevelCreatorIsHuman(
  ctx: ChannelOpsContext,
  opts?: { parentChannelId?: string },
): Promise<void> {
  if (opts?.parentChannelId) return;
  if (await isRegisteredAgentKey(ctx, ctx.identity.publicKey)) {
    throw new Error(
      'room creation is a human action: a registered agent identity cannot create a Room. ' +
        'Have a human create or choose the Room (and bind any repository), then pair or ' +
        'attach the agent to it.',
    );
  }
}

/** Create an open stream channel owned by `identity`. Returns channel UUID. */
export async function createChannel(
  ctx: ChannelOpsContext,
  name: string,
  opts?: {
    channelId?: string;
    visibility?: string;
    parentChannelId?: string;
    communityId?: string;
    repository?: RepositoryBinding;
    /** Internal protocol tags for specialized channel shapes such as DMs. */
    extraTags?: string[][];
    /** Workspace Rooms mirror people; private two-party Rooms opt out. */
    mirrorCommunityMembers?: boolean;
  },
): Promise<string> {
  await assertTopLevelCreatorIsHuman(ctx, opts);
  const channelId = opts?.channelId ?? newChannelUuid();
  const tags: string[][] = [
    ['h', channelId],
    ['name', name],
    ['channel_type', 'stream'],
    ['visibility', opts?.visibility ?? 'open'],
  ];
  if (opts?.parentChannelId) {
    tags.push([TAG_PARENT, opts.parentChannelId]);
  }
  if (opts?.communityId) {
    tags.push([TAG_COMMUNITY, opts.communityId]);
  }
  if (opts?.repository) {
    tags.push(['repo-key', opts.repository.key]);
    tags.push(['repo-name', opts.repository.name]);
    tags.push(['repo-scope', opts.repository.localOnly ? 'local' : 'remote']);
    if (opts.repository.remote) tags.push(['repo-remote', opts.repository.remote]);
    if (opts.repository.githubInstallationId) {
      tags.push(['repo-github-installation', String(opts.repository.githubInstallationId)]);
    }
  }
  if (opts?.extraTags) tags.push(...opts.extraTags);
  const event = sign(ctx.identity, KIND_CREATE_GROUP, tags);
  await publishEvent(ctx.http, event);
  if (opts?.communityId && opts.mirrorCommunityMembers !== false) {
    // A community tag makes the channel discoverable, but NIP-29 authorization
    // still comes from the channel's direct member projection. Wait for the
    // creator's implicit ownership first, then mirror every other current
    // community member as a normal channel member.
    await waitUntilMember(ctx, channelId, ctx.identity.publicKey);
    const communityMembers = await listMembers(ctx, opts.communityId);
    for (const member of communityMembers) {
      if (member.pubkey === ctx.identity.publicKey) continue;
      // Workspace membership links an agent identity once, but does not grant
      // ambient presence in every current/future Room. People are mirrored;
      // registered agents require attachAgentToChannel for each Room.
      if (await isRegisteredAgentKey(ctx, member.pubkey)) continue;
      await setMemberRole(ctx, channelId, member.pubkey, 'member', {
        extraTags: [[TAG_COMMUNITY, opts.communityId]],
      });
      await waitUntilMember(ctx, channelId, member.pubkey);
    }
  }
  if (opts?.communityId && opts.mirrorCommunityMembers === false) {
    await waitUntilMember(ctx, channelId, ctx.identity.publicKey);
  }
  return channelId;
}

/**
 * Create a child/subchannel under `parentChannelId` (app convention: `parent` tag).
 * Does NOT auto-mirror members — caller should addMember for each parent member
 * and assert via waitUntilMember.
 */
export async function createSubchannel(
  ctx: ChannelOpsContext,
  parentChannelId: string,
  name: string,
  opts?: { communityId?: string },
): Promise<string> {
  return createChannel(ctx, name, { parentChannelId, ...opts });
}

/**
 * Set `targetPubkey`'s role in the channel (kind:9000).
 * Role is a **separate** `["role", …]` tag (not NIP-29 p-slot) — silent fail otherwise.
 * Publish ack is NOT proof — call waitUntilMember / listMembers.
 */
export async function setMemberRole(
  ctx: ChannelOpsContext,
  channelId: string,
  targetPubkey: string,
  role: 'owner' | 'admin' | 'member',
  opts?: { extraTags?: string[][] },
): Promise<PublishResult> {
  const tags: string[][] = [
    ['h', channelId],
    ['p', targetPubkey],
    ['role', role],
  ];
  if (opts?.extraTags) tags.push(...opts.extraTags);
  const event = sign(ctx.identity, KIND_PUT_USER, tags);
  return publishEvent(ctx.http, event);
}

/**
 * Remove `targetPubkey` from a channel (kind:9001).
 * Publish ack is NOT proof — call waitUntilNotMember after this mutation.
 */
export async function removeMember(
  ctx: ChannelOpsContext,
  channelId: string,
  targetPubkey: string,
  opts?: { extraTags?: string[][] },
): Promise<PublishResult> {
  const tags: string[][] = [
    ['h', channelId],
    ['p', targetPubkey],
  ];
  if (opts?.extraTags) tags.push(...opts.extraTags);
  const event = sign(ctx.identity, KIND_REMOVE_USER, tags);
  return publishEvent(ctx.http, event);
}

async function latestRoleProjection(
  ctx: ChannelOpsContext,
  channelId: string,
  kind: number,
): Promise<NostrEvent | undefined> {
  let events = await query(ctx, [{ kinds: [kind], '#d': [channelId], limit: 5 }]);
  if (events.length === 0) {
    events = await query(ctx, [{ kinds: [kind], '#h': [channelId], limit: 5 }]);
  }
  return [...events].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

/** Query current 39001/39002 projections; owners/admins are also members. */
export async function listMembers(
  ctx: ChannelOpsContext,
  channelId: string,
): Promise<ChannelMember[]> {
  const [memberProjection, adminProjection] = await Promise.all([
    latestRoleProjection(ctx, channelId, KIND_CHANNEL_MEMBERS),
    latestRoleProjection(ctx, channelId, KIND_CHANNEL_ADMINS),
  ]);
  const current = new Map<string, ChannelMember>();
  for (const member of memberProjection ? parseMembersEvent(memberProjection) : []) {
    current.set(member.pubkey, member);
  }
  for (const tag of adminProjection?.tags ?? []) {
    if (tag[0] !== 'p' || !tag[1]) continue;
    const role = tag[3] === 'owner' || tag[2] === 'owner' ? 'owner' : 'admin';
    current.set(tag[1], { pubkey: tag[1], role });
  }
  return [...current.values()];
}

/** True if pubkey appears in current member, owner, or admin projections. */
export async function isMember(
  ctx: ChannelOpsContext,
  channelId: string,
  pubkey: string,
): Promise<boolean> {
  const members = await listMembers(ctx, channelId);
  return members.some((m) => m.pubkey === pubkey);
}

/** Resolve one identity's current role from the relay's authoritative projections. */
export async function getChannelRole(
  ctx: ChannelOpsContext,
  channelId: string,
  pubkey: string,
): Promise<ChannelRole | null> {
  const member = (await listMembers(ctx, channelId)).find((item) => item.pubkey === pubkey);
  if (!member) return null;
  return member.role === 'owner' || member.role === 'admin' ? member.role : 'member';
}

function canManageRole(role: ChannelRole | null): role is 'owner' | 'admin' {
  return role === 'owner' || role === 'admin';
}

async function assertTopLevelRoom(ctx: ChannelOpsContext, channelId: string): Promise<void> {
  const creates = await query(ctx, [{ kinds: [KIND_CREATE_GROUP], '#h': [channelId], limit: 20 }]);
  const create = [...creates]
    .filter((event) => tagValue(event, 'h') === channelId)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))[0];
  if (!create) throw new Error(`Room ${channelId} does not have an immutable create event`);
  if (tagValue(create, TAG_PARENT))
    throw new Error('Room lifecycle actions cannot target a corner');
  if (tagValues(create, 't').includes(TAG_DIRECT_MESSAGE)) {
    throw new Error('direct-message membership and lifecycle are immutable');
  }
  if (tagValue(create, TAG_COMMUNITY) === channelId) {
    throw new Error('Room lifecycle actions cannot target a Workspace');
  }
}

/** Admin-only member removal with current-role and relay-projection verification. */
export async function removeRoomMember(
  ctx: ChannelOpsContext,
  channelId: string,
  targetPubkey: string,
): Promise<void> {
  await assertTopLevelRoom(ctx, channelId);
  const members = await listMembers(ctx, channelId);
  const actor = members.find((member) => member.pubkey === ctx.identity.publicKey);
  const target = members.find((member) => member.pubkey === targetPubkey);
  const actorRole = await getChannelRole(ctx, channelId, ctx.identity.publicKey);
  if (!canManageRole(actorRole)) throw new Error('only a Room owner or admin can remove members');
  if (!actor || !target) throw new Error('the selected identity is not a current Room member');
  if (targetPubkey === ctx.identity.publicKey) {
    throw new Error('Room admins cannot remove themselves; delete the Room instead');
  }
  const targetRole = target.role === 'owner' || target.role === 'admin' ? target.role : 'member';
  if (targetRole === 'owner' || (actorRole === 'admin' && targetRole === 'admin')) {
    throw new Error('this member has equal or greater Room authority');
  }
  await removeMember(ctx, channelId, targetPubkey, {
    extraTags: [
      ['t', TAG_ROOM_LIFECYCLE],
      ['action', 'admin-remove'],
    ],
  });
  await waitUntilNotMember(ctx, channelId, targetPubkey);
}

/** A normal member may remove only their own membership; admins use Room deletion. */
export async function leaveRoom(ctx: ChannelOpsContext, channelId: string): Promise<void> {
  await assertTopLevelRoom(ctx, channelId);
  const role = await getChannelRole(ctx, channelId, ctx.identity.publicKey);
  if (role !== 'member') {
    throw new Error(
      canManageRole(role)
        ? 'Room admins cannot leave; delete the Room or transfer authority first'
        : 'you are not a current member of this Room',
    );
  }
  try {
    await removeMember(ctx, channelId, ctx.identity.publicKey, {
      extraTags: [
        ['t', TAG_ROOM_LIFECYCLE],
        ['action', 'member-leave'],
      ],
    });
  } catch (error) {
    // Leaving an archived Room must not depend on the publish landing: the
    // relay refuses writes to archived channels outright, and the member's
    // own dismissal of the Room from their deck is local intent. The
    // archived-channel refusal is terminal, so treat it as done.
    if (isArchivedChannelError(error)) return;
    throw error;
  }
  await waitUntilNotMember(ctx, channelId, ctx.identity.publicKey);
}

/** Low-rate correctness backstop while a live WS push resolves the wait instead. */
export const RELAY_PROJECTION_BACKSTOP_POLL_MS = 5_000;

/**
 * Wait for `check()` to become true, resolving off a live WS push on `kinds`
 * scoped to `channelId` when the context already has an authenticated socket
 * open — 9000/9001 role and metadata mutations already publish events the
 * relay pushes over that socket, so a poll-body call only needs to re-run
 * `check()` when something has actually changed, not on a fixed cadence.
 *
 * WS is opportunistic only (gated on `ws.connected`, never forces a
 * connect): a `RELAY_PROJECTION_BACKSTOP_POLL_MS` poll of `check()` itself
 * runs concurrently for the whole wait as the correctness guarantee, so an
 * absent, never-authenticated, or dropped socket just falls back to being
 * noticed on the next backstop tick instead of stalling. Same technique as
 * apps/body's waitForWritePermissionDecision.
 */
export async function waitForRelayProjection(
  ctx: ChannelOpsContext,
  channelId: string,
  kinds: number[],
  check: () => Promise<boolean>,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<boolean> {
  const ws = ctx.ws?.();
  if (!ws?.connected) {
    const start = Date.now();
    while (Date.now() - start < opts.timeoutMs) {
      if (await check()) return true;
      await new Promise((resolveWait) => setTimeout(resolveWait, opts.intervalMs));
    }
    return false;
  }

  const backstopMs = Math.max(opts.intervalMs, RELAY_PROJECTION_BACKSTOP_POLL_MS);

  return new Promise<boolean>((resolvePromise, rejectPromise) => {
    let settled = false;
    let backstopRunning = false;
    let unsubscribe: () => void = () => {};

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(backstop);
      unsubscribe();
      resolvePromise(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(backstop);
      unsubscribe();
      rejectPromise(error);
    };

    const timer = setTimeout(() => finish(false), opts.timeoutMs);

    const pollOnce = () => {
      if (settled || backstopRunning) return;
      backstopRunning = true;
      check()
        .then((ok) => {
          if (ok) finish(true);
        })
        .catch(fail)
        .finally(() => {
          backstopRunning = false;
        });
    };

    const backstop = setInterval(pollOnce, backstopMs);
    pollOnce();

    try {
      unsubscribe = ws.subscribe(
        [
          { kinds, '#d': [channelId] },
          { kinds, '#h': [channelId] },
        ],
        () => pollOnce(),
      );
    } catch {
      // A socket that looked connected but rejected the REQ synchronously
      // leaves the backstop poll as the sole path for this wait.
    }
  });
}

/** Poll until relay metadata projects the explicit archive state. */
export async function waitUntilRoomArchived(
  ctx: ChannelOpsContext,
  channelId: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const intervalMs = opts?.intervalMs ?? 300;
  const ok = await waitForRelayProjection(
    ctx,
    channelId,
    [KIND_CHANNEL_METADATA],
    async () => (await getChannelMetadata(ctx, channelId))?.archived === true,
    { timeoutMs, intervalMs },
  );
  if (ok) return;
  throw new Error(`Room ${channelId} did not become archived after ${timeoutMs}ms`);
}

/**
 * Wait until a deleted Room is absent from every relay enumeration source.
 *
 * The deck discovers Rooms through the viewer's 39001/39002 projection, while
 * Workspace Settings discovers them through the channel-scoped 9007 create
 * event. A successful kind:9008 is not complete until both are gone and the
 * 39000 metadata projection has also been retracted.
 */
export async function waitUntilRoomDeleted(
  ctx: ChannelOpsContext,
  channelId: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const intervalMs = opts?.intervalMs ?? 300;
  const ok = await waitForRelayProjection(
    ctx,
    channelId,
    [KIND_DELETE_GROUP, KIND_CHANNEL_METADATA, KIND_CHANNEL_ADMINS, KIND_CHANNEL_MEMBERS],
    async () => {
      const creates = await query(ctx, [
        { kinds: [KIND_CREATE_GROUP], '#h': [channelId], limit: 20 },
      ]);
      if (creates.some((event) => tagValue(event, 'h') === channelId)) return false;
      if ((await getChannelMetadata(ctx, channelId)) !== null) return false;
      const memberships = await listChannelsForPubkey(ctx, ctx.identity.publicKey, 500);
      return !memberships.some((membership) => membership.channelId === channelId);
    },
    { timeoutMs, intervalMs },
  );
  if (ok) return;
  throw new Error(`Room ${channelId} remained enumerable after deletion for ${timeoutMs}ms`);
}

/**
 * Explicit owner/admin Room archive path.
 * This is intentionally separate from Gate's corner-only archive writer.
 * Relay data is retained; recovery projection/UI is a separate follow-up.
 *
 * Archiving an ALREADY-archived Room is success, not error: the relay refuses
 * every further kind:9002 on an archived channel with HTTP 400
 * "channel is archived", which would otherwise make an archive retry fail
 * despite the desired retained terminal state already being present. The
 * archived-channel refusal is the proof the Room already sits in the desired
 * terminal state, so it resolves instead of surfacing; any other failure
 * (network, a different 4xx) still throws honestly.
 */
export async function archiveRoom(ctx: ChannelOpsContext, channelId: string): Promise<void> {
  await assertTopLevelRoom(ctx, channelId);
  const role = await getChannelRole(ctx, channelId, ctx.identity.publicKey);
  if (!canManageRole(role)) throw new Error('only a Room owner or admin can change Room lifecycle');
  const event = sign(ctx.identity, KIND_EDIT_METADATA, [
    ['h', channelId],
    ['archived', 'true'],
    ['t', TAG_ROOM_LIFECYCLE],
    ['action', 'admin-archive'],
  ]);
  try {
    await publishEvent(ctx.http, event);
  } catch (error) {
    if (isArchivedChannelError(error)) return;
    throw error;
  }
  await waitUntilRoomArchived(ctx, channelId);
}

/**
 * Permanently remove a top-level Room from the relay's live channel set.
 *
 * NIP-29 kind:9008 is the durable delete command. Buzz soft-deletes the
 * channel row for auditability and retracts its 39000/39001/39002 discovery
 * events, so every reader stops enumerating the Room without a UI filter.
 * This is owner-only at the relay; archiveRoom remains the retained-data path.
 */
export async function deleteRoom(ctx: ChannelOpsContext, channelId: string): Promise<void> {
  await assertTopLevelRoom(ctx, channelId);
  const role = await getChannelRole(ctx, channelId, ctx.identity.publicKey);
  if (role !== 'owner') throw new Error('only a Room owner can delete it');
  await publishEvent(
    ctx.http,
    sign(ctx.identity, KIND_DELETE_GROUP, [
      ['h', channelId],
      ['t', TAG_ROOM_LIFECYCLE],
      ['action', 'admin-delete'],
    ]),
  );
  await waitUntilRoomDeleted(ctx, channelId);
}

/** Rename a top-level Room through the current owner/admin metadata path. */
export async function renameChannel(
  ctx: ChannelOpsContext,
  channelId: string,
  nextName: string,
): Promise<ChannelMetadata> {
  const name = nextName.trim();
  if (!name) throw new Error('Room name cannot be empty');
  await assertTopLevelRoom(ctx, channelId);
  const role = await getChannelRole(ctx, channelId, ctx.identity.publicKey);
  if (!canManageRole(role)) throw new Error('only a Room owner or admin can rename it');

  const current = await getChannelMetadata(ctx, channelId);
  const tags: string[][] = [
    ['h', channelId],
    ['name', name],
  ];
  if (current?.about) tags.push(['about', current.about]);
  if (current?.archived) tags.push(['archived', 'true']);
  if (current?.communityId) tags.push([TAG_COMMUNITY, current.communityId]);

  await publishEvent(ctx.http, sign(ctx.identity, KIND_EDIT_METADATA, tags));
  let projected: ChannelMetadata | null = null;
  const ok = await waitForRelayProjection(
    ctx,
    channelId,
    [KIND_CHANNEL_METADATA],
    async () => {
      projected = await getChannelMetadata(ctx, channelId);
      return projected?.name === name;
    },
    { timeoutMs: 15_000, intervalMs: 300 },
  );
  if (ok && projected) return projected;
  throw new Error(`Room name was not projected after 15000ms`);
}

/** Change a top-level Room between public discovery and invite-only access. */
export async function setChannelVisibility(
  ctx: ChannelOpsContext,
  channelId: string,
  visibility: 'public' | 'invite-only',
): Promise<ChannelMetadata> {
  if (visibility !== 'public' && visibility !== 'invite-only') {
    throw new Error('invalid Room visibility');
  }
  await assertTopLevelRoom(ctx, channelId);
  const role = await getChannelRole(ctx, channelId, ctx.identity.publicKey);
  if (!canManageRole(role)) {
    throw new Error('only a Room owner or admin can change its visibility');
  }

  const current = await getChannelMetadata(ctx, channelId);
  const tags: string[][] = [
    ['h', channelId],
    ['visibility', visibility === 'invite-only' ? 'private' : 'open'],
  ];
  if (current?.name) tags.push(['name', current.name]);
  if (current?.about) tags.push(['about', current.about]);
  if (current?.archived) tags.push(['archived', 'true']);
  if (current?.communityId) tags.push([TAG_COMMUNITY, current.communityId]);

  await publishEvent(ctx.http, sign(ctx.identity, KIND_EDIT_METADATA, tags));
  let projected: ChannelMetadata | null = null;
  const ok = await waitForRelayProjection(
    ctx,
    channelId,
    [KIND_CHANNEL_METADATA],
    async () => {
      projected = await getChannelMetadata(ctx, channelId);
      return projected?.visibility === visibility;
    },
    { timeoutMs: 15_000, intervalMs: 300 },
  );
  if (ok && projected) return projected;
  throw new Error('Room visibility was not projected after 15000ms');
}

/**
 * The relay stores a kind:9000 member-add but its kind:39002 projection never
 * shows the member within the wait window. Upstream block/buzz honors
 * member-adds only when authored by a room admin, so a self-join against a
 * room with no living admin times out here BY DESIGN of the relay — a
 * permanent verdict about that (room, key) pair, not a transient failure.
 * Callers classify via isMembershipProjectionTimeout to degrade gracefully
 * (e.g. succession migration skipping an orphaned room) while genuine
 * publish/transport errors keep propagating.
 */
export class MembershipProjectionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MembershipProjectionTimeoutError';
  }
}

export function isMembershipProjectionTimeout(error: unknown): boolean {
  return error instanceof MembershipProjectionTimeoutError;
}

/**
 * Poll until membership is visible (gotcha: accepted 9000 ≠ applied).
 * Throws if not listed within timeout.
 */
export async function waitUntilMember(
  ctx: ChannelOpsContext,
  channelId: string,
  pubkey: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const intervalMs = opts?.intervalMs ?? 300;
  const ok = await waitForRelayProjection(
    ctx,
    channelId,
    [KIND_CHANNEL_MEMBERS, KIND_CHANNEL_ADMINS],
    () => isMember(ctx, channelId, pubkey),
    { timeoutMs, intervalMs },
  );
  if (ok) return;
  throw new MembershipProjectionTimeoutError(
    `membership not visible for ${pubkey.slice(0, 12)}… in ${channelId} after ${timeoutMs}ms (assert on 39002, not publish ack)`,
  );
}

/**
 * Poll until the relay's role projections show the requested role.
 *
 * Membership and authority project independently: a member → admin command
 * leaves 39002 true throughout, so waitUntilMember cannot prove a promotion
 * or demotion took effect.
 */
export async function waitUntilMemberRole(
  ctx: ChannelOpsContext,
  channelId: string,
  pubkey: string,
  role: ChannelRole,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const intervalMs = opts?.intervalMs ?? 300;
  const ok = await waitForRelayProjection(
    ctx,
    channelId,
    [KIND_CHANNEL_MEMBERS, KIND_CHANNEL_ADMINS],
    async () => (await getChannelRole(ctx, channelId, pubkey)) === role,
    { timeoutMs, intervalMs },
  );
  if (ok) return;
  throw new Error(
    `role ${role} was not visible for ${pubkey.slice(0, 12)}… in ${channelId} after ${timeoutMs}ms (assert on 39001/39002, not publish ack)`,
  );
}

/** Poll until the current 39001/39002 projections no longer list a member. */
export async function waitUntilNotMember(
  ctx: ChannelOpsContext,
  channelId: string,
  pubkey: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const intervalMs = opts?.intervalMs ?? 300;
  const ok = await waitForRelayProjection(
    ctx,
    channelId,
    [KIND_CHANNEL_MEMBERS, KIND_CHANNEL_ADMINS],
    async () => !(await isMember(ctx, channelId, pubkey)),
    { timeoutMs, intervalMs },
  );
  if (ok) return;
  throw new Error(
    `membership still visible for ${pubkey.slice(0, 12)}… in ${channelId} after ${timeoutMs}ms (assert on 39001/39002, not publish ack)`,
  );
}

/** List channels where `pubkey` appears on a 39002 (#p filter). */
export async function listChannelsForPubkey(
  ctx: ChannelOpsContext,
  pubkey: string,
  limit = 50,
): Promise<{ channelId: string; event: NostrEvent }[]> {
  const events = await query(ctx, [
    { kinds: [KIND_CHANNEL_MEMBERS, KIND_CHANNEL_ADMINS], '#p': [pubkey], limit },
  ]);
  const out: { channelId: string; event: NostrEvent }[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const channelId = tagValue(ev, 'd') ?? tagValue(ev, 'h');
    if (channelId && !seen.has(channelId)) {
      seen.add(channelId);
      out.push({ channelId, event: ev });
    }
  }
  return out;
}

/** Read channel metadata (kind:39000). */
export async function getChannelMetadata(
  ctx: ChannelOpsContext,
  channelId: string,
): Promise<ChannelMetadata | null> {
  const events = await query(ctx, [
    { kinds: [KIND_CHANNEL_METADATA], '#d': [channelId], limit: 5 },
  ]);
  if (events.length === 0) {
    const alt = await query(ctx, [{ kinds: [KIND_CHANNEL_METADATA], '#h': [channelId], limit: 5 }]);
    if (alt.length === 0) return null;
    return parseMetadataEvent(latestMetadataEvent(alt)!);
  }
  return parseMetadataEvent(latestMetadataEvent(events)!);
}

/** Relay query ordering is not a replaceable-event ordering guarantee. */
function latestMetadataEvent(events: NostrEvent[]): NostrEvent | undefined {
  return [...events].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

/**
 * Discover child/subchannels of a parent by scanning kind:9007 create events
 * that carry a `parent` tag matching `parentChannelId`, plus the parent Room's
 * durable Body-control links.
 *
 * Parent linkage lives on the 9007 create event, NOT on kind:39000 metadata
 * (though some stacks may mirror it there).
 *
 * The relay does NOT index multi-character tags (`#parent`), so we query
 * all recent 9007 events and filter client-side by the `parent` tag value.
 * A closed NIP-29 child can omit its create event from that broad query even
 * for a parent member. Body also writes a parent-scoped control event with the
 * child `subchannel` tag; merge those links so invite-only corners remain
 * discoverable. `closed` is an access flag, never a lifecycle/archive signal.
 */
/**
 * How far back a windowed scan will page before giving up. A page is `limit`
 * events, so this is a hard ceiling on the work one listing can do on a very
 * busy relay; the normal terminator is reaching the Room's own creation.
 */
const SUBCHANNEL_SCAN_MAX_PAGES = 20;

/**
 * Walk a newest-first filter backwards until it reaches `stopAt`, runs out of
 * events, or spends its page budget.
 *
 * A Nostr `limit` always returns the NEWEST N matches, so a single windowed
 * read silently forgets everything older — which is why this repository keeps
 * finding the same bug in different places (corners falling out of tracking, a
 * Room's oldest corners vanishing from the list). Paging with `until` is the
 * general answer, and a Room's own `created_at` is the honest terminator: no
 * child of a Room can predate the Room.
 */
async function scanBack(
  ctx: ChannelOpsContext,
  filter: Record<string, unknown>,
  limit: number,
  stopAt: number,
): Promise<NostrEvent[]> {
  const collected = new Map<string, NostrEvent>();
  let until: number | undefined;
  for (let page = 0; page < SUBCHANNEL_SCAN_MAX_PAGES; page++) {
    const events = await query(ctx, [
      { ...filter, limit, ...(until === undefined ? {} : { until }) },
    ]);
    if (events.length === 0) break;
    let oldest = Number.POSITIVE_INFINITY;
    let fresh = 0;
    for (const event of events) {
      if (!collected.has(event.id)) fresh++;
      collected.set(event.id, event);
      oldest = Math.min(oldest, event.created_at);
    }
    // A full page that taught us nothing new, or one that has already reached
    // past the Room's own creation, means there is nothing further back worth
    // asking for. `fresh === 0` is also the guard against a same-second run
    // wider than one page pinning `until` forever.
    if (events.length < limit || oldest <= stopAt || fresh === 0) break;
    until = oldest;
  }
  return [...collected.values()];
}

export async function listSubchannels(
  ctx: ChannelOpsContext,
  parentChannelId: string,
  limit = 500,
): Promise<string[]> {
  // The Room's own create event bounds both scans. Unreadable (or a Room with
  // no create event on this relay) falls back to 0, i.e. page the full budget
  // rather than stop early on a guess.
  const parentCreates = await query(ctx, [
    { kinds: [KIND_CREATE_GROUP], '#h': [parentChannelId], limit: 5 },
  ]);
  const stopAt = parentCreates.reduce(
    (oldest, event) => Math.min(oldest, event.created_at),
    Number.POSITIVE_INFINITY,
  );
  const roomCreatedAt = Number.isFinite(stopAt) ? stopAt : 0;

  const [events, controlEvents] = await Promise.all([
    // Deliberately unscoped: `parent` is a multi-character tag and so is not
    // relay-indexable, which is exactly why this scan needs paging.
    scanBack(ctx, { kinds: [KIND_CREATE_GROUP] }, limit, roomCreatedAt),
    scanBack(
      ctx,
      { kinds: [KIND_STREAM_MESSAGE], '#h': [parentChannelId], '#t': ['body-control'] },
      limit,
      roomCreatedAt,
    ),
  ]);
  const ids = new Set<string>();
  for (const ev of events) {
    const parent = tagValue(ev, 'parent');
    if (parent !== parentChannelId) continue;
    const id = tagValue(ev, 'h') ?? tagValue(ev, 'd');
    if (id && id !== parentChannelId) ids.add(id);
  }
  for (const ev of controlEvents) {
    const id = tagValue(ev, 'subchannel');
    if (id && id !== parentChannelId) ids.add(id);
  }
  return [...ids];
}

/** Build one stable kind:9 channel message. Callers may safely republish this exact event. */
export function buildMessage(
  ctx: ChannelOpsContext,
  channelId: string,
  text: string,
  opts?: MessageSubmitOpts & { agentActivity?: boolean },
): NostrEvent {
  const tags: string[][] = [['h', channelId]];
  const mentionedPubkeys = new Set(opts?.mentionPubkeys ?? []);
  if (opts?.mentionAgent) mentionedPubkeys.add(opts.mentionAgent);
  for (const pubkey of mentionedPubkeys) tags.push(['p', pubkey]);
  if (opts?.agentActivity) tags.push(['t', TAG_AGENT_ACTIVITY]);
  if (opts?.extraTags) tags.push(...opts.extraTags);
  return sign(ctx.identity, KIND_STREAM_MESSAGE, tags, text);
}

/** Build + publish a kind:9 channel message. */
export async function sendMessage(
  ctx: ChannelOpsContext,
  channelId: string,
  text: string,
  opts?: MessageSubmitOpts & { agentActivity?: boolean },
): Promise<NostrEvent> {
  const event = buildMessage(ctx, channelId, text, opts);
  await publishEvent(ctx.http, event);
  return event;
}

/** Backfill channel messages (and optional agent-activity) oldest-first. */
export async function backfillMessages(
  ctx: ChannelOpsContext,
  channelId: string,
  opts?: ChannelFilterOpts,
): Promise<NostrEvent[]> {
  const kinds = opts?.kinds ?? [KIND_STREAM_MESSAGE];
  const filter: Record<string, unknown> = {
    kinds,
    '#h': [channelId],
  };
  if (opts?.limit !== undefined) filter.limit = opts.limit;
  if (opts?.since !== undefined) filter.since = opts.since;
  if (opts?.until !== undefined) filter.until = opts.until;

  const events = await query(ctx, [filter]);
  return sortEventsChronological(events);
}

/** True if event carries the agent-activity marker. */
/**
 * Resolve a subchannel's parent channel ID from its kind:9007 create event
 * (which carries a `parent` tag). Returns the parent UUID or null if the
 * channel has no parent linkage (i.e. it is a top-level TLC).
 *
 * The parent linkage lives on the 9007 create event, NOT on kind:39000
 * metadata. getChannelMetadata will NOT reliably return parentChannelId.
 */
export async function getParentChannelId(
  ctx: ChannelOpsContext,
  channelId: string,
): Promise<string | null> {
  const events = await query(ctx, [{ kinds: [KIND_CREATE_GROUP], '#h': [channelId], limit: 5 }]);
  for (const ev of events) {
    const parent = tagValue(ev, TAG_PARENT);
    if (parent) return parent;
  }
  // Fallback: check if metadata has the parent tag.
  const meta = await getChannelMetadata(ctx, channelId);
  if (meta?.parentChannelId) return meta.parentChannelId;
  return null;
}

/**
 * Pubkey that signed a channel's immutable kind:9007 create event.
 *
 * This is the identity the relay authorizes a channel's lifecycle commands
 * against (kind:9002 archive in particular). A corner is created and signed by
 * exactly ONE agent, while `listSubchannels` lists every child of a Room
 * regardless of who opened it — so a daemon that discovers a corner must read
 * this before taking any lifecycle action on it.
 *
 * `null` means the create event is not readable, which is deliberately a
 * different answer from "someone else created it": a caller must not treat an
 * unreadable create event as proof of foreign ownership.
 */
export async function getChannelCreator(
  ctx: ChannelOpsContext,
  channelId: string,
): Promise<string | null> {
  const events = await query(ctx, [{ kinds: [KIND_CREATE_GROUP], '#h': [channelId], limit: 5 }]);
  const create = events
    .filter((event) => tagValue(event, 'h') === channelId)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))[0];
  return create?.pubkey ?? null;
}

/** Resolve a channel's community UUID from its kind:9007 create event. */
export async function getChannelCommunityId(
  ctx: ChannelOpsContext,
  channelId: string,
): Promise<string | null> {
  const events = await query(ctx, [{ kinds: [KIND_CREATE_GROUP], '#h': [channelId], limit: 5 }]);
  for (const event of events) {
    const communityId = tagValue(event, TAG_COMMUNITY);
    if (communityId) return communityId;
  }
  const metadata = await getChannelMetadata(ctx, channelId);
  return metadata?.communityId ?? null;
}

/** Resolve the immutable repository binding carried by a Room's create event. */
export async function getChannelRepositoryBinding(
  ctx: ChannelOpsContext,
  channelId: string,
): Promise<RepositoryBinding | null> {
  const events = await query(ctx, [{ kinds: [KIND_CREATE_GROUP], '#h': [channelId], limit: 20 }]);
  for (const event of events.sort((a, b) => a.created_at - b.created_at)) {
    const key = tagValue(event, 'repo-key');
    const name = tagValue(event, 'repo-name');
    const scope = tagValue(event, 'repo-scope');
    if (!key || !name || (scope !== 'local' && scope !== 'remote')) continue;
    const remote = tagValue(event, 'repo-remote');
    const installation = tagValue(event, 'repo-github-installation');
    const githubInstallationId =
      installation && /^\d+$/.test(installation) ? Number(installation) : undefined;
    if (scope === 'remote' && !remote) continue;
    return {
      key,
      name,
      localOnly: scope === 'local',
      ...(remote ? { remote } : {}),
      ...(githubInstallationId && Number.isSafeInteger(githubInstallationId)
        ? { githubInstallationId }
        : {}),
    };
  }
  return null;
}
