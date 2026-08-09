/**
 * Provisioning check: the agent must NEVER be able to push the protected branch.
 *
 * Spec (`spec.md` → "Failure modes → each needs a test"):
 *   "Agent in push-rights (misconfig): the agent can push the protected branch.
 *    Test an unauthorized push is rejected + a provisioning check the agent is
 *    never in `push-allowed`. Write this first."
 *
 * How Buzz decides push rights (relay `git_perms` / `api/git/policy`):
 *   - kind:30617 announcement binds the repo to a channel (`buzz-channel`) and
 *     declares branch protection (`buzz-protect`, e.g. push:admin on main).
 *   - The 30617 signer is always the repo Owner (can push protected refs).
 *   - Non-owners resolve to their channel role; `push:admin` requires Admin+.
 *
 * This module fetches that state from the live relay (via the HTTP bridge) and
 * fails closed if the agent key has any path to push the protected branch.
 *
 * Library:  `checkAgentNotPushAllowed` / `assertAgentNotPushAllowed`
 * CLI:      `node --import tsx src/provisioning.ts <ownerHex> <repo> <agentPubkey>`
 */
import { queryEvents } from './relay.js';
import {
  KIND_CREATE_GROUP,
  KIND_PUT_USER,
  KIND_REPO_ANNOUNCEMENT,
} from './buzz.js';
import type { NostrEvent } from '@buzzy/nostr';

export type ChannelRole = 'owner' | 'admin' | 'member' | 'guest' | 'bot';

export interface ProvisioningCheckInput {
  /** Hex pubkey of the repo owner (kind:30617 signer). */
  ownerHex: string;
  /** Repo id (`d` tag / `{repo}` in the git URL). */
  repo: string;
  /** Hex pubkey of the agent that must NOT be able to push the protected branch. */
  agentPubkey: string;
  /** Full ref to protect, default `refs/heads/main`. */
  protectedRef?: string;
  /**
   * Pubkey used as `X-Pubkey` when querying the bridge. Defaults to `ownerHex`
   * (the open-stack bridge accepts any known-looking key for reads).
   */
  queryAs?: string;
}

export interface ProtectionRule {
  /** Ref pattern from the buzz-protect tag (e.g. `refs/heads/main`). */
  pattern: string;
  /** Raw rule tokens after the pattern (e.g. `push:admin`, `no-force-push`). */
  rules: string[];
  /** Minimum channel role required to push, if a `push:<role>` rule is present. */
  pushMinRole: ChannelRole | null;
}

export interface ProvisioningCheckResult {
  /** True iff the agent has NO path to push the protected branch. */
  ok: boolean;
  /** Human-readable pass/fail reason (safe to log / print). */
  reason: string;
  channelId?: string;
  protection?: ProtectionRule | null;
  agentRole?: ChannelRole | null;
  /** True when the agent is the repo owner (always push-capable). */
  agentIsRepoOwner?: boolean;
  /** True when the agent satisfies the protection rule (or is owner). */
  agentCanPushProtected?: boolean;
}

const ROLE_RANK: Record<ChannelRole, number> = {
  owner: 40,
  admin: 30,
  member: 20,
  guest: 10,
  bot: 0,
};

const DEFAULT_PROTECTED_REF = 'refs/heads/main';

function isRole(value: string): value is ChannelRole {
  return value in ROLE_RANK;
}

function parsePushMinRole(rules: string[]): ChannelRole | null {
  for (const rule of rules) {
    if (!rule.startsWith('push:')) continue;
    const role = rule.slice('push:'.length);
    if (isRole(role)) return role;
  }
  return null;
}

