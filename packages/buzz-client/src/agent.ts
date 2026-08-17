/**
 * First-class agent records.
 *
 * An agent owns a distinct Nostr keypair and self-signs a kind:9 declaration
 * inside a community. The self-signature is the durable identity boundary the
 * merge gate can query: role mistakes never turn that key into a human approver.
 */
import { bytesToHex } from '@noble/hashes/utils.js';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { communityChannels, communityMembers, getCommunity, inviteTokenHash } from './community.js';
import { publishEvent } from './http.js';
import {
  KIND_AGENT_SOUL,
  KIND_STREAM_MESSAGE,
  TAG_AGENT,
  TAG_AGENT_PAIRING,
  TAG_AGENT_SOUL,
  TAG_COMMUNITY,
} from './kinds.js';
import { tagValue, tagValues } from './parse.js';
import { query } from './query.js';
import { fallbackAgentName, isSingleWordAgentName, resolveAgentName } from './display-name.js';
import { getDirectMessage } from './direct-message.js';
import type {
  Agent,
  AgentPairingCode,
  AgentSoulInput,
  AgentSoulProfile,
  CreateAgentOptions,
  RedeemAgentPairingResult,
} from './types.js';
import {
  getChannelCommunityId,
  isMember,
  removeMember,
  setMemberRole,
  waitUntilMember,
  waitUntilNotMember,
  type ChannelOpsContext,
} from './channel.js';

const DEFAULT_PAIRING_TTL_SECONDS = 10 * 60;
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
let lastSoulTimestamp = 0;

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

function optionalHttpUrl(value: unknown): string | undefined {
  const text = optionalText(value);
  return text && text.length <= 2048 && /^https?:\/\//i.test(text) ? text : undefined;
}

function randomPairingCode(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let value = '';
  for (const byte of bytes) value += PAIRING_ALPHABET[byte! % PAIRING_ALPHABET.length];
  return `BUZZ-${value.slice(0, 4)}-${value.slice(4)}`;
}

function pairingExpiry(expiresInSeconds: number, createdAt: number): number {
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 3600) {
    throw new Error('pairing lifetime must be between 60 and 3600 seconds');
  }
  return createdAt + expiresInSeconds;
}

function soulKey(communityId: string, agentPubkey: string): string {
  return `${communityId}:${agentPubkey}`;
}

function nextSoulTimestamp(): number {
  lastSoulTimestamp = Math.max(now(), lastSoulTimestamp + 1);
  return lastSoulTimestamp;
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
    ...(optionalHttpUrl(content.avatar) ? { avatar: optionalHttpUrl(content.avatar) } : {}),
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
  return createAgentRecord(ctx, communityId, options);
}

async function createAgentRecord(
  ctx: ChannelOpsContext,
  communityId: string,
  options: CreateAgentOptions = {},
  pairingHash?: string,
): Promise<Agent> {
  const community = await getCommunity(ctx, communityId);
  if (!community) throw new Error(`community not found: ${communityId}`);
  const members = await communityMembers(ctx, communityId);
  if (!members.some((member) => member.pubkey === ctx.identity.publicKey)) {
    throw new Error('agent identity must be a community member before registration');
  }

  const agentId = options.agentId ?? newUuid();
  const displayName = resolveAgentName(
    options.displayName ?? ctx.identity.name,
    ctx.identity.publicKey,
  );
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
        ...(pairingHash ? [['pairing', pairingHash]] : []),
      ],
      content,
    },
    ctx.identity.secretKey,
  );
  await publishEvent(ctx.http, event);
  return parseAgent(event)!;
}

/** Mint a short-lived desktop pairing code. Only its hash is published. */
export async function createAgentPairingCode(
  ctx: ChannelOpsContext,
  communityId: string,
  expiresInSeconds = DEFAULT_PAIRING_TTL_SECONDS,
): Promise<AgentPairingCode> {
  const community = await getCommunity(ctx, communityId);
  if (!community) throw new Error(`community not found: ${communityId}`);
  const members = await communityMembers(ctx, communityId);
  if (!members.some((member) => member.pubkey === ctx.identity.publicKey)) {
    throw new Error('only a community member can pair an agent');
  }
  const createdAt = now();
  const expiresAt = pairingExpiry(expiresInSeconds, createdAt);
  const code = randomPairingCode();
  const tokenHash = inviteTokenHash(code);
  const event = signEvent(
    {
      pubkey: ctx.identity.publicKey,
      created_at: createdAt,
      kind: KIND_STREAM_MESSAGE,
      tags: [
        ['h', communityId],
        ['t', TAG_AGENT_PAIRING],
        ['d', tokenHash],
        [TAG_COMMUNITY, communityId],
        ['expiration', String(expiresAt)],
      ],
      content: '',
    },
    ctx.identity.secretKey,
  );
  await publishEvent(ctx.http, event);
  return { code, tokenHash, communityId, expiresAt, mintedBy: event.pubkey, event };
}

