#!/usr/bin/env node
/**
 * Read-only dry run of `retireAgentClasses` (apps/server/src/agent-class-
 * retirement.ts) against a live database, to list the Rooms the deploy-time
 * migration would clear. The migration itself writes; this script only runs
 * its selection queries inside one read-only transaction that is rolled back,
 * so it can be pointed at production without sending a single UPDATE.
 *
 * The matcher and queries below are a faithful copy of the migration's own
 * retired class logic (tier rules, harness/provider/model tags, custom tags)
 * so "cleared" here means exactly what the migration will clear.
 *
 * Usage:
 *   node --import tsx scripts/dry-run-agent-class-retirement.ts "postgres://..."
 *   BEELINE_DATABASE_URL=postgres://... node --import tsx scripts/dry-run-agent-class-retirement.ts
 */
import { Pool } from 'pg';

const url = process.argv[2] ?? process.env.BEELINE_DATABASE_URL;
if (!url) throw new Error('pass a Postgres URL as argv[1] or set BEELINE_DATABASE_URL');

type TierRule = { pattern: string; tier: string };

const DEFAULT_TIER_RULES: readonly TierRule[] = [
  { pattern: 'astra*', tier: 'god' },
  { pattern: 'fable*', tier: 'god' },
  { pattern: 'grok*', tier: 'heavy' },
  { pattern: '*sol*', tier: 'heavy' },
  { pattern: 'opus*', tier: 'heavy' },
];

const NATIVE_PROVIDER: Record<string, string> = { claude: 'anthropic', codex: 'openai', grok: 'xai' };
const HARNESSES = new Set(['codex', 'claude', 'goose', 'pi', 'grok', 'cursor', 'opencode', 'reference', 'custom']);

function tierRules(value: unknown): readonly TierRule[] {
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_TIER_RULES;
  const valid = value.every(
    (rule) =>
      typeof rule === 'object' &&
      rule !== null &&
      typeof (rule as TierRule).pattern === 'string' &&
      typeof (rule as TierRule).tier === 'string',
  );
  return valid ? (value as TierRule[]) : DEFAULT_TIER_RULES;
}

function patternMatches(pattern: string, model: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === '*' ? '.*' : `\\${char}`));
  return new RegExp(`^${escaped}$`, 'i').test(model);
}

function provider(harness: string | null, model: string | null): string {
  if (harness && NATIVE_PROVIDER[harness]) return NATIVE_PROVIDER[harness]!;
  const name = (model ?? '').toLowerCase();
  if (!name) return 'unknown';
  if (name.startsWith('claude')) return 'anthropic';
  if (name.startsWith('gemini')) return 'google';
  if (name.startsWith('grok')) return 'xai';
  if (name.startsWith('gpt') || name.startsWith('o1') || name.startsWith('o3') || name.startsWith('codex'))
    return 'openai';
  return harness ? 'openrouter' : 'unknown';
}

type AgentFacts = {
  agent_id: string;
  selected_model: string | null;
  harness: string | null;
  custom_tags: unknown;
};

function carriesClass(agent: AgentFacts, rules: readonly TierRule[], word: string): boolean {
  const harness = agent.harness && HARNESSES.has(agent.harness) ? agent.harness : null;
  const model = agent.selected_model;
  const tier = model ? (rules.find((rule) => patternMatches(rule.pattern, model))?.tier ?? 'light') : 'light';
  const tags = new Set<string>(
    Array.isArray(agent.custom_tags) ? agent.custom_tags.filter((tag) => typeof tag === 'string') : [],
  );
  if (model) tags.add(model);
  if (harness) tags.add(harness);
  tags.add(provider(harness, model));
  tags.add(tier);
  return tags.has(word);
}

async function roomAgentsWithClass(
  pool: Pool,
  roomId: string,
  word: string,
): Promise<{ id: string; name: string }[]> {
  const rows = await pool.query<AgentFacts & { weight_tier_rules: unknown; identity_name: string }>(
    `SELECT agent.agent_id,agent.selected_model,agent.harness,agent.custom_tags,
            workspace.weight_tier_rules,identity.name identity_name
     FROM memberships member
     JOIN rooms room ON room.id=member.room_id
     JOIN workspaces workspace ON workspace.id=room.workspace_id
     JOIN identities identity ON identity.id=member.identity_id AND identity.kind='agent'
     JOIN agents agent ON agent.agent_id=identity.id
     WHERE member.room_id=$1 AND member.removed_at IS NULL
     ORDER BY lower(identity.name),identity.id`,
    [roomId],
  );
  const rules = tierRules(rows.rows[0]?.weight_tier_rules);
  return rows.rows.filter((agent) => carriesClass(agent, rules, word)).map((agent) => ({
    id: agent.agent_id,
    name: agent.identity_name,
  }));
}

async function main(): Promise<void> {
const pool = new Pool({ connectionString: url, max: 1 });
try {
  await pool.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  const rooms = await pool.query<{
    id: string;
    name: string;
    reviewer_agent_id: string | null;
    reviewer_class: string;
  }>(`SELECT id,name,reviewer_agent_id,reviewer_class FROM rooms WHERE reviewer_class IS NOT NULL`);

  const converted: { room: string; class: string; agents: string[] }[] = [];
  const cleared: { id: string; name: string; class: string }[] = [];
  const fixed: { id: string; name: string; class: string }[] = [];
  for (const room of rooms.rows) {
    const entry = { id: room.id, name: room.name, class: room.reviewer_class };
    if (room.reviewer_agent_id) fixed.push(entry);
    else {
      const matches = await roomAgentsWithClass(pool, room.id, room.reviewer_class);
      if (matches.length) converted.push({ room: room.name, class: room.reviewer_class, agents: matches.map((m) => m.name) });
      else cleared.push(entry);
    }
  }

  const runs = await pool.query(
    `SELECT id,room_id,card->'roleClasses' role_classes FROM messages
     WHERE card_type='workflow-handoff' AND card ? 'roleClasses'`,
  );
  const runsDetail: { id: string; role: string; word: string; matching: string[] }[] = [];
  for (const run of runs.rows) {
    for (const [role, word] of Object.entries<unknown>(run.role_classes ?? {})) {
      const matches = await roomAgentsWithClass(pool, run.room_id, String(word));
      runsDetail.push({ id: run.id, role, word: String(word), matching: matches.map((m) => m.name) });
    }
  }

  const tags = await pool.query(
    `SELECT count(*)::int cleared FROM agents WHERE custom_tags<>'[]'::jsonb`,
  );
  const tiers = await pool.query(`SELECT count(*)::int cleared FROM workspaces WHERE weight_tier_rules IS NOT NULL`);

  console.log(JSON.stringify({
    roomsWithReviewerClass: rooms.rowCount,
    fixedReviewerKept: fixed,
    convertedRooms: converted,
    clearedRooms: cleared,
    classBoundRunRoles: runsDetail,
    customTagsCleared: tags.rows[0]?.cleared ?? 0,
    weightTierRuleWorkspacesCleared: tiers.rows[0]?.cleared ?? 0,
  }, null, 2));
} finally {
  await pool.query('ROLLBACK');
  await pool.end();
}
}

void main();