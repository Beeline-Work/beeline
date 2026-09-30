/**
 * Server-side resolution for agent classes/tags: turning a class/tag
 * reference (`packages/api-contract/src/agent-classes.ts`) into a concrete,
 * currently healthy agent, and answering "does this agent satisfy that
 * reference" for authorization checks (a class-configured corner reviewer).
 *
 * Health is derived from facts this codebase already keeps, never a new
 * stored status:
 *  - "online" is the same `live_outputs kind='presence'` reachability read
 *    every other reachability check in this file uses (`isAgentReachable`,
 *    `AGENT_REACHABLE_HORIZON_MS` from `agent-access.ts`).
 *  - "recently failed" and "out of credit" both read the agent's most recent
 *    `agent_turns` row (index `agent_turns_agent_activity`) and, when it
 *    failed, the `turn-failed` message card's `silenceKind`
 *    (`turn-silence-notice.ts`). `allowance-spent` (the provider's API
 *    allowance, not the wallet feature) is a STANDING condition — it doesn't
 *    clear itself on a timer, only on a later non-failed turn — while every
 *    other failure kind (wrong-model, not-signed-in, hiccup, ...) is only
 *    disqualifying for `AGENT_RECENT_FAILURE_MS`, matching the brief's
 *    "skip offline, failed within the last few minutes, or out-of-credit
 *    agents" as three distinct, independently time-boxed conditions.
 */
import {
  agentMatchesClass,
  isAgentHarness,
  readCustomTags,
  readWeightTierRules,
  resolveProviderTag,
  resolveWeightTier,
  AGENT_REACHABLE_HORIZON_MS,
  type AgentClassFacts,
  type WeightTierRule,
} from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';

export const AGENT_RECENT_FAILURE_MS = 5 * 60 * 1000;

export type AgentHealthReason = 'offline' | 'recent-failure' | 'out-of-credit';

async function readWorkspaceWeightTierRules(
  db: SqlDatabase,
  workspaceId: string,
): Promise<readonly WeightTierRule[]> {
  const row = (
    await db.query<{ weight_tier_rules: unknown }>(
      `SELECT weight_tier_rules FROM workspaces WHERE id=$1`,
      [workspaceId],
    )
  ).rows[0];
  return readWeightTierRules(row?.weight_tier_rules ?? null);
}

/** For the workspace settings read: the effective rules plus whether they're the shipped defaults. */
export async function readWorkspaceWeightTierRulesView(
  db: SqlDatabase,
  workspaceId: string,
): Promise<{ rules: readonly WeightTierRule[] }> {
  return { rules: await readWorkspaceWeightTierRules(db, workspaceId) };
}

type AgentFactsRow = {
  agent_id: string;
  selected_model: string | null;
  harness: string | null;
  custom_tags: unknown;
};

/** Build the tag-matchable facts for a set of agents, one workspace at a time. */
export async function loadAgentClassFacts(
  db: SqlDatabase,
  workspaceId: string,
  agentIds: readonly string[],
): Promise<Map<string, AgentClassFacts>> {
  if (!agentIds.length) return new Map();
  const [rules, rows] = await Promise.all([
    readWorkspaceWeightTierRules(db, workspaceId),
    db.query<AgentFactsRow>(
      `SELECT agent_id,selected_model,harness,custom_tags FROM agents WHERE agent_id=ANY($1::text[])`,
      [[...new Set(agentIds)]],
    ),
  ]);
  const out = new Map<string, AgentClassFacts>();
  for (const row of rows.rows) {
    const harness = isAgentHarness(row.harness) ? row.harness : null;
    const { tier } = resolveWeightTier(row.selected_model, rules);
    out.set(row.agent_id, {
      model: row.selected_model,
      harness,
      weightTier: tier,
      provider: resolveProviderTag(harness, row.selected_model),
      customTags: readCustomTags(row.custom_tags),
    });
  }
  return out;
}

/** Whether one agent currently carries a tag/class word, regardless of health or membership. */
export async function agentCarriesTag(
  db: SqlDatabase,
  workspaceId: string,
  agentId: string,
  tag: string,
): Promise<boolean> {
  const facts = (await loadAgentClassFacts(db, workspaceId, [agentId])).get(agentId);
  return facts ? agentMatchesClass(facts, tag) : false;
}

type CandidateRow = {
  agent_id: string;
  selected_model: string | null;
  harness: string | null;
  custom_tags: unknown;
  online: boolean;
  turn_status: 'working' | 'complete' | 'failed' | 'cancelled' | null;
  turn_created_at: Date | null;
  silence_kind: string | null;
};

