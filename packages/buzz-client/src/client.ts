/** Compatibility shape implemented by the mobile monolith adapter. */
import type { NostrEvent } from '@beeline/nostr';
import type { SurfaceWatchFilter } from './room-view.js';
import type { ChannelRole } from './channel.js';
import type {
  AgentPairingCode,
  AgentSoulInput,
  AgentSoulProfile,
  AgentModelConfig,
  AgentModelConfigInput,
  ChannelMetadata,
  Community,
  CommunityInvite,
  CommunityMember,
  CreateInviteOptions,
  MediaBlob,
  PersonProfile,
  PersonProfileInput,
  PublishResult,
  RepositoryBinding,
  Unsubscribe,
} from './types.js';
export interface BuzzClient {
  /** Close the WS if open. */
  disconnect(): void;
  /** Create an open stream channel; returns UUID. */
  createChannel(
    name: string,
    opts?: {
      channelId?: string;
      visibility?: string;
      parentChannelId?: string;
      communityId?: string;
      repository?: RepositoryBinding;
      onPublished?: (channelId: string) => void;
      extraTags?: string[][];
      mirrorCommunityMembers?: boolean;
    },
  ): Promise<string>;
  /**
   * Add/set a member role (kind:9000). Publish ok ≠ effect —
   * follow with `waitUntilMember` or `assertMember`.
   */
  addMember(
    channelId: string,
    targetPubkey: string,
    role?: 'owner' | 'admin' | 'member' | 'spectator',
  ): Promise<PublishResult>;
  /** Remove a member (kind:9001). Publish ok is followed by projection checks by callers. */
  removeMember(channelId: string, targetPubkey: string): Promise<PublishResult>;
  /** Rename a top-level Room through the explicit human-admin path. */
  renameChannel(channelId: string, name: string): Promise<ChannelMetadata>;
  setChannelVisibility(
    channelId: string,
    visibility: 'public' | 'invite-only',
  ): Promise<ChannelMetadata>;
  /** Assert 39002 lists the member; throws if not within timeout. */
  waitUntilMember(
    channelId: string,
    pubkey: string,
    opts?: {
      timeoutMs?: number;
      intervalMs?: number;
    },
  ): Promise<void>;
  /** Assert the current 39001/39002 projections expose this exact role. */
  waitUntilMemberRole(
    channelId: string,
    pubkey: string,
    role: ChannelRole,
    opts?: {
      timeoutMs?: number;
      intervalMs?: number;
    },
  ): Promise<void>;
  createCommunity(
    name: string,
    opts?: {
      communityId?: string;
      visibility?: Community['visibility'];
    },
  ): Promise<string>;
  getCommunity(communityId: string): Promise<Community | null>;
  setCommunityAvatar(communityId: string, avatarUrl: string): Promise<Community>;
  renameCommunity(communityId: string, name: string): Promise<Community>;
  setCommunityVisibility(
    communityId: string,
    visibility: Community['visibility'],
  ): Promise<Community>;
  /**
   * Communities for any pubkey; defaults to this client's restored identity.
   * Self-listing also repairs missing direct Room projections for human members.
   *
   * With `predecessors` (this identity's key-succession chain, oldest first),
   * self-listing first migrates this key into the Workspaces and top-level
   * Rooms its predecessors held — at their role — so a replaced device key
   * rediscovers everything with zero re-inviting.
   */
  listCommunities(pubkey?: string, predecessors?: readonly string[]): Promise<Community[]>;
  /**
   * Workspace roster with succession-aware role resolution. When no explicit
   * chain is seeded or passed, the identity's predecessors are fetched once
   * per client from the auth service (best-effort, bounded); an unreachable
   * auth service degrades to ordinary role resolution — never throws.
   */
  communityMembers(
    communityId: string,
    opts?: {
      predecessors?: readonly string[];
    },
  ): Promise<CommunityMember[]>;
  createInvite(communityId: string, options?: CreateInviteOptions): Promise<CommunityInvite>;
  getGlobalPersonProfile(pubkey?: string): Promise<PersonProfile | null>;
  getPersonProfile(communityId: string, pubkey?: string): Promise<PersonProfile | null>;
  setGlobalPersonProfile(input: PersonProfileInput): Promise<PersonProfile>;
  uploadMedia(bytes: Uint8Array, mimeType: string): Promise<MediaBlob>;
  /** Unlink one agent from all Workspace channels and stop its paired host runtime. */
  removeAgent(communityId: string, agentPubkey: string): Promise<void>;
  createAgentPairingCode(communityId: string, expiresInSeconds?: number): Promise<AgentPairingCode>;
  setAgentSoul(
    communityId: string,
    agentPubkey: string,
    soul: AgentSoulInput,
  ): Promise<AgentSoulProfile>;
  /** Choose a model/effort for an agent. Applied on that agent's next session (re)activation. */
  setAgentModelConfig(
    communityId: string,
    agentPubkey: string,
    input: AgentModelConfigInput,
  ): Promise<AgentModelConfig>;
  /**
   * Subscribe to opaque filters returned by a paint-ready HTTP surface.
   * Callers may use matching events only as invalidation signals or as input
   * to the narrow live-overlay decoder; this API deliberately exposes no DTO
   * patch operation.
   */
  surfaceSubscribe(
    filters: readonly SurfaceWatchFilter[],
    handler: (event: NostrEvent) => void,
  ): Promise<Unsubscribe>;
}
