import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import { getChannelRepositoryBinding, getChannelRole } from './channel.js';
import type { ChannelOpsContext } from './channel.js';
import { KIND_ROOM_REPOSITORY, TAG_COMMUNITY, TAG_ROOM_REPOSITORY } from './kinds.js';
import { tagValue } from './parse.js';
import { query } from './query.js';
import type { RoomRepository } from './types.js';

function roomRepositoryKey(channelId: string): string {
  return `${TAG_ROOM_REPOSITORY}:${channelId}`;
}

export type NormalizedRoomRepositoryContent = {
  readonly key: string;
  readonly name: string;
  readonly remote: string;
  readonly targetBranch?: string;
  readonly githubInstallationId?: number;
  readonly githubEventsEnabled?: boolean;
};

export function normalizeRoomRepositoryContent(
  value: unknown,
): NormalizedRoomRepositoryContent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const content = value as Record<string, unknown>;
  const key = typeof content.key === 'string' ? content.key.trim() : '';
  const name = typeof content.name === 'string' ? content.name.trim() : '';
  const remote = typeof content.remote === 'string' ? content.remote.trim() : '';
  // A published room-repo binding is remote-first: the remote is the source of
  // truth every daemon can clone. Local-only bindings are non-convergent and
  // stay on the genesis path, so a config event without a remote is invalid.
  if (!key || !name || !remote) return null;
  const targetBranch =
    typeof content.targetBranch === 'string' && content.targetBranch.trim()
      ? content.targetBranch.trim()
      : undefined;
  const githubInstallationId =
    typeof content.githubInstallationId === 'number' &&
    Number.isSafeInteger(content.githubInstallationId) &&
    content.githubInstallationId > 0
      ? content.githubInstallationId
      : undefined;
  const githubEventsEnabled =
    typeof content.githubEventsEnabled === 'boolean' ? content.githubEventsEnabled : undefined;
  return {
    key,
    name,
    remote,
    ...(targetBranch ? { targetBranch } : {}),
    ...(githubInstallationId ? { githubInstallationId } : {}),
    ...(githubEventsEnabled === undefined ? {} : { githubEventsEnabled }),
  };
}

/**
 * Parse a verified, human-authored room-repository config event.
 *
 * Structural validation only; authorization (author is a *current* Room
 * admin/owner) is a reader-side check in {@link getRoomRepository}, exactly
 * like `parseAgentModelConfig` defers member-authorship to `getAgentModelConfig`.
 */
export function parseRoomRepository(event: NostrEvent): RoomRepository | null {
  if (event.kind !== KIND_ROOM_REPOSITORY || !verifyEvent(event)) return null;
  if (tagValue(event, 't') !== TAG_ROOM_REPOSITORY) return null;
  const channelId = tagValue(event, 'h');
  if (!channelId || tagValue(event, 'd') !== roomRepositoryKey(channelId)) return null;
  let content: unknown;
  try {
    content = JSON.parse(event.content);
  } catch {
    return null;
  }
  const normalized = normalizeRoomRepositoryContent(content);
  if (!normalized) return null;
  const { key, name, remote, targetBranch, githubInstallationId, githubEventsEnabled } = normalized;
  const communityId = tagValue(event, TAG_COMMUNITY);
  return {
    channelId,
    ...(communityId ? { communityId } : {}),
    binding: {
      key,
      name,
      remote,
      localOnly: false,
      ...(githubInstallationId ? { githubInstallationId } : {}),
    },
    ...(targetBranch ? { targetBranch } : {}),
    ...(githubEventsEnabled === undefined ? {} : { githubEventsEnabled }),
    source: 'config',
    authoredBy: event.pubkey,
    updatedAt: event.created_at,
    raw: event,
  };
}

export type RoomRepositorySequenceBinding = {
  readonly key: string;
  readonly targetBranch: string;
};

