/**
 * First-class agent records.
 *
 * An agent owns a distinct Nostr keypair and self-signs a kind:9 declaration
 * inside a community. The self-signature is the durable identity boundary the
 * merge gate can query: role mistakes never turn that key into a human approver.
 */
import { bytesToHex } from '@noble/hashes/utils.js';
import { signEvent, verifyEvent, type NostrEvent } from '@buzzy/nostr';
import { communityMembers, getCommunity } from './community.js';
import { publishEvent, queryEvents } from './http.js';
import { KIND_STREAM_MESSAGE, TAG_AGENT, TAG_COMMUNITY } from './kinds.js';
import { tagValue, tagValues } from './parse.js';
import type { Agent, CreateAgentOptions } from './types.js';
import type { ChannelOpsContext } from './channel.js';

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function newUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Irreversible security marker: any valid event self-signed with #t=buzz-agent
 * classifies the key as an agent. Extra malformed records cannot hide it.
 */
export function hasAgentIdentityMarker(event: NostrEvent): boolean {
  if (event.kind !== KIND_STREAM_MESSAGE || !verifyEvent(event)) return false;
  return tagValues(event, 't').includes(TAG_AGENT);
}

/** Validate the complete community agent-record shape. */
export function isAgentIdentityEvent(event: NostrEvent): boolean {
  if (!hasAgentIdentityMarker(event)) return false;
  const communityId = tagValue(event, 'h');
  const communityTag = tagValue(event, TAG_COMMUNITY);
  const agentId = tagValue(event, 'd');
  const declaredPubkey = tagValue(event, 'p');
  return Boolean(
    communityId && communityTag === communityId && agentId && declaredPubkey === event.pubkey,
  );
}

/** Parse a verified agent record, including optional Phase-2b metadata. */
export function parseAgent(event: NostrEvent): Agent | null {
  if (!isAgentIdentityEvent(event)) return null;
  const agentId = tagValue(event, 'd')!;
  const communityId = tagValue(event, 'h')!;
  let content: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(event.content) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      content = parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  const displayName = optionalText(content.displayName) ?? tagValue(event, 'name');
  if (!displayName) return null;
  return {
    agentId,
    communityId,
    displayName,
    pubkey: event.pubkey,
    ...(optionalText(content.soul) ? { soul: optionalText(content.soul) } : {}),
    ...(optionalText(content.personality)
      ? { personality: optionalText(content.personality) }
      : {}),
    ...(optionalText(content.avatar) ? { avatar: optionalText(content.avatar) } : {}),
    createdAt: event.created_at,
    raw: event,
  };
}

/**
 * Publish the current identity as an agent in `communityId`.
 * Membership is checked first; the record is always self-signed by the agent.
 */
export async function createAgent(
  ctx: ChannelOpsContext,
  communityId: string,
  options: CreateAgentOptions = {},
): Promise<Agent> {
  const community = await getCommunity(ctx, communityId);
  if (!community) throw new Error(`community not found: ${communityId}`);
  const members = await communityMembers(ctx, communityId);
  if (!members.some((member) => member.pubkey === ctx.identity.publicKey)) {
    throw new Error('agent identity must be a community member before registration');
  }

  const agentId = options.agentId ?? newUuid();
  const displayName = (options.displayName ?? ctx.identity.name ?? 'Agent').trim();
  if (!displayName) throw new Error('agent display name must not be empty');
  const content = JSON.stringify({
    displayName,
    ...(options.soul ? { soul: options.soul } : {}),
    ...(options.personality ? { personality: options.personality } : {}),
    ...(options.avatar ? { avatar: options.avatar } : {}),
  });
  const event = signEvent(
    {
      pubkey: ctx.identity.publicKey,
      created_at: now(),
      kind: KIND_STREAM_MESSAGE,
      tags: [
        ['h', communityId],
        ['t', TAG_AGENT],
        ['d', agentId],
        ['p', ctx.identity.publicKey],
        ['name', displayName],
        [TAG_COMMUNITY, communityId],
      ],
      content,
    },
    ctx.identity.secretKey,
  );
  await publishEvent(ctx.http, event);
  return parseAgent(event)!;
}

/** List the latest self-signed agent declaration for each agent ID in a community. */
export async function listAgents(
  ctx: ChannelOpsContext,
  communityId: string,
  limit = 200,
): Promise<Agent[]> {
  const events = await queryEvents(
    ctx.http,
    [
      {
        kinds: [KIND_STREAM_MESSAGE],
        '#h': [communityId],
        '#t': [TAG_AGENT],
        limit,
      },
    ],
    ctx.identity.publicKey,
  );
  const latest = new Map<string, Agent>();
  for (const event of events) {
    const agent = parseAgent(event);
    if (!agent || agent.communityId !== communityId) continue;
    const prior = latest.get(agent.agentId);
    if (!prior || prior.createdAt < agent.createdAt) latest.set(agent.agentId, agent);
  }
  return [...latest.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/** True when the pubkey has ever self-signed a valid first-class agent record. */
export async function isAgentIdentity(ctx: ChannelOpsContext, pubkey: string): Promise<boolean> {
  const events = await queryEvents(
    ctx.http,
    [{ kinds: [KIND_STREAM_MESSAGE], authors: [pubkey], '#t': [TAG_AGENT], limit: 50 }],
    ctx.identity.publicKey,
  );
  return events.some((event) => event.pubkey === pubkey && hasAgentIdentityMarker(event));
}
