import { randomUUID } from 'node:crypto';
import {
  agentClassView,
  classifyModel,
  harnessDefaultProvider,
  isAgentTier,
  MODELS_DEV_URL,
  parseModelsDevRegistry,
  resolveRegistryModel,
  type AgentClassView,
  type AgentModelConfigOption,
  type ModelTierOverride,
  type RegistryModel,
} from '@beeline/api-contract/phone';
import {
  AGENT_REACHABLE_HORIZON_MS,
  parseAgentAccessPolicy,
  senderMayAddressAgent,
} from '@beeline/api-contract/agent-access';
import { classifyTurnSilence } from '@beeline/api-contract/daemon';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { createAgentCommand, repairReviewerCornerMembership } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { postRoomChoice } from './room-choice.js';
import { rebindWorkflowRole } from './workflow-runs.js';
import { ensureSystemIdentity, systemLine } from './system-line.js';

/**
 * Agent classes (tags, weight tiers) and assignment by class with failover.
 *
 * Tiers come from the models.dev registry cached in `model_registry`; a turn
 * never reads the network. A class names one tag. Assignment picks a random
 * healthy Room member carrying the class, fails over to the next one on an
 * instant failure or on silence past the step timeout, and asks the Room's
 * humans when the class is exhausted.
 */
export const AGENT_CLASS_SCHEMA = `
ALTER TABLE agents ADD COLUMN IF NOT EXISTS harness text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS reviewer_class text;
-- The person who named the class: its candidates obey each agent's access
-- policy for this person, exactly as that person's mention would.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS reviewer_class_set_by text REFERENCES identities(id);
CREATE TABLE IF NOT EXISTS model_registry (
  provider text NOT NULL,
  model_id text NOT NULL,
  name text NOT NULL,
  family text,
  output_cost double precision,
  PRIMARY KEY (provider, model_id)
);
CREATE INDEX IF NOT EXISTS model_registry_model_idx ON model_registry(model_id);
CREATE TABLE IF NOT EXISTS model_registry_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  fetched_at timestamptz,
  attempted_at timestamptz,
  model_count integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE TABLE IF NOT EXISTS agent_custom_tags (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  tag text NOT NULL,
  created_by text REFERENCES identities(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, agent_id, tag)
);
CREATE TABLE IF NOT EXISTS model_tier_overrides (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('model','family')),
  key text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('god','heavy','light')),
  set_by text REFERENCES identities(id),
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, scope, key)
);
CREATE TABLE IF NOT EXISTS agent_health_flags (
  agent_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  kind text NOT NULL,
  flagged_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_turns_recent_failure_idx
  ON agent_turns(agent_id, created_at DESC) WHERE status='failed';
CREATE TABLE IF NOT EXISTS class_assignments (
  id uuid PRIMARY KEY,
  candidate_room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  dispatch_room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  run_key text NOT NULL,
  role text NOT NULL,
  agent_class text NOT NULL,
  requested_by text REFERENCES identities(id),
  source_message_id text REFERENCES messages(id) ON DELETE SET NULL,
  timeout_seconds integer NOT NULL CHECK (timeout_seconds BETWEEN 30 AND 86400),
  status text NOT NULL CHECK (status IN ('active','done','exhausted','stopped')),
  current_agent_id text REFERENCES identities(id),
  current_command_id text,
  attempt_started_at timestamptz,
  tried jsonb NOT NULL DEFAULT '[]'::jsonb,
  choice_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_room_id, run_key, role)
);
CREATE INDEX IF NOT EXISTS class_assignments_active_idx
  ON class_assignments(dispatch_room_id, current_agent_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS class_assignments_choice_idx
  ON class_assignments(choice_id) WHERE choice_id IS NOT NULL;
`;

export const MODELS_DEV_REFRESH_MS = 24 * 60 * 60 * 1000;
/** A failed fetch is retried after this, never sooner. */
export const MODELS_DEV_RETRY_MS = 60 * 60 * 1000;
export const MODELS_DEV_TIMEOUT_MS = 15_000;
export const MODELS_DEV_MAX_BYTES = 20 * 1024 * 1024;
/** "Failed a turn in the last few minutes." */
export const RECENT_FAILURE_WINDOW_MINUTES = 10;
/** How long an out-of-credits / auth / model-unavailable flag keeps an agent out. */
export const HEALTH_FLAG_WINDOW_MINUTES = 30;
export const DEFAULT_CLASS_STEP_TIMEOUT_SECONDS = 600;
export const CLASS_REVIEWER_ROLE = 'reviewer';
/** Failures that move the prompt to the next agent at once. */
export const INSTANT_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'wrong-model',
  'allowance-spent',
  'not-signed-in',
  'offline',
]);
const FAILURE_PHRASES: Record<string, string> = {
  'wrong-model': 'model unavailable',
  'allowance-spent': 'out of credits',
  'not-signed-in': 'auth error',
  offline: 'offline',
  timeout: 'no reply before the step timeout',
};