async function loadRoomAgentCandidates(db: SqlDatabase, roomId: string): Promise<CandidateRow[]> {
  const rows = await db.query<CandidateRow>(
    `SELECT agent.agent_id,agent.selected_model,agent.harness,agent.custom_tags,
            COALESCE((
              SELECT lo.body->>'status'='online'
                AND lo.updated_at >= now()-make_interval(secs => $2::double precision/1000)
              FROM live_outputs lo
              WHERE lo.agent_id=agent.agent_id AND lo.kind='presence'
              ORDER BY lo.updated_at DESC LIMIT 1
            ),false) online,
            latest.status turn_status,latest.created_at turn_created_at,
            failure.silence_kind
     FROM memberships member
     JOIN identities identity ON identity.id=member.identity_id AND identity.kind='agent'
     JOIN agents agent ON agent.agent_id=identity.id
     LEFT JOIN LATERAL (
       SELECT status,created_at,request_id,room_id FROM agent_turns
       WHERE agent_id=agent.agent_id ORDER BY created_at DESC LIMIT 1
     ) latest ON true
     LEFT JOIN LATERAL (
       SELECT card->>'silenceKind' silence_kind FROM messages
       WHERE room_id=latest.room_id AND card_type='turn-failed'
         AND card->>'requestId'=latest.request_id AND card->>'agentId'=agent.agent_id
       ORDER BY created_at DESC LIMIT 1
     ) failure ON latest.status='failed'
     WHERE member.room_id=$1 AND member.removed_at IS NULL`,
    [roomId, AGENT_REACHABLE_HORIZON_MS],
  );
  return rows.rows;
}

function candidateHealth(row: CandidateRow, now: number): { healthy: boolean; reason?: AgentHealthReason } {
  if (!row.online) return { healthy: false, reason: 'offline' };
  if (row.turn_status === 'failed') {
    if (row.silence_kind === 'allowance-spent') return { healthy: false, reason: 'out-of-credit' };
    const age = row.turn_created_at ? now - row.turn_created_at.getTime() : Infinity;
    if (age < AGENT_RECENT_FAILURE_MS) return { healthy: false, reason: 'recent-failure' };
  }
  return { healthy: true };
}

/** Every current agent member of `roomId` that carries `tag`, healthy or not. */
export async function roomMembersWithTag(
  db: SqlDatabase,
  roomId: string,
  workspaceId: string,
  tag: string,
): Promise<{ agentId: string; healthy: boolean; reason?: AgentHealthReason }[]> {
  const candidates = await loadRoomAgentCandidates(db, roomId);
  const rules = await readWorkspaceWeightTierRules(db, workspaceId);
  const now = Date.now();
  const matches: { agentId: string; healthy: boolean; reason?: AgentHealthReason }[] = [];
  for (const row of candidates) {
    const harness = isAgentHarness(row.harness) ? row.harness : null;
    const facts: AgentClassFacts = {
      model: row.selected_model,
      harness,
      weightTier: resolveWeightTier(row.selected_model, rules).tier,
      provider: resolveProviderTag(harness, row.selected_model),
      customTags: readCustomTags(row.custom_tags),
    };
    if (!agentMatchesClass(facts, tag)) continue;
    matches.push({ agentId: row.agent_id, ...candidateHealth(row, now) });
  }
  return matches;
}

/** Whether ANY current member (healthy or not) carries the tag — used for "is a reviewer configured". */
export async function roomHasTaggedMember(
  db: SqlDatabase,
  roomId: string,
  workspaceId: string,
  tag: string,
): Promise<boolean> {
  return (await roomMembersWithTag(db, roomId, workspaceId, tag)).length > 0;
}

/** A random healthy candidate, excluding any id in `exclude`; `null` when the class is exhausted. */
export async function pickHealthyClassMember(
  db: SqlDatabase,
  roomId: string,
  workspaceId: string,
  tag: string,
  exclude: readonly string[] = [],
): Promise<string | null> {
  const excluded = new Set(exclude);
  const healthy = (await roomMembersWithTag(db, roomId, workspaceId, tag)).filter(
    (candidate) => candidate.healthy && !excluded.has(candidate.agentId),
  );
  if (!healthy.length) return null;
  return healthy[Math.floor(Math.random() * healthy.length)]!.agentId;
}

/**
 * Whether `agentId` satisfies a Room's configured reviewer, whichever shape
 * it is: an exact identity match for a fixed `reviewer_agent_id`, or a
 * current-parent-membership tag match for a `reviewer_class`. Used at every
 * point that must accept the class shape without loosening the fixed-agent
 * check it replaces (`approve_merge`, the review validation stage, and the
 * corner-reviewer fast path in `DaemonService.access`).
 */
export async function isConfiguredReviewer(
  db: SqlDatabase,
  parentRoomId: string,
  workspaceId: string,
  agentId: string,
): Promise<boolean> {
  const room = (
    await db.query<{ reviewer_agent_id: string | null; reviewer_class: string | null }>(
      `SELECT reviewer_agent_id,reviewer_class FROM rooms WHERE id=$1`,
      [parentRoomId],
    )
  ).rows[0];
  if (!room) return false;
  if (room.reviewer_agent_id) return room.reviewer_agent_id === agentId;
  if (!room.reviewer_class) return false;
  const facts = (await loadAgentClassFacts(db, workspaceId, [agentId])).get(agentId);
  if (!facts || !agentMatchesClass(facts, room.reviewer_class)) return false;
  const member = await db.query(
    `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
    [parentRoomId, agentId],
  );
  return member.rowCount > 0;
}
