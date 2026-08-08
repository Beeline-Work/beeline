/**
 * Channel-scoped Buzz client — the transport the mobile RigTransport adapter sits on.
 *
 * Speaks only to real Buzz (HTTP bridge + WS + signed events). UI-agnostic.
 */
import type { NostrEvent } from '@buzzy/nostr';
import { buildMergeApproval } from './approval.js';
import {
  backfillMessages,
  createChannel,
  createSubchannel,
  getChannelMetadata,
  isMember,
  listChannelsForPubkey,
  listMembers,
  listSubchannels,
  sendMessage,
  setMemberRole,
  waitUntilMember,
  type ChannelOpsContext,
} from './channel.js';
import { publishEvent, queryEvents, type HttpBridgeOptions } from './http.js';
import { KIND_STREAM_MESSAGE } from './kinds.js';
import { toSessionEvent } from './parse.js';
import { RelayWs, wsUrlFromHttp } from './ws.js';
import type {
  BuzzClientConfig,
  ChannelFilterOpts,
  ChannelMember,
  ChannelMetadata,
  Identity,
  MergeTarget,
  MessageSubmitOpts,
  PublishResult,
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
  private readonly http: HttpBridgeOptions;
  private readonly ctx: ChannelOpsContext;
  private readonly config: BuzzClientConfig;
  private ws: RelayWs | null = null;

  constructor(config: BuzzClientConfig) {
    this.config = config;
    this.identity = config.identity;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.host = config.host ?? hostFromBaseUrl(this.baseUrl);
    this.http = { baseUrl: this.baseUrl, host: this.host };
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
  createChannel(name: string, opts?: { parentChannelId?: string }): Promise<string> {
    return createChannel(this.ctx, name, opts);
  }

  /** Child channel under a TLC (parent tag convention). */
  createSubchannel(parentChannelId: string, name: string): Promise<string> {
    return createSubchannel(this.ctx, parentChannelId, name);
  }

  /**
   * Add/set a member role (kind:9000). Publish ok ≠ effect —
   * follow with `waitUntilMember` or `assertMember`.
   */
  addMember(
    channelId: string,
    targetPubkey: string,
    role: 'owner' | 'admin' | 'member' = 'member',
  ): Promise<PublishResult> {
    return setMemberRole(this.ctx, channelId, targetPubkey, role);
  }

  listMembers(channelId: string): Promise<ChannelMember[]> {
    return listMembers(this.ctx, channelId);
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

  // ── Messaging ───────────────────────────────────────────────────────────

  /** Send a kind:9 message (HTTP bridge). */
  messageSubmit(
    channelId: string,
    text: string,
    opts?: MessageSubmitOpts,
  ): Promise<NostrEvent> {
    return sendMessage(this.ctx, channelId, text, opts);
  }

  /**
   * Publish a body-style agent-activity event (kind:9, #t=agent-activity).
   * Used by tests (and later the agent body) to fan out session/update frames.
   */
  publishAgentActivity(channelId: string, content: string): Promise<NostrEvent> {
    return sendMessage(this.ctx, channelId, content, { agentActivity: true });
  }

  /** HTTP backfill of channel stream messages, oldest-first. */
  sessionEventsBackfill(
    channelId: string,
    opts?: ChannelFilterOpts,
  ): Promise<SessionEvent[]> {
    return backfillMessages(this.ctx, channelId, opts).then((events) =>
      events
        .map(toSessionEvent)
        .filter((e): e is SessionEvent => e !== null),
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