type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/**
 * Refresh the registry cache when it is older than a day. Runs in the
 * background leader only; a failure keeps the previous rows.
 */
export async function refreshModelRegistryIfDue(
  database: SqlDatabase,
  options: { now?: Date; fetcher?: Fetcher; force?: boolean } = {},
): Promise<'fresh' | 'refreshed' | 'failed' | 'backoff'> {
  const now = options.now ?? new Date();
  const state = (
    await database.query<{ fetched_at: Date | null; attempted_at: Date | null }>(
      `SELECT fetched_at,attempted_at FROM model_registry_state WHERE singleton`,
    )
  ).rows[0];
  if (!options.force) {
    if (state?.fetched_at && now.getTime() - state.fetched_at.getTime() < MODELS_DEV_REFRESH_MS)
      return 'fresh';
    if (state?.attempted_at && now.getTime() - state.attempted_at.getTime() < MODELS_DEV_RETRY_MS)
      return 'backoff';
  }
  await database.query(
    `INSERT INTO model_registry_state(singleton,attempted_at) VALUES(true,$1)
     ON CONFLICT(singleton) DO UPDATE SET attempted_at=EXCLUDED.attempted_at`,
    [now],
  );
  let rows: RegistryModel[];
  try {
    rows = parseModelsDevRegistry(await fetchRegistryJson(options.fetcher ?? fetch));
    if (!rows.length) throw new Error('models.dev returned no models');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[agent-classes] models.dev refresh failed:', message);
    await database.query(`UPDATE model_registry_state SET last_error=$1 WHERE singleton`, [
      message.slice(0, 500),
    ]);
    return 'failed';
  }
  await database.transaction(async (db) => {
    await db.query(`DELETE FROM model_registry`);
    for (let index = 0; index < rows.length; index += 500) {
      const chunk = rows.slice(index, index + 500);
      await db.query(
        `INSERT INTO model_registry(provider,model_id,name,family,output_cost)
         SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::double precision[])
         ON CONFLICT(provider,model_id) DO UPDATE SET name=EXCLUDED.name,family=EXCLUDED.family,
           output_cost=EXCLUDED.output_cost`,
        [
          chunk.map((row) => row.provider),
          chunk.map((row) => row.modelId),
          chunk.map((row) => row.name),
          chunk.map((row) => row.family),
          chunk.map((row) => row.outputCost),
        ],
      );
    }
    await db.query(
      `UPDATE model_registry_state SET fetched_at=$1,model_count=$2,last_error=NULL WHERE singleton`,
      [now, rows.length],
    );
  });
  return 'refreshed';
}

