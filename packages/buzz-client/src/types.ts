import type { NostrEvent } from '@buzzy/nostr';

/** A keypair used as a client identity. */
export interface Identity {
  /** 32-byte secp256k1 secret key. */
  secretKey: Uint8Array;
  /** 32-byte x-only public key, hex-encoded. */
  publicKey: string;
  /** Optional human label (tests / debugging). */
  name?: string;
}

/** A keypair reserved for an autonomous agent, never a human account. */
export interface AgentIdentity extends Identity {
  readonly entityType: 'agent';
  name: string;
}

/** Relay-backed, self-signed declaration of an agent inside a community. */
export interface Agent {
  agentId: string;
  communityId: string;
  displayName: string;
  pubkey: string;
  /** Optional Phase-2b inputs. This phase stores them but never generates them. */
  soul?: string;
  personality?: string;
  avatar?: string;
  /** Human-authored display overlay. Never grants rights or changes agent identity. */
  soulProfile?: AgentSoulProfile;
  createdAt: number;
  raw: NostrEvent;
}

export interface AgentPairingCode {
  code: string;
  tokenHash: string;
  communityId: string;
  expiresAt: number;
  mintedBy: string;
  event: NostrEvent;
}

export interface RedeemAgentPairingResult {
  communityId: string;
  agent: Agent;
  joined: boolean;
}

export interface AgentSoulInput {
  name: string;
  personality: string;
  avatarSeed: string;
}

export interface AgentSoulProfile extends AgentSoulInput {
  communityId: string;
  agentPubkey: string;
  authoredBy: string;
  updatedAt: number;
  raw: NostrEvent;
}

export interface CreateAgentOptions {
  agentId?: string;
  displayName?: string;
  /** Optional Phase-2b inputs. Callers supply them; the client never synthesizes them. */
  soul?: string;
  personality?: string;
  avatar?: string;
}

/** Minimal WebSocket surface — injectable so RN can supply its own impl. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (ev: unknown) => void,
  ): void;
  removeEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (ev: unknown) => void,
  ): void;
}

export type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
) => WebSocketLike;

/** Result of publishing via the HTTP bridge. */
export interface PublishResult {
  status: number;
  accepted: boolean;
  body: unknown;
}

/** A channel member as projected from kind:39002 tags. */
export interface ChannelMember {
  pubkey: string;
  /** Role when present as a separate `["role", …]` tag on put-user history. */
  role?: string;
}

/** Channel metadata from kind:39000 (best-effort fields). */
export interface ChannelMetadata {
  channelId: string;
  name?: string;
  about?: string;
  archived?: boolean;
  parentChannelId?: string;
  communityId?: string;
  raw?: NostrEvent;
}

export type CommunityRole = 'owner' | 'admin' | 'member';

/** A community is a self-linked NIP-29 group whose membership projects on 39002. */
export interface Community {
  communityId: string;
  name: string;
  createdBy: string;
  ownerPubkey: string;
  createdAt: number;
  raw: NostrEvent;
}

export interface CommunityMember {
  pubkey: string;
  role: CommunityRole;
}

export interface CreateInviteOptions {
  /** Absolute Unix timestamp. Mutually exclusive with expiresInSeconds. */
  expiresAt?: number;
  /** Lifetime from mint time. Defaults to seven days. */
  expiresInSeconds?: number;
}

/** Returned only to the minter. The plaintext token is never published. */
export interface CommunityInvite {
  token: string;
  tokenHash: string;
  communityId: string;
  expiresAt: number;
  mintedBy: string;
  event: NostrEvent;
}

/** Safe projection of an invite event; contains no redeemable plaintext token. */
export interface CommunityInviteRecord {
  tokenHash: string;
  communityId: string;
  expiresAt: number;
  mintedBy: string;
  event: NostrEvent;
}

export interface RedeemInviteResult {
  communityId: string;
  mintedBy: string;
  expiresAt: number;
  joined: boolean;
  alreadyMember: boolean;
}

/** Session-facing event delivered to RigTransport subscribers. */
export type SessionEventKind = 'message' | 'agent-activity' | 'other';

export interface SessionEvent {
  kind: SessionEventKind;
  event: NostrEvent;
  channelId: string;
  content: string;
  pubkey: string;
  createdAt: number;
  id: string;
}

export type SessionEventHandler = (ev: SessionEvent) => void;
export type Unsubscribe = () => void;

/** Options for live subscription / backfill. */
export interface ChannelFilterOpts {
  /** Extra kinds beyond stream messages (default [9]). */
  kinds?: number[];
  limit?: number;
  since?: number;
  until?: number;
}

export interface MessageSubmitOpts {
  /** When set, adds `#p` mention so buzz-acp can treat it as an agent prompt. */
  mentionAgent?: string;
  /** Extra tags to attach (each is a full tag array). */
  extraTags?: string[][];
}

export interface MergeTarget {
  /** `<ownerHex>/<repo>` — matches the git URL path. */
  repo: string;
  /** Full target ref, e.g. `refs/heads/main`. */
  branch: string;
  /** 40-hex commit the target ref is authorized to advance to. */
  tip: string;
}

export interface BuzzClientConfig {
  /**
   * Relay HTTP origin, e.g. `http://127.0.0.1:3010`.
   * WS URL is derived by swapping the scheme (http→ws, https→wss).
   */
  baseUrl: string;
  /**
   * Host header authority the relay bound its deployment community under.
   * Defaults to the host:port of `baseUrl`. Must match NIP-98 `u` in production.
   */
  host?: string;
  /** Client identity (must be set before signed ops). */
  identity: Identity;
  /**
   * WebSocket constructor. Defaults to `globalThis.WebSocket` (Node ≥22 and
   * browsers). React Native should pass its polyfill / `react-native` WS.
   * Choice: prefer the platform global — no `ws` package dependency in core.
   */
  WebSocketImpl?: WebSocketConstructor;
  /** Skip waiting for NIP-42 AUTH when the relay never challenges (rare). */
  skipAuth?: boolean;
  /** Connect timeout for the first WS open + AUTH, ms. */
  connectTimeoutMs?: number;
}