export function advanceRoomRepositorySequence(
  currentBinding: RoomRepositorySequenceBinding | undefined,
  candidate: RoomRepository,
  role: 'owner' | 'admin' | null,
):
  | { readonly accepted: false; readonly binding: RoomRepositorySequenceBinding | undefined }
  | { readonly accepted: true; readonly binding: RoomRepositorySequenceBinding } {
  if (!role) return { accepted: false, binding: currentBinding };
  const candidateTarget = normalizeTargetBranchName(candidate.targetBranch ?? 'main') ?? 'main';
  const ownerOnlySwitch =
    (candidate.raw && tagValue(candidate.raw, 'action') === 'switch-target-branch') ||
    (currentBinding?.key === candidate.binding.key &&
      currentBinding.targetBranch !== candidateTarget);
  if (ownerOnlySwitch && role !== 'owner') {
    return { accepted: false, binding: currentBinding };
  }
  return {
    accepted: true,
    binding: { key: candidate.binding.key, targetBranch: candidateTarget },
  };
}

/**
 * What a repository read is allowed to conclude.
 *
 * `none` and `unverified` used to be the same answer — `null` — and they are
 * not remotely the same fact. A Room whose repository config exists but whose
 * author does not currently read back as an admin is a Room whose binding we
 * could not CONFIRM; reporting that as "this Room has no repository" told an
 * admin their configured Room was unconfigured, and (worse) let
 * `WorkspaceSupervisor.reconcile` silently reclassify a live repository Room
 * as a repo-less one, mid-session, on the strength of one role projection that
 * came back empty under load.
 */
export type RoomRepositoryResolution =
  | { kind: 'repository'; repository: RoomRepository }
  | { kind: 'none' }
  | { kind: 'unverified'; reason: string };

/**
 * Read the current admin-authored room-repository config, if any. Picks the
 * newest event whose author is *currently* a Room admin/owner — a member who
 * has since lost admin can no longer repoint the Room's repository.
 *
 * `unverified` when config events exist but none of their authors currently
 * authorizes. That is deliberately NOT relaxed into "use it anyway": the
 * admin check is the whole authority model here. It is only reported honestly
 * so a caller can wait rather than act on an absence it never established.
 *
 * With `options.resolveCurrentPubkey`, an author also authorizes through its
 * CURRENT successor key — the auth service's room-token authority threads its
 * ledger resolver in so a binding written by a replaced owner key still
 * resolves. See {@link RoomRepositoryAuthorResolution}.
 */
/**
 * Optional key-succession resolution for binding-author checks. Only readers
 * with real ledger access (the auth service) supply one; everyone else gets
 * today's exact behavior unchanged.
 */
export interface RoomRepositoryAuthorResolution {
  /**
   * Resolve one pubkey forward through key succession to its identity's
   * CURRENT device key (the input itself when no succession is recorded).
   * Throw = chain unavailable: the caller degrades to the raw author rather
   * than widening authority on a guess.
   */
  resolveCurrentPubkey?: (pubkey: string) => Promise<string>;
}

/**
 * The keys a binding author may authorize through: itself, plus its current
 * successor key when a resolver is supplied and resolves one. Any resolver
 * failure degrades to the raw author alone — never a silent widening.
 */
async function authorKeysForRoleCheck(
  author: string,
  options?: RoomRepositoryAuthorResolution,
): Promise<string[]> {
  if (!options?.resolveCurrentPubkey) return [author];
  try {
    const current = await options.resolveCurrentPubkey(author);
    return current && current !== author ? [author, current] : [author];
  } catch {
    return [author];
  }
}