async function fetchRegistryJson(fetcher: Fetcher): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_DEV_TIMEOUT_MS);
  try {
    const response = await fetcher(MODELS_DEV_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`models.dev responded ${response.status}`);
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > MODELS_DEV_MAX_BYTES) throw new Error('models.dev body is too large');
    // Counted while streaming, so a chunked body without a length is refused
    // before it is buffered past the cap.
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('models.dev returned no body');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MODELS_DEV_MAX_BYTES) {
        await reader.cancel();
        throw new Error('models.dev body is too large');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

type AgentModelRow = {
  agent_id: string;
  selected_model: string | null;
  model_catalog: AgentModelConfigOption[] | null;
  harness: string | null;
  provider: string | null;
};

function modelLookup(row: AgentModelRow) {
  const axis = (row.model_catalog ?? []).find((option) => option.category === 'model');
  const modelId = row.selected_model ?? axis?.currentValue ?? undefined;
  const displayName = modelId
    ? axis?.options.find((option) => option.id === modelId)?.name
    : undefined;
  const provider = row.provider ?? harnessDefaultProvider(row.harness) ?? undefined;
  return {
    ...(provider ? { provider } : {}),
    ...(modelId ? { modelId } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

export async function loadTierOverrides(
  database: SqlDatabase,
  workspaceId: string,
): Promise<ModelTierOverride[]> {
  const rows = await database.query<{ scope: 'model' | 'family'; key: string; tier: string }>(
    `SELECT scope,key,tier FROM model_tier_overrides WHERE workspace_id=$1 ORDER BY scope,key`,
    [workspaceId],
  );
  return rows.rows.flatMap((row) =>
    isAgentTier(row.tier) ? [{ scope: row.scope, key: row.key, tier: row.tier }] : [],
  );
}

export type AgentClassEntry = {
  readonly classes: AgentClassView;
  /** The raw model the agent runs, as the harness names it. */
  readonly model?: string;
};

/**
 * Tags and tier for every agent in `agentIds` (or every agent in the
 * Workspace). Pure reads of cached tables.
 */
export async function loadAgentClasses(
  database: SqlDatabase,
  workspaceId: string,
  agentIds?: readonly string[],
): Promise<Map<string, AgentClassEntry>> {
  const agents = (
    await database.query<AgentModelRow>(
      `SELECT a.agent_id,a.selected_model,a.model_catalog,a.harness,a.provider
       FROM agents a
       JOIN memberships m ON m.identity_id=a.agent_id AND m.workspace_id=$1
         AND m.room_id IS NULL AND m.removed_at IS NULL
       WHERE $2::text[] IS NULL OR a.agent_id=ANY($2::text[])`,
      [workspaceId, agentIds ? [...agentIds] : null],
    )
  ).rows;
  const result = new Map<string, AgentClassEntry>();
  if (!agents.length) return result;
  const lookups = new Map(agents.map((row) => [row.agent_id, modelLookup(row)]));
  const providers = new Set<string>();
  const modelIds = new Set<string>();
  for (const lookup of lookups.values()) {
    if (lookup.provider) providers.add(lookup.provider);
    if (!lookup.modelId) continue;
    modelIds.add(lookup.modelId);
    const slash = lookup.modelId.indexOf('/');
    if (slash > 0) providers.add(lookup.modelId.slice(0, slash).toLowerCase());
  }
  const registry = (
    await database.query<{
      provider: string;
      model_id: string;
      name: string;
      family: string | null;
      output_cost: number | null;
    }>(
      `SELECT provider,model_id,name,family,output_cost FROM model_registry
       WHERE provider=ANY($1::text[]) OR model_id=ANY($2::text[])`,
      [[...providers], [...modelIds]],
    )
  ).rows.map(
    (row): RegistryModel => ({
      provider: row.provider,
      modelId: row.model_id,
      name: row.name,
      family: row.family,
      outputCost: row.output_cost === null ? null : Number(row.output_cost),
    }),
  );
  const overrides = await loadTierOverrides(database, workspaceId);
  const custom = await database.query<{ agent_id: string; tag: string }>(
    `SELECT agent_id,tag FROM agent_custom_tags WHERE workspace_id=$1 AND agent_id=ANY($2::text[])`,
    [workspaceId, agents.map((row) => row.agent_id)],
  );
  const customByAgent = new Map<string, string[]>();
  for (const row of custom.rows)
    customByAgent.set(row.agent_id, [...(customByAgent.get(row.agent_id) ?? []), row.tag]);
  for (const row of agents) {
    const lookup = lookups.get(row.agent_id)!;
    const model = resolveRegistryModel(lookup, registry);
    const classification = classifyModel(
      {
        ...(lookup.provider ? { provider: lookup.provider } : {}),
        ...(lookup.modelId ? { modelId: lookup.modelId } : {}),
        ...(model ? { model } : {}),
      },
      overrides,
    );
    result.set(row.agent_id, {
      classes: agentClassView({
        classification,
        harness: row.harness,
        custom: customByAgent.get(row.agent_id) ?? [],
      }),
      ...(lookup.modelId ? { model: lookup.modelId } : {}),
    });
  }
  return result;
}

export type CandidateHealth = { agentId: string; name: string; healthy: boolean; reason?: string };

/**
 * Agent members of `roomId` that carry `agentClass`, each with a health
 * verdict. `requesterId` applies the agent's own access policy exactly as a
 * mention would; the reviewer path passes none, as a configured reviewer is
 * dispatched today without one.
 */
export async function classCandidates(
  database: SqlDatabase,
  input: {
    roomId: string;
    agentClass: string;
    requesterId?: string;
    /** A person asked to retry: recent failures and flags no longer count. */
    retry?: boolean;
  },
): Promise<CandidateHealth[]> {
  const room = (
    await database.query<{ workspace_id: string }>(`SELECT workspace_id FROM rooms WHERE id=$1`, [
      input.roomId,
    ])
  ).rows[0];
  if (!room) return [];
  const members = (
    await database.query<{
      agent_id: string;
      name: string;
      access_policy: unknown;
      owner_id: string | null;
      reachable: boolean;
      model_unavailable: string | null;
      recent_failure: boolean;
      flag: string | null;
    }>(
      `SELECT identity.id agent_id,COALESCE(NULLIF(identity.name,''),'An agent') name,
              a.access_policy,a.owner_id,a.model_unavailable,
              COALESCE((SELECT lo.body->>'status'='online'
                  AND lo.updated_at >= now()-make_interval(secs => $2::double precision / 1000)
                FROM live_outputs lo
                WHERE lo.agent_id=identity.id AND lo.kind='presence'
                ORDER BY lo.updated_at DESC LIMIT 1),false) reachable,
              EXISTS(SELECT 1 FROM agent_turns turn WHERE turn.agent_id=identity.id
                AND turn.status='failed'
                AND turn.created_at > now()-make_interval(mins => $3::integer)) recent_failure,
              (SELECT flag.kind FROM agent_health_flags flag WHERE flag.agent_id=identity.id
                AND flag.flagged_at > now()-make_interval(mins => $4::integer)) flag
       FROM memberships member
       JOIN identities identity ON identity.id=member.identity_id AND identity.kind='agent'
       JOIN agents a ON a.agent_id=identity.id
       WHERE member.room_id=$1 AND member.removed_at IS NULL
       ORDER BY identity.id`,
      [
        input.roomId,
        AGENT_REACHABLE_HORIZON_MS,
        RECENT_FAILURE_WINDOW_MINUTES,
        HEALTH_FLAG_WINDOW_MINUTES,
      ],
    )
  ).rows;
  if (!members.length) return [];
  const classes = await loadAgentClasses(
    database,
    room.workspace_id,
    members.map((member) => member.agent_id),
  );
  const candidates: CandidateHealth[] = [];
  for (const member of members) {
    const tags = classes.get(member.agent_id)?.classes.tags ?? [];
    if (!tags.some((tag) => tag.tag === input.agentClass)) continue;
    if (
      input.requesterId &&
      !senderMayAddressAgent(
        parseAgentAccessPolicy(member.access_policy),
        input.requesterId,
        member.owner_id ?? undefined,
      )
    )
      continue;
    const reason = !member.reachable
      ? 'offline'
      : member.model_unavailable
        ? 'model unavailable'
        : member.flag && !input.retry
          ? (FAILURE_PHRASES[member.flag] ?? member.flag)
          : member.recent_failure && !input.retry
            ? 'failed a turn recently'
            : undefined;
    candidates.push({
      agentId: member.agent_id,
      name: member.name,
      healthy: !reason,
      ...(reason ? { reason } : {}),
    });
  }
  return candidates;
}

export function pickRandom<T>(items: readonly T[], random: () => number = Math.random): T | undefined {
  if (!items.length) return undefined;
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
}

type TriedEntry = { agentId: string; name: string; reason: string };

type AssignmentRow = {
  id: string;
  candidate_room_id: string;
  dispatch_room_id: string;
  run_key: string;
  role: string;
  agent_class: string;
  requested_by: string | null;
  source_message_id: string | null;
  timeout_seconds: number;
  status: 'active' | 'done' | 'exhausted' | 'stopped';
  current_agent_id: string | null;
  current_command_id: string | null;
  tried: TriedEntry[];
  choice_id: string | null;
};

async function agentName(database: SqlDatabase, agentId: string): Promise<string> {
  return (
    (
      await database.query<{ name: string }>(
        `SELECT COALESCE(NULLIF(name,''),'An agent') name FROM identities WHERE id=$1`,
        [agentId],
      )
    ).rows[0]?.name ?? 'An agent'
  );
}

async function announce(
  database: SqlDatabase,
  roomId: string,
  input: {
    agentId?: string;
    name?: string;
    verb: string;
    object?: string;
    consequence?: string;
    /** The step's prompt: the line is ordered after it. */
    afterMessageId?: string | null;
  },
): Promise<void> {
  await ensureSystemIdentity(database);
  await systemLine(database, {
    roomId,
    authorId: SYSTEM_IDENTITY_ID,
    subject: input.agentId
      ? { kind: 'agent', id: input.agentId, name: input.name ?? 'An agent' }
      : { kind: 'system', name: 'Beeline' },
    verb: input.verb,
    ...(input.object ? { object: input.object } : {}),
    ...(input.consequence ? { consequence: input.consequence } : {}),
    ...(input.afterMessageId ? { afterMessageId: input.afterMessageId } : {}),
  });
}

/**
 * Point a Room's reviewer at `agentId`, moving the check-passed subscription
 * the same way `updateRoom` does, so every existing reviewer path (dispatch,
 * membership repair, merge gate, handback) follows the class pick unchanged.
 */
async function setClassReviewer(
  database: SqlDatabase,
  roomId: string,
  previous: string | null,
  agentId: string,
): Promise<void> {
  if (previous === agentId) return;
  await database.query(`UPDATE rooms SET reviewer_agent_id=$2,updated_at=now() WHERE id=$1`, [
    roomId,
    agentId,
  ]);
  if (previous)
    await database.query(
      `UPDATE memberships member
       SET event_subscriptions=member.event_subscriptions-'check-passed'
       FROM rooms room
       WHERE member.room_id=room.id AND member.identity_id=$2
         AND member.removed_at IS NULL
         AND (room.id=$1 OR room.parent_id=$1)`,
      [roomId, previous],
    );
  await database.query(
    `UPDATE memberships member
     SET event_subscriptions=CASE
       WHEN member.event_subscriptions @> '["check-passed"]'::jsonb
         THEN member.event_subscriptions
       ELSE member.event_subscriptions||'["check-passed"]'::jsonb
     END
     FROM rooms room
     WHERE member.room_id=room.id AND member.identity_id=$2
       AND member.removed_at IS NULL
       AND (room.id=$1 OR room.parent_id=$1)`,
    [roomId, agentId],
  );
}

/**
 * Settle a top-level Room's class reviewer before a review is dispatched:
 * keep the current pick while it is healthy and still in the class (sticky),
 * otherwise pick a random healthy one. Returns the agent to review, or
 * undefined when the class has no healthy agent (the caller asks a human).
 */
export async function settleClassReviewer(
  database: SqlDatabase,
  roomId: string,
  exclude: readonly string[] = [],
  random: () => number = Math.random,
  retry = false,
): Promise<{ agentClass: string; agentId?: string; candidates: CandidateHealth[] } | undefined> {
  const room = (
    await database.query<{
      reviewer_class: string | null;
      reviewer_agent_id: string | null;
      reviewer_class_set_by: string | null;
    }>(
      `SELECT reviewer_class,reviewer_agent_id,reviewer_class_set_by FROM rooms
       WHERE id=$1 AND parent_id IS NULL FOR UPDATE`,
      [roomId],
    )
  ).rows[0];
  if (!room?.reviewer_class) return undefined;
  // Another person's agent keeps its owner's access policy: a class names
  // only agents the person who set it could address by mention.
  const candidates = await classCandidates(database, {
    roomId,
    agentClass: room.reviewer_class,
    retry,
    ...(room.reviewer_class_set_by ? { requesterId: room.reviewer_class_set_by } : {}),
  });
  const healthy = candidates.filter(
    (candidate) => candidate.healthy && !exclude.includes(candidate.agentId),
  );
  const current = healthy.find((candidate) => candidate.agentId === room.reviewer_agent_id);
  const pick = current ?? pickRandom(healthy, random);
  if (pick) await setClassReviewer(database, roomId, room.reviewer_agent_id, pick.agentId);
  return { agentClass: room.reviewer_class, candidates, ...(pick ? { agentId: pick.agentId } : {}) };
}

/**
 * Dispatch a corner's green-check review to the parent Room's class reviewer:
 * the sticky current pick while healthy, otherwise a random healthy agent in
 * the class. The attempt is recorded so an instant failure or silence moves
 * the same review to the next reviewer; an empty class asks a human.
 */
export async function dispatchClassReview(
  database: SqlDatabase,
  input: { parentRoomId: string; cornerId: string; sourceMessageId: string },
  random: () => number = Math.random,
): Promise<string | undefined> {
  const room = (
    await database.query<{ reviewer_class: string | null }>(
      `SELECT reviewer_class FROM rooms WHERE id=$1`,
      [input.parentRoomId],
    )
  ).rows[0];
  if (!room?.reviewer_class) return undefined;
  const assignment = (
    await database.query<AssignmentRow>(
      `INSERT INTO class_assignments(id,candidate_room_id,dispatch_room_id,run_key,role,agent_class,
         source_message_id,timeout_seconds,status,tried)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active','[]'::jsonb)
       ON CONFLICT(candidate_room_id,run_key,role) DO UPDATE SET
         agent_class=EXCLUDED.agent_class,source_message_id=EXCLUDED.source_message_id,
         status='active',current_agent_id=NULL,current_command_id=NULL,tried='[]'::jsonb,
         choice_id=NULL,updated_at=now()
       RETURNING *`,
      [
        randomUUID(),
        input.parentRoomId,
        input.cornerId,
        `${CORNER_REVIEW_RUN_KEY_PREFIX}${input.cornerId}`,
        CLASS_REVIEWER_ROLE,
        room.reviewer_class,
        input.sourceMessageId,
        DEFAULT_CLASS_STEP_TIMEOUT_SECONDS,
      ],
    )
  ).rows[0]!;
  return advanceAssignment(database, assignment, undefined, random);
}

const CORNER_REVIEW_RUN_KEY_PREFIX = 'corner:';

/** A corner review is keyed by its corner; a workflow role may also be named "reviewer". */
function isCornerReview(assignment: Pick<AssignmentRow, 'run_key'>): boolean {
  return assignment.run_key.startsWith(CORNER_REVIEW_RUN_KEY_PREFIX);
}

/** Ask the humans in the dispatch Room; never fail silently. */
async function askHumanForExhaustedClass(
  database: SqlDatabase,
  assignment: AssignmentRow,
  tried: readonly TriedEntry[],
  skipped: readonly CandidateHealth[],
): Promise<void> {
  const lines = [
    ...tried.map((entry) => `${entry.name}: ${entry.reason}`),
    ...skipped.map((entry) => `${entry.name}: ${entry.reason ?? 'unavailable'} (skipped)`),
  ];
  const what = isCornerReview(assignment) ? 'the review' : `step "${assignment.role}"`;
  const prompt = `No healthy ${assignment.agent_class} agent took ${what}`.slice(0, 120);
  const detail = lines.length
    ? `Tried: ${lines.join('; ')}.`
    : 'No agent in this Room carries that class.';
  await ensureSystemIdentity(database);
  let choiceId: string | null = null;
  const constraint = detail.length > 160 ? `${detail.slice(0, 159)}…` : detail;
  try {
    const choice = await postRoomChoice(database, {
      roomId: assignment.dispatch_room_id,
      agentId: SYSTEM_IDENTITY_ID,
      mode: 'question',
      prompt,
      constraint,
      options: [
        {
          label: `Retry ${assignment.agent_class}`.slice(0, 32),
          consequence: `Send ${what} to the class again`.slice(0, 80),
        },
        { label: 'Stop', consequence: `Leave ${what} unassigned`.slice(0, 80) },
      ],
    });
    choiceId = choice.choiceId;
  } catch (error) {
    // One open system question per Room at a time; the line below still asks.
    console.error('[agent-classes] exhausted-class card not posted:', error);
  }
  // The line carries what the card could not: the whole list, or the ask itself.
  if (!choiceId || constraint !== detail)
    await announce(database, assignment.dispatch_room_id, {
      verb: 'could not assign',
      object: `${what} · class ${assignment.agent_class}`,
      consequence: detail,
      afterMessageId: assignment.source_message_id,
    });
  await database.query(
    `UPDATE class_assignments SET status='exhausted',current_agent_id=NULL,current_command_id=NULL,
       choice_id=$2,tried=$3::jsonb,updated_at=now() WHERE id=$1`,
    [assignment.id, choiceId, JSON.stringify(tried)],
  );
}

/**
 * Give the assignment's prompt to the next healthy agent in the class, or ask
 * a human when none is left. `failed` is the agent that just failed (if any).
 */
async function advanceAssignment(
  database: SqlDatabase,
  assignment: AssignmentRow,
  failed?: { agentId: string; reason: string },
  random: () => number = Math.random,
  retry = false,
): Promise<string | undefined> {
  const tried = [...assignment.tried];
  if (failed)
    tried.push({
      agentId: failed.agentId,
      name: await agentName(database, failed.agentId),
      reason: failed.reason,
    });
  const excluded = tried.map((entry) => entry.agentId);
  const reviewer = isCornerReview(assignment);
  if (!assignment.source_message_id) {
    await database.query(`UPDATE class_assignments SET status='stopped' WHERE id=$1`, [
      assignment.id,
    ]);
    return undefined;
  }
  let pick: string | undefined;
  let candidates: CandidateHealth[];
  if (reviewer) {
    const settled = await settleClassReviewer(
      database,
      assignment.candidate_room_id,
      excluded,
      random,
      retry,
    );
    candidates = settled?.candidates ?? [];
    pick = settled?.agentId;
  } else {
    candidates = await classCandidates(database, {
      roomId: assignment.candidate_room_id,
      agentClass: assignment.agent_class,
      ...(assignment.requested_by ? { requesterId: assignment.requested_by } : {}),
      retry,
    });
    pick = pickRandom(
      candidates.filter((candidate) => candidate.healthy && !excluded.includes(candidate.agentId)),
      random,
    )?.agentId;
  }
  if (!pick) {
    const skipped = candidates.filter(
      (candidate) => !candidate.healthy && !excluded.includes(candidate.agentId),
    );
    await askHumanForExhaustedClass(database, assignment, tried, skipped);
    return undefined;
  }
  let sourceMessageId = assignment.source_message_id;
  let command: { id: string } | undefined;
  const runId = workflowRunIdOf(assignment.run_key);
  if (runId) {
    // A workflow role is rebound on the run itself, so the new agent is the
    // one `handoff` accepts; the rebind card is the prompt it is woken on.
    // The rebind card itself says why, so the Room reads one line per handover.
    const rebound = await rebindWorkflowRole(database, {
      roomId: assignment.dispatch_room_id,
      runId,
      role: assignment.role,
      agentId: pick,
      ...(failed ? { reason: `${tried.at(-1)!.name}: ${failed.reason}` } : {}),
    });
    if (!rebound) {
      await database.query(
        `UPDATE class_assignments SET status='stopped',updated_at=now() WHERE id=$1`,
        [assignment.id],
      );
      return undefined;
    }
    sourceMessageId = rebound.cardId;
    command = await wakeCommand(database, assignment.dispatch_room_id, rebound.cardId, pick);
  } else {
    if (reviewer)
      await repairReviewerCornerMembership(database, assignment.dispatch_room_id, pick);
    command = await createAgentCommand(database, {
      roomId: assignment.dispatch_room_id,
      agentId: pick,
      sourceMessageId: assignment.source_message_id,
      reason: 'subscribed_event',
    });
  }
  if (!command) {
    // Membership vanished between the health read and dispatch: skip it.
    return advanceAssignment(
      database,
      { ...assignment, tried },
      { agentId: pick, reason: 'not a member of this Room' },
      random,
      retry,
    );
  }
  await database.query(
    `UPDATE class_assignments SET status='active',current_agent_id=$2,current_command_id=$3,
       attempt_started_at=now(),tried=$4::jsonb,choice_id=NULL,source_message_id=$5,
       updated_at=now() WHERE id=$1`,
    [assignment.id, pick, command.id, JSON.stringify(tried), sourceMessageId],
  );
  if (failed && !runId) await announceHandover(database, assignment, tried, pick);
  return pick;
}

async function announceHandover(
  database: SqlDatabase,
  assignment: AssignmentRow,
  tried: readonly TriedEntry[],
  pick: string,
): Promise<void> {
  const failed = tried.at(-1)!;
  await announce(database, assignment.dispatch_room_id, {
    agentId: failed.agentId,
    name: failed.name,
    verb: 'could not take',
    object: isCornerReview(assignment) ? 'the review' : `step ${assignment.role}`,
    consequence: `${failed.reason} · handed to ${await agentName(database, pick)}`,
    afterMessageId: assignment.source_message_id,
  });
}

/**
 * Called in the turn-receipt transaction for every failed turn. Flags the
 * agent's health on an instant failure and moves an active class assignment
 * held by that agent to the next healthy agent in its class.
 */
export async function failoverOnTurnFailure(
  database: SqlDatabase,
  input: {
    roomId: string;
    agentId: string;
    requestId: string;
    reason: string | null;
    reasonKind?: string;
  },
): Promise<string | undefined> {
  const kind = classifyTurnSilence(input.reason ?? undefined, input.reasonKind).kind;
  if (!INSTANT_FAILURE_KINDS.has(kind)) return undefined;
  await database.query(
    `INSERT INTO agent_health_flags(agent_id,kind,flagged_at) VALUES($1,$2,now())
     ON CONFLICT(agent_id) DO UPDATE SET kind=EXCLUDED.kind,flagged_at=now()`,
    [input.agentId, kind],
  );
  const assignment = (
    await database.query<AssignmentRow>(
      `SELECT assignment.* FROM class_assignments assignment
       JOIN agent_commands command ON command.id=assignment.current_command_id
       WHERE assignment.dispatch_room_id=$1 AND assignment.current_agent_id=$2
         AND assignment.status='active' AND command.turn_request_id=$3
       FOR UPDATE OF assignment`,
      [input.roomId, input.agentId, input.requestId],
    )
  ).rows[0];
  if (!assignment) return undefined;
  return advanceAssignment(database, assignment, {
    agentId: input.agentId,
    reason: FAILURE_PHRASES[kind] ?? kind,
  });
}

/** A completed turn settles the assignment it answered; the agent stays sticky. */
export async function settleOnTurnComplete(
  database: SqlDatabase,
  input: { roomId: string; agentId: string; requestId: string },
): Promise<void> {
  await database.query(
    `UPDATE class_assignments assignment SET status='done',updated_at=now()
     FROM agent_commands command
     WHERE command.id=assignment.current_command_id AND assignment.dispatch_room_id=$1
       AND assignment.current_agent_id=$2 AND assignment.status='active'
       AND command.turn_request_id=$3`,
    [input.roomId, input.agentId, input.requestId],
  );
}

/**
 * Background sweep: an attempt that has shown no turn activity for longer
 * than its step timeout moves to the next agent in the class.
 */
export async function sweepClassAssignmentTimeouts(
  database: SqlDatabase,
  random: () => number = Math.random,
): Promise<number> {
  const due = await database.query<{ id: string }>(
    `SELECT assignment.id FROM class_assignments assignment
     LEFT JOIN agent_commands command ON command.id=assignment.current_command_id
     LEFT JOIN agent_turns turn ON turn.room_id=assignment.dispatch_room_id
       AND turn.agent_id=assignment.current_agent_id AND turn.request_id=command.turn_request_id
     WHERE assignment.status='active'
       AND COALESCE(turn.status,'') NOT IN ('complete','cancelled')
       AND GREATEST(assignment.attempt_started_at,COALESCE(turn.created_at,assignment.attempt_started_at))
         < now()-make_interval(secs => assignment.timeout_seconds)
     ORDER BY assignment.attempt_started_at LIMIT 50`,
  );
  let moved = 0;
  for (const { id } of due.rows) {
    await database.transaction(async (db) => {
      const assignment = (
        await db.query<AssignmentRow>(
          `SELECT * FROM class_assignments WHERE id=$1 AND status='active' FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!assignment?.current_agent_id) return;
      if (assignment.current_command_id)
        await db.query(
          `UPDATE agent_commands SET state='cancelled',completed_at=now()
           WHERE id=$1 AND state='pending'`,
          [assignment.current_command_id],
        );
      await advanceAssignment(
        db,
        assignment,
        { agentId: assignment.current_agent_id, reason: FAILURE_PHRASES.timeout! },
        random,
      );
      moved += 1;
    });
  }
  return moved;
}

const WORKFLOW_RUN_KEY_PREFIX = 'workflow:';

function workflowRunIdOf(runKey: string): string | undefined {
  return runKey.startsWith(WORKFLOW_RUN_KEY_PREFIX)
    ? runKey.slice(WORKFLOW_RUN_KEY_PREFIX.length)
    : undefined;
}

/** The command a system line's `wakes` created for `agentId`. */
async function wakeCommand(
  database: SqlDatabase,
  roomId: string,
  sourceMessageId: string,
  agentId: string,
): Promise<{ id: string } | undefined> {
  return (
    await database.query<{ id: string }>(
      `SELECT id FROM agent_commands
       WHERE room_id=$1 AND source_message_id=$2 AND agent_id=$3 AND action='input'`,
      [roomId, sourceMessageId, agentId],
    )
  ).rows[0];
}

/**
 * A workflow role bound to a class (`class:<tier-or-tag>`) at run start: a
 * random healthy Room agent carrying it, under the requester's access
 * policy exactly as a mention would be. Undefined when none is healthy.
 */
export async function resolveClassBinding(
  database: SqlDatabase,
  input: { roomId: string; agentClass: string; requesterId?: string },
  random: () => number = Math.random,
): Promise<string | undefined> {
  const candidates = await classCandidates(database, input);
  return pickRandom(
    candidates.filter((candidate) => candidate.healthy),
    random,
  )?.agentId;
}

/**
 * Record that a class-bound workflow role was just woken for a state, so an
 * instant failure or silence rebinds it to the next healthy agent in the
 * class. The run's own bindings keep the agent for later states (sticky).
 */
export async function trackWorkflowClassRole(
  database: SqlDatabase,
  input: {
    roomId: string;
    runId: string;
    role: string;
    agentClass: string;
    agentId: string;
    sourceMessageId: string;
    requesterId?: string;
    timeoutSeconds?: number;
  },
): Promise<void> {
  const command = await wakeCommand(database, input.roomId, input.sourceMessageId, input.agentId);
  await database.query(
    `INSERT INTO class_assignments(id,candidate_room_id,dispatch_room_id,run_key,role,agent_class,
       requested_by,source_message_id,timeout_seconds,status,current_agent_id,current_command_id,
       attempt_started_at,tried)
     VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,now(),'[]'::jsonb)
     ON CONFLICT(candidate_room_id,run_key,role) DO UPDATE SET
       agent_class=EXCLUDED.agent_class,requested_by=EXCLUDED.requested_by,
       source_message_id=EXCLUDED.source_message_id,timeout_seconds=EXCLUDED.timeout_seconds,
       status='active',current_agent_id=EXCLUDED.current_agent_id,
       current_command_id=EXCLUDED.current_command_id,attempt_started_at=now(),
       tried='[]'::jsonb,choice_id=NULL,updated_at=now()`,
    [
      randomUUID(),
      input.roomId,
      `${WORKFLOW_RUN_KEY_PREFIX}${input.runId}`,
      input.role,
      input.agentClass,
      input.requesterId ?? null,
      input.sourceMessageId,
      Math.min(86_400, Math.max(30, input.timeoutSeconds ?? DEFAULT_CLASS_STEP_TIMEOUT_SECONDS)),
      input.agentId,
      command?.id ?? null,
    ],
  );
}

/**
 * A human answered the exhausted-class question: retry the whole class from
 * scratch, or stop the step.
 */
export async function settleExhaustedClassChoice(
  database: SqlDatabase,
  input: { choiceId: string; optionId: string },
): Promise<void> {
  const assignment = (
    await database.query<AssignmentRow>(
      `SELECT * FROM class_assignments WHERE choice_id=$1 AND status='exhausted' FOR UPDATE`,
      [input.choiceId],
    )
  ).rows[0];
  if (!assignment) return;
  const options = (
    await database.query<{ options: { optionId: string; letter: string }[] }>(
      `SELECT options FROM room_choices WHERE id=$1`,
      [input.choiceId],
    )
  ).rows[0]?.options;
  const retry = options?.[0]?.optionId === input.optionId;
  if (!retry) {
    await database.query(
      `UPDATE class_assignments SET status='stopped',choice_id=NULL,updated_at=now() WHERE id=$1`,
      [assignment.id],
    );
    return;
  }
  // The person who answered is the health check now: a fixed credit or
  // sign-in problem must not keep its agent out for the rest of the window.
  await advanceAssignment(database, { ...assignment, tried: [] }, undefined, Math.random, true);
}
