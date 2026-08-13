/**
 * Channel-scoped Buzz client — the transport the mobile RigTransport adapter sits on.
 *
 * Speaks only to real Buzz (HTTP bridge + WS + signed events). UI-agnostic.
 */
import type { NostrEvent } from '@beeline/nostr';
import { buildMergeApproval } from './approval.js';
import {
  attachAgentToChannel,
  createAgent,
  createAgentPairingCode,
  isAgentIdentity,
  listAgents,
  removeAgent,
  redeemAgentPairingCode,
  setAgentSoul,
} from './agent.js';
import { WRITE_PERMISSION_RESPONSE_TAG, type WritePermissionDecision } from './write-permission.js';
import {
  backfillMessages,
  createChannel,
  createSubchannel,
  getChannelCommunityId as getChannelCommunityIdFn,
  getChannelRepositoryBinding,
  getChannelMetadata,
  getChannelRole,
  getParentChannelId as getParentChannelIdFn,
  isMember,
  listChannelsForPubkey,
  listMembers,
  leaveRoom,
  removeMember,
  removeRoomMember,
  archiveRoom,
  listSubchannels,
  sendMessage,
  setMemberRole,
  waitUntilMember,
  waitUntilNotMember,
  type ChannelRole,
  type ChannelOpsContext,
} from './channel.js';
import {
  attachCommunityMemberToChannel,
  communityChannels,
  communityMembers,
  createCommunity,
  createInvite,
  getCommunity,
  listCommunities,
  repairCommunityRoomMemberships,
  redeemInvite,
} from './community.js';
import { publishEvent, queryEvents, type HttpBridgeOptions } from './http.js';
import { KIND_STREAM_MESSAGE } from './kinds.js';
import { getPersonProfile, listPersonProfiles, setPersonProfile } from './person-profile.js';
import { getDirectMessage, listDirectMessages, resolveDirectMessage } from './direct-message.js';
import { uploadMedia } from './media.js';
import { toSessionEvent } from './parse.js';
import {
  resolveRepositoryRoom,
  resolveRepositoryRoomForHuman,
  type RepositoryRoomResult,
} from './repo-room.js';
import { RelayWs, wsUrlFromHttp } from './ws.js';
import type {
  BuzzClientConfig,
  Agent,
  AgentPairingCode,
  AgentSoulInput,
  AgentSoulProfile,
  CreateAgentOptions,
  ChannelFilterOpts,
  ChannelMember,
  ChannelMetadata,
  DirectMessage,
  Community,
  CommunityInvite,
  CommunityMember,
  CreateInviteOptions,
  Identity,
  MergeTarget,
  MessageSubmitOpts,
  MediaBlob,
  PersonProfile,
  PersonProfileInput,
  PublishResult,
  RedeemInviteResult,
  RedeemAgentPairingResult,
  RepositoryBinding,
  SessionEvent,
  SessionEventHandler,
  Unsubscribe,
} from './types.js';

function hostFromBaseUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  return u.host;
}

export class BuzzClient {
  readonly identity: Identity;
  readonly baseUrl: string;
  readonly host: string;
  private readonly http: HttpBridgeOptions & { identity: Identity };
  private readonly ctx: ChannelOpsContext;
  private readonly config: BuzzClientConfig;
  private ws: RelayWs | null = null;

  constructor(config: BuzzClientConfig) {
    this.config = config;
    this.identity = config.identity;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.host = config.host ?? hostFromBaseUrl(this.baseUrl);
    this.http = {
      baseUrl: this.baseUrl,
      host: this.host,
      identity: this.identity,
      ...(config.batchQueries !== undefined ? { batchQueries: config.batchQueries } : {}),
    };
    this.ctx = { http: this.http, identity: this.identity };
  }

  // ── Connection ──────────────────────────────────────────────────────────

  /** Open a NIP-42-authenticated WS (idempotent). */
  async connect(): Promise<void> {
    if (this.ws?.connected) return;
    this.ws?.close();
    this.ws = new RelayWs({
      wsUrl: wsUrlFromHttp(this.baseUrl),
      identity: this.identity,
      ...(this.config.WebSocketImpl ? { WebSocketImpl: this.config.WebSocketImpl } : {}),
      ...(this.config.skipAuth !== undefined ? { skipAuth: this.config.skipAuth } : {}),
      ...(this.config.connectTimeoutMs !== undefined
        ? { connectTimeoutMs: this.config.connectTimeoutMs }
        : {}),
    });
    await this.ws.connect();
  }