/** Redeem a pairing code under this agent's own key and register its identity. */
export async function redeemAgentPairingCode(
  ctx: ChannelOpsContext,
  rawCode: string,
): Promise<RedeemAgentPairingResult> {
  const code = rawCode.trim().toUpperCase();
  if (!/^BUZZ-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code)) {
    throw new Error('invalid agent pairing code');
  }
  const tokenHash = inviteTokenHash(code);
  const events = await query(ctx, [
    { kinds: [KIND_STREAM_MESSAGE], '#d': [tokenHash], '#t': [TAG_AGENT_PAIRING], limit: 20 },
  ]);
  const pairing = events.find((event) => {
    if (!verifyEvent(event) || event.kind !== KIND_STREAM_MESSAGE) return false;
    const communityId = tagValue(event, 'h');
    const expiresAt = Number(tagValue(event, 'expiration'));
    return Boolean(
      communityId &&
      tagValue(event, TAG_COMMUNITY) === communityId &&
      tagValue(event, 'd') === tokenHash &&
      tagValues(event, 't').includes(TAG_AGENT_PAIRING) &&
      Number.isSafeInteger(expiresAt) &&
      expiresAt > event.created_at,
    );
  });
  if (!pairing) throw new Error('invalid agent pairing code');
  const communityId = tagValue(pairing, 'h')!;
  const expiresAt = Number(tagValue(pairing, 'expiration'));
  const members = await communityMembers(ctx, communityId);
  if (!members.some((member) => member.pubkey === pairing.pubkey)) {
    throw new Error('pairing code minter is not a community member');
  }
  const alreadyPaired = await query(ctx, [
    { kinds: [KIND_STREAM_MESSAGE], '#pairing': [tokenHash], '#t': [TAG_AGENT], limit: 5 },
  ]);
  const matchingRedemptions = alreadyPaired.filter(
    (event) => tagValue(event, 'pairing') === tokenHash,
  );
  const ours = matchingRedemptions
    .map(parseAgent)
    .find((agent) => agent?.pubkey === ctx.identity.publicKey);
  if (ours) return { communityId, pairedBy: pairing.pubkey, agent: ours, joined: false };
  if (matchingRedemptions.some((event) => isAgentIdentityEvent(event))) {
    throw new Error('agent pairing code has already been redeemed');
  }
  if (expiresAt <= now()) throw new Error('agent pairing code has expired');
  const wasMember = members.some((member) => member.pubkey === ctx.identity.publicKey);
  if (!wasMember) {
    await setMemberRole(ctx, communityId, ctx.identity.publicKey, 'member', {
      extraTags: [
        ['pairing', tokenHash],
        [TAG_COMMUNITY, communityId],
      ],
    });
    await waitUntilMember(ctx, communityId, ctx.identity.publicKey);
  }
  const agent = await createAgentRecord(
    ctx,
    communityId,
    { displayName: fallbackAgentName(ctx.identity.publicKey) },
    tokenHash,
  );
  return { communityId, pairedBy: pairing.pubkey, agent, joined: !wasMember };
}

/** Parse a verified display-only soul overlay. Authorization is checked by readers. */
export function parseAgentSoul(event: NostrEvent): AgentSoulProfile | null {
  if (event.kind !== KIND_AGENT_SOUL || !verifyEvent(event)) return null;
  if (!tagValues(event, 't').includes(TAG_AGENT_SOUL)) return null;
  const communityId = tagValue(event, 'h');
  const agentPubkey = tagValue(event, 'p');
  if (!communityId || tagValue(event, TAG_COMMUNITY) !== communityId || !agentPubkey) return null;
  if (tagValue(event, 'd') !== soulKey(communityId, agentPubkey)) return null;
  try {
    const content = JSON.parse(event.content) as Record<string, unknown>;
    const name = optionalText(content.name);
    const personality = optionalText(content.personality);
    const intent = optionalText(content.intent);
    const avatarSeed = optionalText(content.avatarSeed);
    const avatar = optionalHttpUrl(content.avatar);
    if (!name || !personality || !avatarSeed) return null;
    return {
      communityId,
      agentPubkey,
      authoredBy: event.pubkey,
      name,
      personality,
      ...(intent ? { intent } : {}),
      avatarSeed,
      ...(avatar ? { avatar } : {}),
      updatedAt: event.created_at,
      raw: event,
    };
  } catch {
    return null;
  }
}