export async function readRoomRepositoryConfig(
  ctx: ChannelOpsContext,
  channelId: string,
  options?: RoomRepositoryAuthorResolution,
): Promise<RoomRepositoryResolution> {
  const events = await query(ctx, [
    { kinds: [KIND_ROOM_REPOSITORY], '#d': [roomRepositoryKey(channelId)], limit: 20 },
  ]);
  const candidates = events
    .map(parseRoomRepository)
    .filter((parsed): parsed is RoomRepository => parsed !== null)
    .sort(
      (a, b) =>
        (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
        (a.raw && b.raw ? b.raw.id.localeCompare(a.raw.id) : 0),
    );
  const genesis = await getChannelRepositoryBinding(ctx, channelId);
  let current: RoomRepository | undefined;
  let currentBinding = genesis ? { key: genesis.key, targetBranch: 'main' } : undefined;
  // Validate oldest → newest so an admin cannot omit the action tag (or emit a
  // second cover event) to disguise a same-repository target change. Repo
  // linkage remains admin-capable; changing one repo's canon branch is owner-only.
  for (const candidate of [...candidates].reverse()) {
    let role: 'owner' | 'admin' | null = null;
    for (const authorKey of await authorKeysForRoleCheck(candidate.authoredBy!, options)) {
      const candidateRole = await getChannelRole(ctx, channelId, authorKey);
      if (candidateRole === 'owner' || candidateRole === 'admin') role = candidateRole;
      if (role === 'owner') break;
    }
    const decision = advanceRoomRepositorySequence(currentBinding, candidate, role);
    if (!decision.accepted) continue;
    current = candidate;
    currentBinding = decision.binding;
  }
  if (current) {
    return { kind: 'repository', repository: current };
  }
  if (candidates.length > 0) {
    return {
      kind: 'unverified',
      reason:
        `this Room has ${candidates.length} repository configuration event(s), but none of ` +
        'their authors currently reads back as a Room admin',
    };
  }
  return { kind: 'none' };
}

/**
 * Resolve the repository a Room owns from published Room state: the mutable
 * admin-authored config first, then the immutable genesis binding on the
 * create event (the migration/compat path). Returns `null` for a chat-only
 * Room with no repository — corner-open is gated on this, never crashes.
 */
export async function resolveRoomRepository(
  ctx: ChannelOpsContext,
  channelId: string,
  options?: RoomRepositoryAuthorResolution,
): Promise<RoomRepository | null> {
  const state = await resolveRoomRepositoryState(ctx, channelId, options);
  return state.kind === 'repository' ? state.repository : null;
}

/**
 * The same resolution, with "we could not tell" kept distinct from "there
 * isn't one". Callers that will CHANGE what a Room is on the strength of the
 * answer must use this one; `resolveRoomRepository` stays for the readers that
 * only want the binding.
 *
 * The genesis binding is still consulted for an unverified config: an
 * immutable repository named on the Room's own create event is a fact about
 * the Room that no role projection can invalidate.
 */
export async function resolveRoomRepositoryState(
  ctx: ChannelOpsContext,
  channelId: string,
  options?: RoomRepositoryAuthorResolution,
): Promise<RoomRepositoryResolution> {
  const config = await readRoomRepositoryConfig(ctx, channelId, options);
  if (config.kind === 'repository') return config;
  const binding = await getChannelRepositoryBinding(ctx, channelId);
  if (binding) {
    return { kind: 'repository', repository: { channelId, binding, source: 'genesis' } };
  }
  return config.kind === 'unverified' ? config : { kind: 'none' };
}

/**
 * Git ref-name rules that matter for a Room's target branch, applied to a
 * short branch name (`refs/heads/` is stripped first). Deliberately strict:
 * this value is proposed from free-form chat, so anything that isn't plainly a
 * branch name is refused rather than guessed at.
 */
export function normalizeTargetBranchName(value: string | undefined | null): string | null {
  const raw = (value ?? '')
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^\/+|\/+$/g, '');
  if (!raw || raw.length > 200) return null;
  if (/[\s~^:?*\[\\]/.test(raw)) return null;
  if (raw.includes('..') || raw.includes('@{') || raw.includes('//')) return null;
  if (raw === '@' || raw.startsWith('-') || raw.endsWith('.') || raw.endsWith('.lock')) return null;
  if (raw.split('/').some((segment) => !segment || segment.startsWith('.'))) return null;
  return raw;
}