  /** Close the WS if open. */
  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  /** Underlying WS (after connect). */
  get socket(): RelayWs | null {
    return this.ws;
  }

  // ── Channel ops ─────────────────────────────────────────────────────────

  /** Create an open stream channel; returns UUID. */
  createChannel(
    name: string,
    opts?: { parentChannelId?: string; communityId?: string; repository?: RepositoryBinding },
  ): Promise<string> {
    return createChannel(this.ctx, name, opts);
  }

  /** Create or reopen the deterministic private Room for one Workspace member pair. */
  resolveDirectMessage(
    communityId: string,
    otherPubkey: string,
  ): Promise<{ directMessage: DirectMessage; created: boolean }> {
    return resolveDirectMessage(this.ctx, communityId, otherPubkey);
  }

  listDirectMessages(communityId: string): Promise<DirectMessage[]> {
    return listDirectMessages(this.ctx, communityId);
  }

  getDirectMessage(channelId: string): Promise<DirectMessage | null> {
    return getDirectMessage(this.ctx, channelId);
  }

  /** Child channel under a TLC (parent tag convention). */
  createSubchannel(
    parentChannelId: string,
    name: string,
    opts?: { communityId?: string },
  ): Promise<string> {
    return createSubchannel(this.ctx, parentChannelId, name, opts);
  }

  /**
   * Add/set a member role (kind:9000). Publish ok ≠ effect —
   * follow with `waitUntilMember` or `assertMember`.
   */
  async addMember(
    channelId: string,
    targetPubkey: string,
    role: 'owner' | 'admin' | 'member' = 'member',
  ): Promise<PublishResult> {
    const dm = await getDirectMessage(this.ctx, channelId);
    if (dm && !dm.participants.includes(targetPubkey)) {
      throw new Error('direct messages cannot add a third member');
    }
    return setMemberRole(this.ctx, channelId, targetPubkey, role);
  }

  /** Remove a member (kind:9001). Publish ok is followed by projection checks by callers. */
  async removeMember(channelId: string, targetPubkey: string): Promise<PublishResult> {
    if (await getDirectMessage(this.ctx, channelId)) {
      throw new Error('direct-message membership is immutable');
    }
    return removeMember(this.ctx, channelId, targetPubkey);
  }

  listMembers(channelId: string): Promise<ChannelMember[]> {
    return listMembers(this.ctx, channelId);
  }

  getChannelRole(channelId: string, pubkey = this.identity.publicKey): Promise<ChannelRole | null> {
    return getChannelRole(this.ctx, channelId, pubkey);
  }

  /** Remove another member after proving this identity has sufficient Room authority. */
  removeRoomMember(channelId: string, targetPubkey: string): Promise<void> {
    return removeRoomMember(this.ctx, channelId, targetPubkey);
  }

  /** Remove this normal member's own Room membership. */
  leaveRoom(channelId: string): Promise<void> {
    return leaveRoom(this.ctx, channelId);
  }

  /** Archive a top-level Room through the explicit human-admin path. */
  archiveRoom(channelId: string): Promise<void> {
    return archiveRoom(this.ctx, channelId);
  }

  isMember(channelId: string, pubkey: string): Promise<boolean> {
    return isMember(this.ctx, channelId, pubkey);
  }

