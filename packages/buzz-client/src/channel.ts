/**
 * Channel control-plane ops over the HTTP bridge.
 *
 * Create (9007), put-user (9000), messages (9), membership/metadata read
 * (39002 / 39000). **Never treat an accepted publish as proof of effect** —
 * assert membership via query of 39002 (see assertMember / waitUntilMember).
 */
import { signEvent, type NostrEvent } from '@buzzy/nostr';
import {
  KIND_CHANNEL_MEMBERS,
  KIND_CHANNEL_METADATA,
  KIND_CREATE_GROUP,
  KIND_PUT_USER,
  KIND_STREAM_MESSAGE,
  TAG_AGENT_ACTIVITY,
  TAG_PARENT,
} from './kinds.js';
import { publishEvent, queryEvents, type HttpBridgeOptions } from './http.js';
import {
  parseMembersEvent,
  parseMetadataEvent,
  sortEventsChronological,
  tagValue,
  tagValues,
} from './parse.js';
import type {
  ChannelFilterOpts,
  ChannelMember,
  ChannelMetadata,
  Identity,
  MessageSubmitOpts,
  PublishResult,
} from './types.js';

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

function sign(
  identity: Identity,
  kind: number,
  tags: string[][],
  content = '',
): NostrEvent {
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

export interface ChannelOpsContext {
  http: HttpBridgeOptions;
  identity: Identity;
}

/** Create an open stream channel owned by `identity`. Returns channel UUID. */
export async function createChannel(
  ctx: ChannelOpsContext,
  name: string,
  opts?: { channelId?: string; visibility?: string; parentChannelId?: string },
): Promise<string> {
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
  const event = sign(ctx.identity, KIND_CREATE_GROUP, tags);
  await publishEvent(ctx.http, event);
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
): Promise<string> {
  return createChannel(ctx, name, { parentChannelId });
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
): Promise<PublishResult> {
  const event = sign(ctx.identity, KIND_PUT_USER, [
    ['h', channelId],
    ['p', targetPubkey],
    ['role', role],
  ]);
  return publishEvent(ctx.http, event);
}

/** Query kind:39002 for channel members. Empty if not yet materialized. */
export async function listMembers(
  ctx: ChannelOpsContext,
  channelId: string,
): Promise<ChannelMember[]> {
  const events = await queryEvents(
    ctx.http,
    [{ kinds: [KIND_CHANNEL_MEMBERS], '#d': [channelId], limit: 5 }],
    ctx.identity.publicKey,
  );
  if (events.length === 0) {
    // Some stacks index 39002 under `h` instead of/in addition to `d`.
    const alt = await queryEvents(
      ctx.http,
      [{ kinds: [KIND_CHANNEL_MEMBERS], '#h': [channelId], limit: 5 }],
      ctx.identity.publicKey,
    );
    if (alt.length === 0) return [];
    return parseMembersEvent(alt[0]!);
  }
  return parseMembersEvent(events[0]!);
}

/** True if pubkey appears in the channel's 39002 members list. */
export async function isMember(
  ctx: ChannelOpsContext,
  channelId: string,
  pubkey: string,
): Promise<boolean> {
  const members = await listMembers(ctx, channelId);
  return members.some((m) => m.pubkey === pubkey);
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
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isMember(ctx, channelId, pubkey)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `membership not visible for ${pubkey.slice(0, 12)}… in ${channelId} after ${timeoutMs}ms (assert on 39002, not publish ack)`,
  );
}

/** List channels where `pubkey` appears on a 39002 (#p filter). */
export async function listChannelsForPubkey(
  ctx: ChannelOpsContext,
  pubkey: string,
  limit = 50,
): Promise<{ channelId: string; event: NostrEvent }[]> {
  const events = await queryEvents(
    ctx.http,
    [{ kinds: [KIND_CHANNEL_MEMBERS], '#p': [pubkey], limit }],
    ctx.identity.publicKey,
  );
  const out: { channelId: string; event: NostrEvent }[] = [];
  for (const ev of events) {
    const channelId = tagValue(ev, 'd') ?? tagValue(ev, 'h');
    if (channelId) out.push({ channelId, event: ev });
  }
  return out;
}

/** Read channel metadata (kind:39000). */
export async function getChannelMetadata(
  ctx: ChannelOpsContext,
  channelId: string,
): Promise<ChannelMetadata | null> {
  const events = await queryEvents(
    ctx.http,
    [{ kinds: [KIND_CHANNEL_METADATA], '#d': [channelId], limit: 5 }],
    ctx.identity.publicKey,
  );
  if (events.length === 0) {
    const alt = await queryEvents(
      ctx.http,
      [{ kinds: [KIND_CHANNEL_METADATA], '#h': [channelId], limit: 5 }],
      ctx.identity.publicKey,
    );
    if (alt.length === 0) return null;
    return parseMetadataEvent(alt[0]!);
  }
  return parseMetadataEvent(events[0]!);
}

/**
 * Discover child/subchannels of a parent by scanning recent 9007 creates
 * or metadata with a `parent` tag. Best-effort convention until native links.
 */
export async function listSubchannels(
  ctx: ChannelOpsContext,
  parentChannelId: string,
  limit = 50,
): Promise<string[]> {
  // Query stream messages and creates that might carry parent tag — metadata first.
  const meta = await queryEvents(
    ctx.http,
    [{ kinds: [KIND_CHANNEL_METADATA, KIND_CREATE_GROUP], '#parent': [parentChannelId], limit }],
    ctx.identity.publicKey,
  );
  const ids = new Set<string>();
  for (const ev of meta) {
    const id = tagValue(ev, 'h') ?? tagValue(ev, 'd');
    if (id && id !== parentChannelId) ids.add(id);
  }
  return [...ids];
}

/** Build + publish a kind:9 channel message. */
export async function sendMessage(
  ctx: ChannelOpsContext,
  channelId: string,
  text: string,
  opts?: MessageSubmitOpts & { agentActivity?: boolean },
): Promise<NostrEvent> {
  const tags: string[][] = [['h', channelId]];
  if (opts?.mentionAgent) tags.push(['p', opts.mentionAgent]);
  if (opts?.agentActivity) tags.push(['t', TAG_AGENT_ACTIVITY]);
  if (opts?.extraTags) tags.push(...opts.extraTags);
  const event = sign(ctx.identity, KIND_STREAM_MESSAGE, tags, text);
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

  const events = await queryEvents(ctx.http, [filter], ctx.identity.publicKey);
  return sortEventsChronological(events);
}

/** True if event carries the agent-activity marker. */
export function eventIsAgentActivity(event: NostrEvent): boolean {
  return tagValues(event, 't').includes(TAG_AGENT_ACTIVITY);
}