/** Publish human-authored display metadata; this event carries no authority. */
export async function setAgentSoul(
  ctx: ChannelOpsContext,
  communityId: string,
  agentPubkey: string,
  input: AgentSoulInput,
): Promise<AgentSoulProfile> {
  const members = await communityMembers(ctx, communityId);
  if (!members.some((member) => member.pubkey === ctx.identity.publicKey)) {
    throw new Error('only a community member can edit an agent soul');
  }
  if (await isAgentIdentity(ctx, ctx.identity.publicKey)) {
    throw new Error('agent souls must be authored by a human community member');
  }
  const agents = await listAgentIdentities(ctx, communityId);
  if (!agents.some((agent) => agent.pubkey === agentPubkey)) {
    throw new Error('agent identity not found in community');
  }
  const name = input.name.trim().slice(0, 32);
  const personality = input.personality.trim().slice(0, 280);
  const intent = input.intent.trim().slice(0, 500);
  const avatarSeed = input.avatarSeed.trim().slice(0, 128);
  if (!name || !personality || !avatarSeed) {
    throw new Error('agent soul fields must not be empty');
  }
  if (!isSingleWordAgentName(name)) {
    throw new Error('agent soul name must be one word');
  }
  const avatar = input.avatar?.trim().slice(0, 2048);
  if (avatar && !/^https?:\/\//i.test(avatar)) {
    throw new Error('agent soul avatar must be an http(s) URL');
  }
  const event = signEvent(
    {
      pubkey: ctx.identity.publicKey,
      created_at: nextSoulTimestamp(),
      kind: KIND_AGENT_SOUL,
      tags: [
        ['d', soulKey(communityId, agentPubkey)],
        ['h', communityId],
        ['p', agentPubkey],
        ['t', TAG_AGENT_SOUL],
        [TAG_COMMUNITY, communityId],
      ],
      content: JSON.stringify({
        name,
        personality,
        intent,
        avatarSeed,
        ...(avatar ? { avatar } : {}),
      }),
    },
    ctx.identity.secretKey,
  );
  await publishEvent(ctx.http, event);
  return parseAgentSoul(event)!;
}

