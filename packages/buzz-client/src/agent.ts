/**
 * First-class agent records.
 *
 * An agent owns a distinct Nostr keypair and self-signs a kind:9 declaration
 * inside a community. The self-signature is the durable identity boundary the
 * merge gate can query: role mistakes never turn that key into a human approver.
 */
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { communityChannels, communityMembers, getCommunity, inviteTokenHash } from './community.js';
import { publishEvent, queryEvents } from './http.js';
import {
  KIND_AGENT_SOUL,
  KIND_COMMUNITY_INVITE,
  KIND_STREAM_MESSAGE,
  TAG_AGENT,
  TAG_AGENT_PAIRING,
  TAG_AGENT_SOUL,
  TAG_COMMUNITY,
} from './kinds.js';
import { tagValue, tagValues } from './parse.js';
import { query } from './query.js';
import { RoomViewClient, RoomViewHttpError } from './room-view.js';
import {
  deriveAgentDisplayName,
  fallbackAgentName,
  isReasonableAgentName,
} from './display-name.js';
import { getDirectMessage } from './direct-message.js';
import { newUuid } from './uuid.js';
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
const KIND_NOSTR_PROFILE = 0;
let lastSoulTimestamp = 0;

function now(): number {
  return Math.floor(Date.now() / 1000);
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
 * A Nostr key that has ever self-authored a kind:0 profile is a human key.
 * Agent records are irreversible security markers, so fail before publishing
 * one rather than letting a cosmetic profile and an agent identity share the
 * same signer forever.
 */
async function assertAgentKeyHasNoHumanProfile(
  ctx: ChannelOpsContext,
  pubkey: string,
): Promise<void> {
  const events = await query(ctx, [{ kinds: [KIND_NOSTR_PROFILE], authors: [pubkey], limit: 20 }]);
  if (
    events.some(
      (event) => event.kind === KIND_NOSTR_PROFILE && event.pubkey === pubkey && verifyEvent(event),
    )
  ) {
    throw new Error(
      `cannot use human identity ${pubkey} as an agent: it already has a kind:0 profile; ` +
        'run the Members-page pairing command again so Beeline mints a fresh agent keypair',
    );
  }
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

/**
 * Keep an agent's one current declaration aligned with its live persona.
 *
 * The declaration is the shared identity record consumed by Room readers,
 * corner surfaces, and mention routing. Reuse its agent id when refreshing it
 * and publish only when the display name actually changed (or is missing).
 */
export async function syncAgentDeclaration(
  ctx: ChannelOpsContext,
  communityId: string,
  options: CreateAgentOptions = {},
): Promise<Agent> {
  const displayName = deriveAgentDisplayName(
    options.displayName ?? ctx.identity.name,
    ctx.identity.publicKey,
  );
  const existing = (await listAgentIdentities(ctx, communityId))
    .filter((agent) => agent.pubkey === ctx.identity.publicKey)
    .sort(
      (left, right) => right.createdAt - left.createdAt || right.raw.id.localeCompare(left.raw.id),
    )[0];
  if (existing?.displayName === displayName) return existing;

  return createAgentRecord(ctx, communityId, {
    agentId: existing?.agentId ?? options.agentId,
    displayName,
    ...((options.soul ?? existing?.soul) ? { soul: options.soul ?? existing?.soul } : {}),
    ...((options.personality ?? existing?.personality)
      ? { personality: options.personality ?? existing?.personality }
      : {}),
    ...((options.avatar ?? existing?.avatar) ? { avatar: options.avatar ?? existing?.avatar } : {}),
  });
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
  await assertAgentKeyHasNoHumanProfile(ctx, ctx.identity.publicKey);

  const agentId = options.agentId ?? newUuid();
  // Deliberate naming, not silent masking: an authored name passes through,
  // a system-generic marker (`beeline-agent`, legacy `buzzy-agent`) resolves
  // to the stable pubkey-derived seed name — distinct per agent — and only a
  // genuinely absent name takes that same deterministic fallback.
  const displayName = deriveAgentDisplayName(
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
      // Pairing is redeemed by a brand-new key that is not a Workspace member
      // yet. Keep the marker on the same globally resolvable record kind as a
      // person invite; a Workspace-scoped kind:9 marker is invisible to that
      // key on the production relay.
      kind: KIND_COMMUNITY_INVITE,
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

interface AgentPairingMarker {
  event: NostrEvent;
  communityId: string;
  expiresAt: number;
}

function parseAgentPairingMarker(event: NostrEvent, tokenHash: string): AgentPairingMarker | null {
  if (
    !verifyEvent(event) ||
    (event.kind !== KIND_COMMUNITY_INVITE && event.kind !== KIND_STREAM_MESSAGE)
  ) {
    return null;
  }
  const communityId = tagValue(event, 'h');
  const expiresAt = Number(tagValue(event, 'expiration'));
  if (
    !communityId ||
    tagValue(event, TAG_COMMUNITY) !== communityId ||
    tagValue(event, 'd') !== tokenHash ||
    !tagValues(event, 't').includes(TAG_AGENT_PAIRING) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= event.created_at
  ) {
    return null;
  }
  return { event, communityId, expiresAt };
}

/**
 * Resolve current global markers first, then scan legacy Workspace-scoped
 * kind:9 markers by their indexed pairing tag. This mirrors findCommunityInvite:
 * token-only redemption cannot know the legacy marker's #h coordinate.
 */
async function findAgentPairingMarker(
  ctx: ChannelOpsContext,
  tokenHash: string,
): Promise<AgentPairingMarker | null> {
  const current = await queryEvents(
    ctx.http,
    [
      {
        kinds: [KIND_COMMUNITY_INVITE],
        '#d': [tokenHash],
        '#t': [TAG_AGENT_PAIRING],
        limit: 20,
      },
    ],
    ctx.identity.publicKey,
  );
  const currentMarker = current
    .map((event) => parseAgentPairingMarker(event, tokenHash))
    .find((marker): marker is AgentPairingMarker => marker !== null);
  if (currentMarker) return currentMarker;

  const legacy = await queryEvents(
    ctx.http,
    [{ kinds: [KIND_STREAM_MESSAGE], '#t': [TAG_AGENT_PAIRING], limit: 500 }],
    ctx.identity.publicKey,
  );
  return (
    legacy
      .map((event) => parseAgentPairingMarker(event, tokenHash))
      .find((marker): marker is AgentPairingMarker => marker !== null) ?? null
  );
}

async function matchingAgentPairingRedemptions(
  ctx: ChannelOpsContext,
  tokenHash: string,
): Promise<NostrEvent[]> {
  const events = await query(ctx, [
    { kinds: [KIND_STREAM_MESSAGE], '#pairing': [tokenHash], '#t': [TAG_AGENT], limit: 5 },
  ]);
  return events.filter((event) => tagValue(event, 'pairing') === tokenHash);
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
  const pairing = await findAgentPairingMarker(ctx, tokenHash);
  if (!pairing) {
    throw new Error(
      'pairing code was not found; if the code was created by an older app, regenerate it after updating',
    );
  }
  const { communityId, expiresAt } = pairing;
  if (ctx.identity.publicKey === pairing.event.pubkey) {
    throw new Error(
      "cannot pair the installer's human identity as its own agent; " +
        'run the Members-page pairing command without BUZZ_AGENT_KEY or BUZZ_PRIVATE_KEY so Beeline mints a fresh agent keypair',
    );
  }
  await assertAgentKeyHasNoHumanProfile(ctx, ctx.identity.publicKey);
  const membersBeforeJoin = await communityMembers(ctx, communityId);
  const minterVisibleBeforeJoin = membersBeforeJoin.some(
    (member) => member.pubkey === pairing.event.pubkey,
  );
  let matchingRedemptions = await matchingAgentPairingRedemptions(ctx, tokenHash);
  let ours = matchingRedemptions
    .map(parseAgent)
    .find((agent) => agent?.pubkey === ctx.identity.publicKey);
  if (minterVisibleBeforeJoin && ours) {
    return {
      communityId,
      pairedBy: pairing.event.pubkey,
      agent: ours,
      joined: false,
      attachedRoomIds: [],
    };
  }
  if (minterVisibleBeforeJoin && matchingRedemptions.some((event) => isAgentIdentityEvent(event))) {
    throw new Error('agent pairing code has already been redeemed');
  }
  if (expiresAt <= now()) throw new Error('agent pairing code has expired');
  const wasMember = membersBeforeJoin.some((member) => member.pubkey === ctx.identity.publicKey);
  if (wasMember) {
    throw new Error(
      `cannot pair existing human Workspace member ${ctx.identity.publicKey} as an agent; ` +
        'run the Members-page pairing command again so Beeline mints a fresh agent keypair',
    );
  }
  let joinedForPairing = false;
  let claimedForPairing = false;
  let attachedRoomIds: string[] = [];
  try {
    if (!wasMember) {
      joinedForPairing = true;
      // The server-indexed claim is the single authority boundary that can
      // atomically reserve this code and inherit the minter's current Rooms.
      // A new agent cannot author effective Room membership commands itself:
      // production projects those only from a current Room admin.
      let claim;
      try {
        claim = await new RoomViewClient({
          baseUrl: ctx.http.baseUrl,
          identity: ctx.identity,
        }).claimAgentPairing(code);
      } catch (error) {
        if (error instanceof RoomViewHttpError && error.status === 404) {
          throw new Error('pairing code is not authorized for this Workspace');
        }
        throw error;
      }
      claimedForPairing = true;
      if (claim.workspaceId !== communityId || claim.pairedBy !== pairing.event.pubkey) {
        throw new Error('pairing claim did not match its signed Workspace marker');
      }
      attachedRoomIds = [...claim.attachedRoomIds];
      // Publish the canonical relay membership command from inside. This is
      // what creates the ordinary signed event/projections; the server claim
      // is only the narrow one-shot bootstrap for a private Workspace.
      await setMemberRole(ctx, communityId, ctx.identity.publicKey, 'member', {
        extraTags: [
          ['pairing', tokenHash],
          [TAG_COMMUNITY, communityId],
        ],
      });
    }
    if (joinedForPairing) await waitUntilMember(ctx, communityId, ctx.identity.publicKey);

    // Production hides Workspace projections from an outsider. The signed,
    // unexpired global marker is enough for the relay to authorize this
    // capability-scoped self-join; only after that join can this key verify
    // that the marker's signer is still a current Workspace member. A false
    // signer check removes the just-added membership before failing, so the
    // client-side ordering never weakens the minting authority invariant.
    const membersAfterJoin = await communityMembers(ctx, communityId);
    if (!membersAfterJoin.some((member) => member.pubkey === pairing.event.pubkey)) {
      throw new Error('pairing code minter is not a community member');
    }

    // Agent identity events are Workspace-scoped kind:9 too. Repeat the
    // one-shot check from inside the Workspace before publishing ours.
    matchingRedemptions = await matchingAgentPairingRedemptions(ctx, tokenHash);
    ours = matchingRedemptions
      .map(parseAgent)
      .find((agent) => agent?.pubkey === ctx.identity.publicKey);
    if (ours) {
      return {
        communityId,
        pairedBy: pairing.event.pubkey,
        agent: ours,
        joined: joinedForPairing,
        attachedRoomIds,
      };
    }
    if (matchingRedemptions.some((event) => isAgentIdentityEvent(event))) {
      throw new Error('agent pairing code has already been redeemed');
    }

    const agent = await createAgentRecord(
      ctx,
      communityId,
      { displayName: fallbackAgentName(ctx.identity.publicKey) },
      tokenHash,
    );
    joinedForPairing = false;
    return {
      communityId,
      pairedBy: pairing.event.pubkey,
      agent,
      joined: !wasMember,
      attachedRoomIds,
    };
  } catch (error) {
    // The capability-scoped membership already landed. Any failed authority
    // check or registration must not leave an outsider in the Workspace.
    if (claimedForPairing) await abandonAgentPairing(ctx, communityId, code);
    else if (joinedForPairing) await abandonAgentPairing(ctx, communityId);
    throw error;
  }
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
    // Older overlays split the same human-authored instruction across two
    // fields. Keep both verbatim when reading them so the one-field migration
    // never silently drops an agent's existing direction or character.
    const legacySoul = [
      ...(personality ? [`Personality: ${personality}`] : []),
      ...(intent ? [`Intent: ${intent}`] : []),
    ].join('\n\n');
    const soul = optionalText(content.soul) ?? legacySoul;
    const avatarSeed = optionalText(content.avatarSeed);
    const avatar = optionalHttpUrl(content.avatar);
    if (!name || !soul || !avatarSeed) return null;
    return {
      communityId,
      agentPubkey,
      authoredBy: event.pubkey,
      name,
      soul,
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
  await assertAgentKeyHasNoHumanProfile(ctx, agentPubkey);
  const name = input.name.trim().slice(0, 32);
  const soul = input.soul.trim().slice(0, 1_000);
  const avatarSeed = input.avatarSeed.trim().slice(0, 128);
  if (!name || !soul || !avatarSeed) {
    throw new Error('agent soul fields must not be empty');
  }
  if (!isReasonableAgentName(name)) {
    throw new Error('agent soul name must be a short spoken name');
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
        soul,
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
  options?: AgentSoulAuthorResolution,
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
  const overlayAuthors = [...new Set(soulEvents.map((event) => event.pubkey))];
  const effectiveSoulAuthors = new Map<string, string>();
  await Promise.all(
    overlayAuthors.map(async (author) => {
      if (memberPubkeys.has(author)) {
        effectiveSoulAuthors.set(author, author);
        return;
      }
      if (!options?.resolveCurrentPubkey) return;
      // Succession truth is deliberately supplied by the auth service that
      // owns the ledger. A resolver failure propagates: launching a session
      // without a known, previously configured soul is worse than delaying
      // activation until authorship can be verified.
      const current = await options.resolveCurrentPubkey(author);
      if (memberPubkeys.has(current)) effectiveSoulAuthors.set(author, current);
    }),
  );
  const agentAuthors = new Set(
    (
      await Promise.all(
        [
          ...new Set([...effectiveSoulAuthors].flatMap(([author, current]) => [author, current])),
        ].map(async (pubkey) => ((await isAgentIdentity(ctx, pubkey)) ? pubkey : null)),
      )
    ).filter((pubkey): pubkey is string => pubkey !== null),
  );
  const profiles = new Map<string, AgentSoulProfile>();
  for (const event of soulEvents) {
    const profile = parseAgentSoul(event);
    if (
      !profile ||
      profile.communityId !== communityId ||
      !effectiveSoulAuthors.has(profile.authoredBy) ||
      agentAuthors.has(profile.authoredBy) ||
      agentAuthors.has(effectiveSoulAuthors.get(profile.authoredBy)!)
    ) {
      continue;
    }
    const prior = profiles.get(profile.agentPubkey);
    if (
      !prior ||
      prior.updatedAt < profile.updatedAt ||
      (prior.updatedAt === profile.updatedAt && prior.raw.id.localeCompare(profile.raw.id) < 0)
    ) {
      profiles.set(profile.agentPubkey, profile);
    }
  }
  return agents
    .filter((agent) => memberPubkeys.has(agent.pubkey))
    .map((agent) => {
      const soulProfile = profiles.get(agent.pubkey);
      return soulProfile
        ? {
            ...agent,
            soulProfile,
          }
        : agent;
    });
}

/**
 * Optional key-succession resolution for soul-author checks. The resolver
 * must use the authoritative identity registry; relay projections alone
 * cannot prove that a removed predecessor and a current member are one human.
 */
export interface AgentSoulAuthorResolution {
  /** Resolve an authored key forward to its identity's current device key. */
  resolveCurrentPubkey?: (pubkey: string) => Promise<string>;
}

/**
 * Best-effort undo of this agent's own `redeemAgentPairingCode` registration.
 *
 * Redemption is two irreversible relay writes — the agent self-adds as a
 * Workspace member, then publishes its kind:9 identity record — and the rest
 * of `beeline pair` can still fail after that point. Without an undo the
 * half-created agent stays in the Workspace forever as a permanently-offline
 * ghost with no daemon behind it.
 *
 * The published identity record is an ordinary event and cannot be
 * unpublished, but `listAgents` filters on *current* Workspace membership, so
 * dropping the membership the agent just added is what actually makes the
 * ghost disappear from the app.
 *
 * When the pairing code is available, the authenticated claim endpoint
 * atomically removes every Workspace/Room membership that exact claim created.
 * Older callers fall back to a self-removal — the agent's own key signing
 * kind:9001 for itself — never `removeAgent`, which is an admin action. It
 * never throws because the original pairing failure remains authoritative.
 */
export async function abandonAgentPairing(
  ctx: ChannelOpsContext,
  communityId: string,
  pairingCode?: string,
): Promise<boolean> {
  if (pairingCode) {
    try {
      const abandoned = await new RoomViewClient({
        baseUrl: ctx.http.baseUrl,
        identity: ctx.identity,
      }).abandonAgentPairing(pairingCode);
      if (abandoned.abandoned) return true;
      return false;
    } catch {
      // Retain the existing Workspace-only self-removal below as a best-effort
      // fallback, but report failure so the caller can surface that inherited
      // Room memberships may still need operator cleanup.
      try {
        if (await isMember(ctx, communityId, ctx.identity.publicKey)) {
          await removeMember(ctx, communityId, ctx.identity.publicKey, {
            extraTags: [[TAG_COMMUNITY, communityId]],
          });
          await waitUntilNotMember(ctx, communityId, ctx.identity.publicKey);
        }
      } catch {
        // The original pairing error remains authoritative.
      }
      return false;
    }
  }
  try {
    if (!(await isMember(ctx, communityId, ctx.identity.publicKey))) return true;
    await removeMember(ctx, communityId, ctx.identity.publicKey, {
      extraTags: [[TAG_COMMUNITY, communityId]],
    });
    await waitUntilNotMember(ctx, communityId, ctx.identity.publicKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unlink an agent from every Workspace channel and finally from the Workspace.
 *
 * The Workspace mutation is intentionally last: its disappearance is the
 * paired host's teardown signal, and `listAgents`/the Members screen key
 * off it, not off any one Room's projection.
 *
 * Per-channel cleanup is deliberately best-effort. A Room the agent is a
 * member of is never removed while its own daemon is alive to react, so an
 * OFFLINE/dormant agent is exactly the one most likely to be carrying stale
 * memberships in corners its daemon never got to archive — and this is an
 * admin-performed membership change, not a handshake with that daemon. One
 * straggler channel whose projection never confirms removal (relay lag, or a
 * genuinely orphaned corner) must not block every other channel or the
 * Workspace-level removal that actually makes the agent disappear.
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
  await assertAgentKeyHasNoHumanProfile(ctx, agentPubkey);

  for (const channelId of await communityChannels(ctx, communityId)) {
    try {
      if (!(await isMember(ctx, channelId, agentPubkey))) continue;
      await removeMember(ctx, channelId, agentPubkey, {
        extraTags: [[TAG_COMMUNITY, communityId]],
      });
      await waitUntilNotMember(ctx, channelId, agentPubkey);
    } catch {
      // Best-effort: see the docstring above. Retryable on a later call.
    }
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
  await assertAgentKeyHasNoHumanProfile(ctx, agentPubkey);
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
