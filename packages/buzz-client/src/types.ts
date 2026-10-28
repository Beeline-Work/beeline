import type { NostrEvent } from '@beeline/nostr';

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

/** Stable Room-level repository identity. Secrets from remote URLs are never retained. */
export interface RepositoryBinding {
  /** SHA-256 identity used to converge clones of the same origin into one Room. */
  key: string;
  /** Human-facing repository name used for a newly-created Room. */
  name: string;
  /** Credential-free canonical origin, absent for a local-only repository. */
  remote?: string;
  /** Local-only bindings deliberately do not converge across machines. */
  localOnly: boolean;
  /** GitHub App installation that grants this Room access. Public, not a credential. */
  githubInstallationId?: number;
}

/** Input for binding (or re-binding) a repository to a Room. */
export interface RoomRepositoryInput {
  /** SHA-256 repository identity (converges clones of the same origin). */
  key: string;
  /** Human-facing repository name. */
  name: string;
  /** Credential-free canonical git remote URL — the source of truth. */
  remote: string;
  /** Optional protected/target branch short name (e.g. "main"). */
  targetBranch?: string;
  /** GitHub App installation selected by the account-owned repo picker. */
  githubInstallationId?: number;
  /** Room receives GitHub repository activity (stars/issues/PRs). Default true. */
  githubEventsEnabled?: boolean;
}

/**
 * The repository a Room owns, resolved from published Room state.
 *
 * `source` records where the resolution came from: `config` is a mutable,
 * admin-authored room-config event (the Stage-2-writable path); `genesis` is
 * the immutable binding carried on the Room's create event — the migration /
 * compatibility path that keeps every Room paired before room-repo config
 * existed resolving with no republish.
 */
export interface RoomRepository {
  channelId: string;
  communityId?: string;
  binding: RepositoryBinding;
  targetBranch?: string;
  /** Absent means enabled — the shipped default is ON for the three event types. */
  githubEventsEnabled?: boolean;
  /** GitHub's repository-level auto-merge toggle; absent when it is not yet known. */
  allowAutoMerge?: boolean;
  source: 'config' | 'genesis';
  /** Room admin who authored a `config` binding; absent for `genesis`. */
  authoredBy?: string;
  updatedAt?: number;
  raw?: NostrEvent;
}

export interface AgentSoulInput {
  name: string;
  /** Human-authored instructions supplied to the agent as session-scoped instructions. */
  soul: string;
  avatarSeed: string;
  /** Optional relay-media URL. Cosmetic only and human-authored. */
  avatar?: string;
}

export interface AgentSoulProfile extends AgentSoulInput {
  communityId: string;
  agentPubkey: string;
  authoredBy: string;
  updatedAt: number;
  raw: NostrEvent;
}

/**
 * One portable model/effort/mode axis as advertised by an ACP runtime's
 * `session/new` `configOptions`. `category` is harness-defined (`model`,
 * `thought_level`, `effort`, `reasoning_effort`, `mode`, ...); only the first
 * four are ever exposed to a picker — see `ALLOWED_AGENT_MODEL_CONFIG_CATEGORIES`.
 */
export interface AgentModelConfigOption {
  /** The `configId` passed back to `session/set_config_option`. */
  id: string;
  category: string;
  currentValue?: string;
  /** `description` is the harness's note; for an alias it names the model it runs. */
  options: Array<{ id: string; name?: string; description?: string }>;
}

export interface AgentModelConfigInput {
  fastMode?: boolean;
  /** The chosen `model` option's id. Absent leaves the current model choice alone. */
  model?: string;
  /**
   * The chosen effort/thought-level option's id. `null` intentionally clears
   * the prior human selection, allowing the next session to use the selected
   * model's own default rather than inheriting an incompatible effort.
   */
  effort?: string | null;
}

/** A persisted selection never carries an explicit clear marker. */
export interface AgentModelConfig {
  model?: string;
  effort?: string;
  communityId: string;
  agentPubkey: string;
  authoredBy: string;
  updatedAt: number;
  raw: NostrEvent;
}

/** Global kind:0, self-authored cosmetic metadata for a human identity. */
export interface PersonProfile {
  /** Present only when a legacy Workspace-scoped profile supplied the fallback. */
  communityId?: string;
  pubkey: string;
  name?: string;
  handle?: string;
  avatar?: string;
  /** Self-authored NIP-05 identifier (name@domain). Unverified until resolved against the domain. */
  nip05?: string;
  updatedAt: number;
  raw: NostrEvent;
}

export interface PersonProfileInput {
  /** Empty removes the display name. Absent preserves the current name. */
  name?: string;
  /** Empty removes the global handle. Absent preserves the current handle. */
  handle?: string;
  /** Empty removes the custom image. Absent preserves the current image. */
  avatar?: string;
  /** Empty removes the NIP-05 identifier. Absent preserves the current one. */
  nip05?: string;
}

/** Relay media upload response (Blossom blob descriptor). */
export interface MediaBlob {
  url: string;
  sha256: string;
  size: number;
  type?: string;
  uploaded?: number;
  dim?: string;
  blurhash?: string;
  thumb?: string;
}

export type { AttachmentReference } from './attachment.js';

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
  visibility?: 'public' | 'invite-only';
  parentChannelId?: string;
  communityId?: string;
  raw?: NostrEvent;
}

/** Immutable create-event binding for a private two-member Room. */
export interface DirectMessage {
  channelId: string;
  communityId: string;
  participants: [string, string];
  createdBy: string;
  createdAt: number;
  raw: NostrEvent;
}

export type CommunityRole = 'owner' | 'admin' | 'member' | 'spectator';

/** A community is a self-linked NIP-29 group whose membership projects on 39002. */
export interface Community {
  communityId: string;
  name: string;
  /** Optional owner/admin-managed image URL for this community. */
  avatar?: string;
  visibility: 'public' | 'invite-only';
  /** Role of the pubkey used to list this Workspace, when known. */
  viewerRole?: CommunityRole;
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
export type Unsubscribe = () => void;