function parseProtection(
  event: NostrEvent,
  protectedRef: string,
): ProtectionRule | null {
  for (const tag of event.tags) {
    if (tag[0] !== 'buzz-protect' || !tag[1]) continue;
    const pattern = tag[1];
    // Exact match or simple prefix (Buzz stores full refs; keep exact for now).
    if (pattern !== protectedRef && pattern !== protectedRef.replace(/^refs\/heads\//, '')) {
      // Also accept a pattern that equals the short branch name of protectedRef.
      const short = protectedRef.startsWith('refs/heads/')
        ? protectedRef.slice('refs/heads/'.length)
        : protectedRef;
      if (pattern !== `refs/heads/${short}` && pattern !== short) continue;
    }
    const rules = tag.slice(2);
    return {
      pattern,
      rules,
      pushMinRole: parsePushMinRole(rules),
    };
  }
  return null;
}

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/**
 * Resolve the agent's current channel role from relay state (kind:9007 creator
 * → owner; latest kind:9000 role tag → assigned role). Returns null if the
 * agent is not a known member of the channel.
 */
export async function resolveChannelRole(
  channelId: string,
  pubkey: string,
  queryAs: string,
): Promise<ChannelRole | null> {
  const creates = await queryEvents(
    [{ kinds: [KIND_CREATE_GROUP], '#h': [channelId], authors: [pubkey], limit: 5 }],
    queryAs,
  );
  if (creates.length > 0) return 'owner';

  const puts = await queryEvents(
    [{ kinds: [KIND_PUT_USER], '#h': [channelId], '#p': [pubkey], limit: 50 }],
    queryAs,
  );
  if (puts.length === 0) return null;

  puts.sort((a, b) => b.created_at - a.created_at);
  const latest = puts[0]!;
  const role = tagValue(latest, 'role');
  if (role && isRole(role)) return role;
  // kind:9000 without a role tag still admits the user as a plain member.
  return 'member';
}

/** Communities reuse the exact NIP-29 creator/put-user role resolution. */
export function resolveCommunityRole(
  communityId: string,
  pubkey: string,
  queryAs: string,
): Promise<ChannelRole | null> {
  return resolveChannelRole(communityId, pubkey, queryAs);
}

function roleMeetsMinimum(role: ChannelRole, min: ChannelRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/**
 * Fetch branch-protection / push-allowed state for `{ownerHex}/{repo}` and
 * report whether `agentPubkey` has any path to push the protected branch.
 *
 * Pass (`ok: true`) means the agent is correctly excluded from push-rights.
 * Fail (`ok: false`) means misconfig — the agent can (or might be able to) push.
 */
export async function checkAgentNotPushAllowed(
  input: ProvisioningCheckInput,
): Promise<ProvisioningCheckResult> {
  const protectedRef = input.protectedRef ?? DEFAULT_PROTECTED_REF;
  const queryAs = input.queryAs ?? input.ownerHex;
  const agent = input.agentPubkey.toLowerCase();
  const owner = input.ownerHex.toLowerCase();

  if (agent === owner) {
    return {
      ok: false,
      reason: `agent pubkey IS the repo owner — owner is always in push-allowed for ${protectedRef}`,
      agentIsRepoOwner: true,
      agentCanPushProtected: true,
      agentRole: 'owner',
    };
  }

  const announcements = await queryEvents(
    [
      {
        kinds: [KIND_REPO_ANNOUNCEMENT],
        authors: [input.ownerHex],
        '#d': [input.repo],
        limit: 5,
      },
    ],
    queryAs,
  );
  if (announcements.length === 0) {
    return {
      ok: false,
      reason: `no kind:30617 announcement found for ${input.ownerHex}/${input.repo}`,
    };
  }
  // Parameterized-replaceable: highest created_at wins.
  announcements.sort((a, b) => b.created_at - a.created_at);
  const announcement = announcements[0]!;

  const channelId = tagValue(announcement, 'buzz-channel');
  if (!channelId) {
    // Unbound repo: only the owner can push. Agent ≠ owner → cannot push.
    // Still fail closed if we expected a channel-bound multi-member repo —
    // but for the "agent not in push-allowed" predicate this is a pass.
    return {
      ok: true,
      reason: `repo has no buzz-channel binding; only owner can push (agent excluded)`,
      protection: null,
      agentIsRepoOwner: false,
      agentCanPushProtected: false,
      agentRole: null,
    };
  }

  const protection = parseProtection(announcement, protectedRef);
  const agentRole = await resolveChannelRole(channelId, input.agentPubkey, queryAs);

  // No protection rule on the protected ref: default git ACL still lets any
  // channel Member push (see relay policy). A member agent therefore CAN push.
  if (!protection || !protection.pushMinRole) {
    const canPush =
      agentRole !== null && roleMeetsMinimum(agentRole, 'member');
    return {
      ok: !canPush,
      reason: canPush
        ? `FAIL: no push:<role> protection on ${protectedRef}; agent role=${agentRole} can push`
        : `ok: no push rule on ${protectedRef}, but agent has no pushable membership (role=${agentRole})`,
      channelId,
      protection,
      agentRole,
      agentIsRepoOwner: false,
      agentCanPushProtected: canPush,
    };
  }

  const min = protection.pushMinRole;
  const canPush =
    agentRole !== null && roleMeetsMinimum(agentRole, min);

  if (canPush) {
    return {
      ok: false,
      reason:
        `FAIL: agent is effectively in push-allowed for ${protectedRef} ` +
        `(role=${agentRole} meets push:${min}; rules=[${protection.rules.join(', ')}])`,
      channelId,
      protection,
      agentRole,
      agentIsRepoOwner: false,
      agentCanPushProtected: true,
    };
  }

  return {
    ok: true,
    reason:
      `ok: agent role=${agentRole ?? 'none'} does not meet push:${min} on ${protectedRef} ` +
      `(rules=[${protection.rules.join(', ')}])`,
    channelId,
    protection,
    agentRole,
    agentIsRepoOwner: false,
    agentCanPushProtected: false,
  };
}

/**
 * Like `checkAgentNotPushAllowed`, but throws on failure — for use as a
 * hard gate in provisioning / CI scripts.
 */
export async function assertAgentNotPushAllowed(
  input: ProvisioningCheckInput,
): Promise<ProvisioningCheckResult> {
  const result = await checkAgentNotPushAllowed(input);
  if (!result.ok) {
    throw new Error(`provisioning check failed: ${result.reason}`);
  }
  return result;
}

/** CLI entry: exit 0 on pass, 1 on fail / usage error. */
async function main(): Promise<void> {
  const [, , ownerHex, repo, agentPubkey, protectedRef] = process.argv;
  if (!ownerHex || !repo || !agentPubkey) {
    console.error(
      'usage: provisioning <ownerHex> <repo> <agentPubkey> [protectedRef=refs/heads/main]',
    );
    process.exit(2);
  }
  const result = await checkAgentNotPushAllowed({
    ownerHex,
    repo,
    agentPubkey,
    ...(protectedRef ? { protectedRef } : {}),
  });
  if (result.ok) {
    console.log(`PASS  ${result.reason}`);
    if (result.channelId) console.log(`  channel   ${result.channelId}`);
    if (result.protection) {
      console.log(
        `  protect   ${result.protection.pattern} ${result.protection.rules.join(' ')}`,
      );
    }
    console.log(`  agentRole ${result.agentRole ?? 'none'}`);
    process.exit(0);
  } else {
    console.error(`FAIL  ${result.reason}`);
    if (result.channelId) console.error(`  channel   ${result.channelId}`);
    if (result.protection) {
      console.error(
        `  protect   ${result.protection.pattern} ${result.protection.rules.join(' ')}`,
      );
    }
    console.error(`  agentRole ${result.agentRole ?? 'none'}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
