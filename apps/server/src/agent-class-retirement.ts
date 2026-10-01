/**
 * One-time data migration retiring agent classes and tags.
 *
 * A Room reviewer or a workflow role used to name a class word (a weight
 * tier, harness, provider, exact model id, or admin custom tag) that resolved
 * to a random healthy Room member. Both now name an ordered list of agents
 * instead. This converts what is stored:
 *  - A Room reviewer class becomes the list of the Room's current agent
 *    members matching it now, ordered by name. A class matching nobody clears
 *    the Room's reviewer; those Rooms are returned so the release log names
 *    them.
 *  - A workflow run's class-bound role gets the class's matching agents as
 *    its list (`roleAgents` on the start card). A role already resolved keeps
 *    its agent; an unresolved class word is dropped from `roleBindings` so the
 *    role resolves from the list at its next dispatch.
 *  - Stored custom tags and weight-tier rules are cleared.
 *
 * The matcher below is the retired class logic, kept only to read what
 * existing rows meant. Every step is idempotent: converted rows no longer
 * match the selection queries.
 */
import type { SqlDatabase } from './database.js';

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

/** Current agent members of `roomId` carrying `word`, ordered by name. */
async function roomAgentsWithClass(db: SqlDatabase, roomId: string, word: string): Promise<string[]> {
  const rows = await db.query<AgentFacts & { weight_tier_rules: unknown }>(
    `SELECT agent.agent_id,agent.selected_model,agent.harness,agent.custom_tags,
            workspace.weight_tier_rules
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
  return rows.rows.filter((agent) => carriesClass(agent, rules, word)).map((agent) => agent.agent_id);
}

export async function retireAgentClasses(
  database: SqlDatabase,
): Promise<{ convertedRooms: number; clearedRooms: { id: string; name: string }[]; runs: number }> {
  const clearedRooms: { id: string; name: string }[] = [];
  let convertedRooms = 0;
  const rooms = await database.query<{
    id: string;
    name: string;
    reviewer_agent_id: string | null;
    reviewer_class: string;
  }>(`SELECT id,name,reviewer_agent_id,reviewer_class FROM rooms WHERE reviewer_class IS NOT NULL`);
  for (const room of rooms.rows) {
    let agents: string[] = [];
    await database.transaction(async (db) => {
      // A fixed reviewer always won over a class; only the class goes.
      agents = room.reviewer_agent_id ? [] : await roomAgentsWithClass(db, room.id, room.reviewer_class);
      await db.query(
        `UPDATE rooms SET reviewer_class=NULL,
           reviewer_agent_id=COALESCE(reviewer_agent_id,$2),
           reviewer_fallback_ids=CASE WHEN reviewer_agent_id IS NULL THEN $3::text[] ELSE reviewer_fallback_ids END,
           updated_at=now()
         WHERE id=$1 AND reviewer_class IS NOT NULL`,
        [room.id, agents[0] ?? null, agents.slice(1)],
      );
    });
    if (room.reviewer_agent_id) continue;
    if (agents.length) convertedRooms += 1;
    else clearedRooms.push({ id: room.id, name: room.name });
  }

  const runs = await database.query<{ id: string; room_id: string; role_classes: Record<string, string> }>(
    `SELECT id,room_id,card->'roleClasses' role_classes FROM messages
     WHERE card_type='workflow-handoff' AND card ? 'roleClasses'`,
  );
  for (const run of runs.rows) {
    await database.transaction(async (db) => {
      const roleAgents: Record<string, string[]> = {};
      for (const [role, word] of Object.entries(run.role_classes ?? {}))
        roleAgents[role] = await roomAgentsWithClass(db, run.room_id, word);
      await db.query(
        `UPDATE messages SET card=(card-'roleClasses')||jsonb_build_object('roleAgents',$2::jsonb)
         WHERE id=$1 AND card ? 'roleClasses'`,
        [run.id, JSON.stringify(roleAgents)],
      );
      // An unresolved role still holds its class word; drop it so the role
      // resolves from its list at the next dispatch.
      await db.query(
        `UPDATE messages SET card=jsonb_set(card,'{roleBindings}',(
           SELECT COALESCE(jsonb_object_agg(binding.key,binding.value),'{}'::jsonb)
           FROM jsonb_each(card->'roleBindings') binding
           WHERE binding.value #>> '{}' ~ '^[0-9a-f]{64}$'))
         WHERE room_id=$1 AND card_type='workflow-handoff' AND card->>'runId'=$2
           AND EXISTS (SELECT 1 FROM jsonb_each(card->'roleBindings') binding
                       WHERE NOT (binding.value #>> '{}' ~ '^[0-9a-f]{64}$'))`,
        [run.room_id, run.id],
      );
    });
  }

  await database.query(`UPDATE agents SET custom_tags='[]'::jsonb WHERE custom_tags<>'[]'::jsonb`);
  await database.query(`UPDATE workspaces SET weight_tier_rules=NULL WHERE weight_tier_rules IS NOT NULL`);
  return { convertedRooms, clearedRooms, runs: runs.rowCount ?? runs.rows.length };
}