  /** Assert 39002 lists the member; throws if not within timeout. */
  waitUntilMember(
    channelId: string,
    pubkey: string,
    opts?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<void> {
    return waitUntilMember(this.ctx, channelId, pubkey, opts);
  }

  /** Assert 39001/39002 no longer list the member. */
  waitUntilNotMember(
    channelId: string,
    pubkey: string,
    opts?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<void> {
    return waitUntilNotMember(this.ctx, channelId, pubkey, opts);
  }

  /** Channels where this identity is listed on 39002. */
  listMyChannels(): Promise<{ channelId: string; event: NostrEvent }[]> {
    return listChannelsForPubkey(this.ctx, this.identity.publicKey);
  }

  getChannelMetadata(channelId: string): Promise<ChannelMetadata | null> {
    return getChannelMetadata(this.ctx, channelId);
  }

  listSubchannels(parentChannelId: string): Promise<string[]> {
    return listSubchannels(this.ctx, parentChannelId);
  }

  /** Resolve parent channel ID from the 9007 create event. */
  async getParentChannelId(channelId: string): Promise<string | null> {
    return getParentChannelIdFn(this.ctx, channelId);
  }

  /** Resolve optional community linkage from the channel create event. */
  getChannelCommunityId(channelId: string): Promise<string | null> {
    return getChannelCommunityIdFn(this.ctx, channelId);
  }

  getChannelRepositoryBinding(channelId: string): Promise<RepositoryBinding | null> {
    return getChannelRepositoryBinding(this.ctx, channelId);
  }

  // ── Community ops ───────────────────────────────────────────────────────

  createCommunity(name: string): Promise<string> {
    return createCommunity(this.ctx, name);
  }

  getCommunity(communityId: string): Promise<Community | null> {
    return getCommunity(this.ctx, communityId);
  }

  /**
   * Communities for any pubkey; defaults to this client's restored identity.
   * Self-listing also repairs missing direct Room projections for human members.
   */
  async listCommunities(pubkey = this.identity.publicKey): Promise<Community[]> {
    const communities = await listCommunities(this.ctx, pubkey);
    if (pubkey !== this.identity.publicKey) return communities;
    for (const community of communities) {
      await repairCommunityRoomMemberships(this.ctx, community.communityId);
    }
    return communities;
  }

  communityChannels(communityId: string): Promise<string[]> {
    return communityChannels(this.ctx, communityId);
  }

  communityMembers(communityId: string): Promise<CommunityMember[]> {
    return communityMembers(this.ctx, communityId);
  }

  /** Restore any missing direct Room projections for this human Workspace member. */
  repairCommunityRoomMemberships(communityId: string): Promise<string[]> {
    return repairCommunityRoomMemberships(this.ctx, communityId);
  }

  /** Place one existing Workspace member into one Room without elevating their role. */
  attachCommunityMemberToChannel(
    channelId: string,
    memberPubkey: string,
    communityId: string,
  ): Promise<{ joined: boolean; membershipSince: number }> {
    return attachCommunityMemberToChannel(this.ctx, channelId, memberPubkey, communityId);
  }

  createInvite(communityId: string, options?: CreateInviteOptions): Promise<CommunityInvite> {
    return createInvite(this.ctx, communityId, options);
  }

  redeemInvite(token: string): Promise<RedeemInviteResult> {
    return redeemInvite(this.ctx, token);
  }

  // ── Cosmetic identity ops ─────────────────────────────────────────────

  getPersonProfile(
    communityId: string,
    pubkey = this.identity.publicKey,
  ): Promise<PersonProfile | null> {
    return getPersonProfile(this.ctx, communityId, pubkey);
  }

  listPersonProfiles(communityId: string, pubkeys: string[]): Promise<PersonProfile[]> {
    return listPersonProfiles(this.ctx, communityId, pubkeys);
  }

  setPersonProfile(communityId: string, input: PersonProfileInput): Promise<PersonProfile> {
    return setPersonProfile(this.ctx, communityId, input);
  }

  uploadMedia(bytes: Uint8Array, mimeType: string): Promise<MediaBlob> {
    return uploadMedia(this.http, bytes, mimeType);
  }

  // ── Agent entity ops ───────────────────────────────────────────────────

  /** Register this client's key as a self-signed agent in a community. */
  createAgent(communityId: string, options?: CreateAgentOptions): Promise<Agent> {
    return createAgent(this.ctx, communityId, options);
  }

  listAgents(communityId: string): Promise<Agent[]> {
    return listAgents(this.ctx, communityId);
  }

  /** Unlink one agent from all Workspace channels and stop its paired host runtime. */
  removeAgent(communityId: string, agentPubkey: string): Promise<void> {
    return removeAgent(this.ctx, communityId, agentPubkey);
  }

  /** Lightweight in-app invite for one already-linked agent and one Room. */
  attachAgentToChannel(
    channelId: string,
    agentPubkey: string,
    communityId?: string,
  ): Promise<{ joined: boolean; membershipSince: number }> {
    return attachAgentToChannel(this.ctx, channelId, agentPubkey, communityId);
  }

  createAgentPairingCode(
    communityId: string,
    expiresInSeconds?: number,
  ): Promise<AgentPairingCode> {
    return createAgentPairingCode(this.ctx, communityId, expiresInSeconds);
  }

  redeemAgentPairingCode(code: string): Promise<RedeemAgentPairingResult> {
    return redeemAgentPairingCode(this.ctx, code);
  }

  resolveRepositoryRoom(
    communityId: string,
    repository: RepositoryBinding,
    pairedBy: string,
    mergeWorkerPubkey?: string,
  ): Promise<RepositoryRoomResult> {
    return resolveRepositoryRoom(this.ctx, communityId, repository, pairedBy, mergeWorkerPubkey);
  }

  resolveRepositoryRoomForHuman(
    communityId: string,
    repository: RepositoryBinding,
  ): Promise<RepositoryRoomResult> {
    return resolveRepositoryRoomForHuman(this.ctx, communityId, repository);
  }

  setAgentSoul(
    communityId: string,
    agentPubkey: string,
    soul: AgentSoulInput,
  ): Promise<AgentSoulProfile> {
    return setAgentSoul(this.ctx, communityId, agentPubkey, soul);
  }

  /** Security classification used by gate services; independent of channel role. */
  isAgentIdentity(pubkey = this.identity.publicKey): Promise<boolean> {
    return isAgentIdentity(this.ctx, pubkey);
  }

  // ── Messaging ───────────────────────────────────────────────────────────

  /** Send a kind:9 message (HTTP bridge). */
  messageSubmit(channelId: string, text: string, opts?: MessageSubmitOpts): Promise<NostrEvent> {
    return sendMessage(this.ctx, channelId, text, opts);
  }

  /** @deprecated Work now starts from an agent-originated write permission request. */
  startAgentWork(channelId: string, text: string, agentPubkey: string): Promise<NostrEvent> {
    return sendMessage(this.ctx, channelId, text, {
      mentionAgent: agentPubkey,
      extraTags: [['t', 'buzz-agent-request']],
    });
  }

  /** Human response to one agent-originated write request; grants no role or merge authority. */
  respondToWritePermission(
    channelId: string,
    permissionId: string,
    requestId: string,
    agentPubkey: string,
    decision: WritePermissionDecision,
  ): Promise<NostrEvent> {
    return sendMessage(
      this.ctx,
      channelId,
      decision === 'allow' ? 'Allowed editing.' : 'Editing denied.',
      {
        mentionAgent: agentPubkey,
        extraTags: [
          ['t', WRITE_PERMISSION_RESPONSE_TAG],
          ['permission', permissionId],
          ['request', requestId],
          ['decision', decision],
        ],
      },
    );
  }

  /**
   * Publish a body-style agent-activity event (kind:9, #t=agent-activity).
   * Used by tests (and later the agent body) to fan out session/update frames.
   */
  publishAgentActivity(channelId: string, content: string): Promise<NostrEvent> {
    return sendMessage(this.ctx, channelId, content, { agentActivity: true });
  }

  /** HTTP backfill of channel stream messages, oldest-first. */
  sessionEventsBackfill(channelId: string, opts?: ChannelFilterOpts): Promise<SessionEvent[]> {
    return backfillMessages(this.ctx, channelId, opts).then((events) =>
      events.map(toSessionEvent).filter((e): e is SessionEvent => e !== null),
    );
  }

  /**
   * Live subscribe over WS: yields human messages and agent-activity in arrival
   * order (sessionEventsSubscribe for RigTransport).
   *
   * Requires `await connect()` first. Uses a dedicated REQ on this client's socket.
   */
  async sessionEventsSubscribe(
    channelId: string,
    handler: SessionEventHandler,
    opts?: { kinds?: number[] },
  ): Promise<Unsubscribe> {
    if (!this.ws?.connected) {
      await this.connect();
    }
    const ws = this.ws!;
    const kinds = opts?.kinds ?? [KIND_STREAM_MESSAGE];
    return ws.subscribe([{ kinds, '#h': [channelId] }], (event) => {
      const se = toSessionEvent(event);
      if (se) handler(se);
    });
  }

  /** Low-level publish (already-signed event) via HTTP. */
  publish(event: NostrEvent): Promise<PublishResult> {
    return publishEvent(this.http, event);
  }

  /** Low-level query via HTTP. */
  query(filters: Record<string, unknown>[]): Promise<NostrEvent[]> {
    return queryEvents(this.http, filters, this.identity.publicKey);
  }

  // ── Merge approval ──────────────────────────────────────────────────────

  /**
   * Build a signed merge-approval event (P0 gate shape). Does not publish —
   * call `publish(buildMergeApproval(...))` or `submitMergeApproval`.
   */
  buildMergeApproval(channelId: string, target: MergeTarget): NostrEvent {
    return buildMergeApproval(this.identity, channelId, target);
  }

  /** Sign + publish a merge approval for the given target. */
  async submitMergeApproval(channelId: string, target: MergeTarget): Promise<NostrEvent> {
    const event = this.buildMergeApproval(channelId, target);
    await this.publish(event);
    return event;
  }
}

/** Factory for a client bound to an identity + relay. */
export function createBuzzClient(config: BuzzClientConfig): BuzzClient {
  return new BuzzClient(config);
}