async function listAgentIdentities(
  ctx: ChannelOpsContext,
  communityId: string,
  limit = 200,
): Promise<Agent[]> {
  const events = await query(ctx, [
    { kinds: [KIND_STREAM_MESSAGE], '#h': [communityId], '#t': [TAG_AGENT], limit },
  ]);
  const latest = new Map<string, Agent>();
  for (const event of events) {
    const agent = parseAgent(event);
    if (!agent || agent.communityId !== communityId) continue;
    const prior = latest.get(agent.agentId);
    if (!prior || prior.createdAt < agent.createdAt) latest.set(agent.agentId, agent);
  }
  return [...latest.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/** List the latest self-signed agent declaration for each agent ID in a community. */
export async function listAgents(
  ctx: ChannelOpsContext,
  communityId: string,
  limit = 200,
): Promise<Agent[]> {
  const [agents, members] = await Promise.all([
    listAgentIdentities(ctx, communityId, limit),
    communityMembers(ctx, communityId),
  ]);
  // The HTTP bridge does not index #h on parameterized-replaceable kinds.
  // `d` is their canonical key, so fetch exactly one overlay key per agent.
  const soulEvents = (
    await Promise.all(
      agents.map((agent) =>
        query(ctx, [
          { kinds: [KIND_AGENT_SOUL], '#d': [soulKey(communityId, agent.pubkey)], limit: 20 },
        ]),
      ),
    )
  ).flat();
  const memberPubkeys = new Set(members.map((member) => member.pubkey));
  const overlayAuthors = [
    ...new Set(
      soulEvents.map((event) => event.pubkey).filter((pubkey) => memberPubkeys.has(pubkey)),
    ),
  ];
  const agentAuthors = new Set(
    (
      await Promise.all(
        overlayAuthors.map(async (pubkey) =>
          (await isAgentIdentity(ctx, pubkey)) ? pubkey : null,
        ),
      )
    ).filter((pubkey): pubkey is string => pubkey !== null),
  );
  const profiles = new Map<string, AgentSoulProfile>();
  for (const event of soulEvents) {
    const profile = parseAgentSoul(event);
    if (
      !profile ||
      profile.communityId !== communityId ||
      !memberPubkeys.has(profile.authoredBy) ||
      agentAuthors.has(profile.authoredBy)
    ) {
      continue;
    }
    const prior = profiles.get(profile.agentPubkey);
    if (!prior || prior.updatedAt < profile.updatedAt) profiles.set(profile.agentPubkey, profile);
  }
  return agents
    .filter((agent) => memberPubkeys.has(agent.pubkey))
    .map((agent) => {
      const soulProfile = profiles.get(agent.pubkey);
      return soulProfile
        ? {
            ...agent,
            displayName: soulProfile.name,
            personality: soulProfile.personality,
            avatar: soulProfile.avatar ?? agent.avatar,
            soulProfile,
          }
        : agent;
    });
}

/**
 * Unlink an agent from every Workspace channel and finally from the Workspace.
 *
 * The Workspace mutation is intentionally last. Its disappearance is the
 * paired host's teardown signal, so a partial Room-removal failure remains
 * visible and retryable instead of claiming that the agent was deleted.
 */
export async function removeAgent(
  ctx: ChannelOpsContext,
  communityId: string,
  agentPubkey: string,
): Promise<void> {
  if (await isAgentIdentity(ctx, ctx.identity.publicKey)) {
    throw new Error('agents cannot remove agents');
  }
  const agents = await listAgentIdentities(ctx, communityId);
  if (!agents.some((agent) => agent.pubkey === agentPubkey)) {
    throw new Error('agent is not linked to this Workspace');
  }

  for (const channelId of await communityChannels(ctx, communityId)) {
    if (!(await isMember(ctx, channelId, agentPubkey))) continue;
    await removeMember(ctx, channelId, agentPubkey, {
      extraTags: [[TAG_COMMUNITY, communityId]],
    });
    await waitUntilNotMember(ctx, channelId, agentPubkey);
  }

  if (!(await isMember(ctx, communityId, agentPubkey))) return;
  await removeMember(ctx, communityId, agentPubkey, {
    extraTags: [[TAG_COMMUNITY, communityId]],
  });
  await waitUntilNotMember(ctx, communityId, agentPubkey);
}

/** Attach an already-linked Workspace agent identity to one repository Room. */
export async function attachAgentToChannel(
  ctx: ChannelOpsContext,
  channelId: string,
  agentPubkey: string,
  knownCommunityId?: string,
): Promise<{ joined: boolean; membershipSince: number }> {
  if (await getDirectMessage(ctx, channelId)) {
    throw new Error('direct messages cannot add a third member');
  }
  // The invite UI and Workspace supervisor already know their Workspace.
  // Relay create-event discovery is a compatibility fallback, not a required
  // read-after-write dependency for the membership mutation.
  const communityId = knownCommunityId ?? (await getChannelCommunityId(ctx, channelId));
  if (!communityId) throw new Error('agent invites require a Workspace-linked Room');
  if (await isAgentIdentity(ctx, ctx.identity.publicKey)) {
    throw new Error('agents cannot invite other agents to Rooms');
  }
  const agents = await listAgentIdentities(ctx, communityId);
  if (!agents.some((agent) => agent.pubkey === agentPubkey)) {
    throw new Error('agent is not linked to this Workspace');
  }
  if (await isMember(ctx, channelId, agentPubkey)) {
    return { joined: false, membershipSince: now() };
  }
  const membershipSince = now();
  await setMemberRole(ctx, channelId, agentPubkey, 'member', {
    extraTags: [
      [TAG_COMMUNITY, communityId],
      ['agent-invite', agentPubkey],
    ],
  });
  await waitUntilMember(ctx, channelId, agentPubkey);
  return { joined: true, membershipSince };
}

/** True when the pubkey has ever self-signed a valid first-class agent record. */
export async function isAgentIdentity(ctx: ChannelOpsContext, pubkey: string): Promise<boolean> {
  const events = await query(ctx, [
    { kinds: [KIND_STREAM_MESSAGE], authors: [pubkey], '#t': [TAG_AGENT], limit: 50 },
  ]);
  return events.some((event) => event.pubkey === pubkey && hasAgentIdentityMarker(event));
}
