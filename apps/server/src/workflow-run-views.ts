import type {
  WorkflowActorView,
  WorkflowContract,
  WorkflowRunDetailView,
  WorkflowRunListResult,
  WorkflowRunStatus,
  WorkflowRunStepView,
  WorkflowRunSummaryView,
} from '@beeline/api-contract/phone';
import { isAgentIdentityReference } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import { CORNER_WORKFLOW_CONTRACT, CORNER_WORKFLOW_SLUG } from './corner-workflow.js';
import { CORNER_WORKFLOW_HANDOFF_CARD_TYPE } from './room-choice.js';
import { WORKFLOW_HANDOFF_CARD_TYPE } from './workflow-runs.js';

/**
 * Read-only projections of agent workflow runs for the phone: the Scheduled
 * Work list, a corner's workflow line, and the run page's graph. Runs have no
 * table (`workflow-runs.ts`), so everything here is derived from the
 * `workflow-handoff` cards — and a corner's own `corner-workflow-handoff`
 * lifecycle cards — citing each run id. Callers check Room read access first;
 * every query here also limits itself to rooms the viewer is a member of.
 */

const RUN_CARD_TYPES = [WORKFLOW_HANDOFF_CARD_TYPE, CORNER_WORKFLOW_HANDOFF_CARD_TYPE];

/** The live role binding the corner contract's reviewer uses; resolved from the parent Room. */
const PARENT_REVIEWER_BINDING = 'live:parent.reviewer_agent_id';

/** The same membership rule as `PhoneService.hasRoomAccess`, inlined over `room`. */
const VIEWER_CAN_READ_ROOM_SQL = `EXISTS (
  SELECT 1 FROM memberships room_member
  WHERE room_member.room_id=room.id AND room_member.identity_id=$2
    AND room_member.removed_at IS NULL
    AND EXISTS (
      SELECT 1 FROM memberships workspace_member
      WHERE workspace_member.workspace_id=room.workspace_id
        AND workspace_member.room_id IS NULL AND workspace_member.identity_id=$2
        AND workspace_member.removed_at IS NULL
    )
)`;

type RunHeadRow = {
  run_id: string;
  room_id: string;
  room_name: string;
  parent_id: string | null;
  reviewer_agent_id: string | null;
  workspace_id: string;
  workflow_slug: string;
  workflow_version: number;
  to_state: string;
  role_bindings: Record<string, string> | null;
  started_at: Date;
  updated_at: Date;
};

type RunHead = {
  runId: string;
  roomId: string;
  roomName: string;
  parentRoomId?: string;
  reviewerAgentId?: string;
  workspaceId: string;
  slug: string;
  version: number;
  state: string;
  roleBindings: Record<string, string>;
  startedAt: number;
  updatedAt: number;
  /** Millisecond times for ordering runs that started within the same second. */
  startedAtMs: number;
  updatedAtMs: number;
};

function unix(date: Date): number {
  return Math.floor(new Date(date).getTime() / 1000);
}

/**
 * The newest card of every run in `topRoomId` and its corners the viewer can
 * read, with the run's first-card time. Cards written in one transaction share
 * `created_at`, so a corner card's `seq` breaks the tie.
 */
async function loadRunHeads(
  db: SqlDatabase,
  topRoomId: string,
  viewerId: string,
  slug?: string,
): Promise<RunHead[]> {
  const rows = (
    await db.query<RunHeadRow>(
      `WITH scope AS (
         SELECT room.id,room.name,room.parent_id,room.workspace_id,parent.reviewer_agent_id
         FROM rooms room
         LEFT JOIN rooms parent ON parent.id=room.parent_id
         WHERE (room.id=$1 OR room.parent_id=$1) AND ${VIEWER_CAN_READ_ROOM_SQL}
       ), cards AS (
         SELECT message.id,message.room_id,message.created_at,
                message.card->>'runId' run_id,message.card->>'workflowSlug' workflow_slug,
                COALESCE((message.card->>'workflowVersion')::int,1) workflow_version,
                message.card->>'toState' to_state,message.card->'roleBindings' role_bindings,
                (message.card->>'seq')::int seq
         FROM messages message
         JOIN scope ON scope.id=message.room_id
         WHERE message.card_type=ANY($3::text[]) AND message.card->>'runId' IS NOT NULL
           AND message.card->>'toState' IS NOT NULL
           AND ($4::text IS NULL OR message.card->>'workflowSlug'=$4)
       ), started AS (
         SELECT room_id,run_id,min(created_at) started_at FROM cards GROUP BY room_id,run_id
       )
       SELECT DISTINCT ON (cards.room_id,cards.run_id)
              cards.run_id,cards.room_id,scope.name room_name,scope.parent_id,
              scope.reviewer_agent_id,scope.workspace_id,cards.workflow_slug,
              cards.workflow_version,cards.to_state,cards.role_bindings,
              started.started_at,cards.created_at updated_at
       FROM cards
       JOIN scope ON scope.id=cards.room_id
       JOIN started ON started.room_id=cards.room_id AND started.run_id=cards.run_id
       ORDER BY cards.room_id,cards.run_id,cards.created_at DESC,cards.seq DESC NULLS LAST,
                cards.id DESC`,
      [topRoomId, viewerId, RUN_CARD_TYPES, slug ?? null],
    )
  ).rows;
  return rows.map((row) => ({
    runId: row.run_id,
    roomId: row.room_id,
    roomName: row.room_name,
    ...(row.parent_id ? { parentRoomId: row.parent_id } : {}),
    ...(row.reviewer_agent_id ? { reviewerAgentId: row.reviewer_agent_id } : {}),
    workspaceId: row.workspace_id,
    slug: row.workflow_slug,
    version: row.workflow_version,
    state: row.to_state,
    roleBindings: row.role_bindings ?? {},
    startedAt: unix(row.started_at),
    updatedAt: unix(row.updated_at),
    startedAtMs: new Date(row.started_at).getTime(),
    updatedAtMs: new Date(row.updated_at).getTime(),
  }));
}

/** Pinned contracts by `slug@version`; the built-in corner contract stands in if its seed is missing. */
async function loadContracts(
  db: SqlDatabase,
  workspaceId: string,
  pins: ReadonlyArray<{ slug: string; version: number }>,
): Promise<Map<string, WorkflowContract>> {
  const contracts = new Map<string, WorkflowContract>();
  if (pins.length === 0) return contracts;
  const rows = (
    await db.query<{ slug: string; version: number; markdown: string }>(
      `SELECT skill.slug,skillversion.version,skillversion.markdown
       FROM workspace_skills skill
       JOIN workspace_skill_versions skillversion ON skillversion.skill_id=skill.id
       WHERE skill.workspace_id=$1 AND skill.kind='workflow'
         AND (skill.slug,skillversion.version) IN (
           SELECT * FROM unnest($2::text[],$3::int[])
         )`,
      [workspaceId, pins.map((pin) => pin.slug), pins.map((pin) => pin.version)],
    )
  ).rows;
  for (const row of rows) {
    try {
      contracts.set(`${row.slug}@${row.version}`, JSON.parse(row.markdown) as WorkflowContract);
    } catch {
      // An unreadable stored contract leaves the run out rather than failing the list.
    }
  }
  for (const pin of pins)
    if (pin.slug === CORNER_WORKFLOW_SLUG && !contracts.has(`${pin.slug}@${pin.version}`))
      contracts.set(`${pin.slug}@${pin.version}`, CORNER_WORKFLOW_CONTRACT);
  return contracts;
}

async function loadActors(
  db: SqlDatabase,
  ids: Iterable<string>,
): Promise<Map<string, WorkflowActorView>> {
  const unique = [...new Set(ids)].filter(isAgentIdentityReference);
  if (unique.length === 0) return new Map();
  const rows = (
    await db.query<WorkflowActorView>(
      `SELECT id,name,kind FROM identities WHERE id=ANY($1::text[])`,
      [unique],
    )
  ).rows;
  return new Map(rows.map((row) => [row.id, { id: row.id, name: row.name, kind: row.kind }]));
}

/** The identity a role binding names: an agent id, or the parent Room's reviewer for the corner's live binding. */
function boundIdentityId(head: RunHead, binding: string | undefined): string | undefined {
  if (!binding) return undefined;
  if (binding === PARENT_REVIEWER_BINDING) return head.reviewerAgentId;
  return isAgentIdentityReference(binding) ? binding : undefined;
}

function stateRole(contract: WorkflowContract, state: string): string | undefined {
  const declared = contract.handoffs[state];
  if (!declared || declared.kind === 'terminal') return undefined;
  return declared.role;
}

function runStatus(contract: WorkflowContract, state: string): WorkflowRunStatus {
  const declared = contract.handoffs[state];
  return declared?.kind === 'terminal' ? declared.status : 'live';
}

function summarize(
  head: RunHead,
  contract: WorkflowContract,
  actors: ReadonlyMap<string, WorkflowActorView>,
  viewer: { id: string; kind: 'human' | 'agent' },
  earlierRunCount: number,
): WorkflowRunSummaryView {
  const status = runStatus(contract, head.state);
  const role = stateRole(contract, head.state);
  const holderId = role ? boundIdentityId(head, head.roleBindings[role]) : undefined;
  const holder = holderId ? actors.get(holderId) : undefined;
  const isGate = contract.handoffs[head.state]?.kind === 'gate';
  return {
    runId: head.runId,
    workflowSlug: head.slug,
    description: contract.description,
    roomId: head.roomId,
    roomName: head.roomName,
    ...(head.parentRoomId ? { parentRoomId: head.parentRoomId } : {}),
    state: head.state,
    status,
    ...(holder ? { holder } : {}),
    // A gate is a choice card any person in the Room answers.
    viewerHolds:
      status === 'live' && (holderId === viewer.id || (isGate && viewer.kind === 'human')),
    startedAt: head.startedAt,
    updatedAt: head.updatedAt,
    earlierRunCount,
  };
}

function headBindingIds(head: RunHead): string[] {
  return Object.values(head.roleBindings)
    .map((binding) => boundIdentityId(head, binding))
    .filter((id): id is string => id !== undefined);
}

async function loadViewer(
  db: SqlDatabase,
  viewerId: string,
): Promise<{ id: string; kind: 'human' | 'agent' }> {
  const row = (
    await db.query<{ kind: 'human' | 'agent' }>(`SELECT kind FROM identities WHERE id=$1`, [
      viewerId,
    ])
  ).rows[0];
  return { id: viewerId, kind: row?.kind ?? 'human' };
}

function earlierThan(heads: readonly RunHead[], head: RunHead): number {
  return heads.filter(
    (other) =>
      other.slug === head.slug &&
      other.runId !== head.runId &&
      (other.startedAtMs < head.startedAtMs ||
        (other.startedAtMs === head.startedAtMs && other.runId < head.runId)),
  ).length;
}

/**
 * The newest run of each workflow in `roomId` and its corners: a live run
 * before an ended one, then the most recently moved. Ordered live first, then
 * by last movement.
 */
export async function listRoomWorkflowRuns(
  db: SqlDatabase,
  roomId: string,
  viewerId: string,
): Promise<WorkflowRunListResult> {
  const heads = await loadRunHeads(db, roomId, viewerId);
  if (heads.length === 0) return { workflows: [] };
  const workspaceId = heads[0]!.workspaceId;
  const contracts = await loadContracts(
    db,
    workspaceId,
    [...new Map(heads.map((head) => [`${head.slug}@${head.version}`, head])).values()].map(
      (head) => ({ slug: head.slug, version: head.version }),
    ),
  );
  const readable = heads.filter((head) => contracts.has(`${head.slug}@${head.version}`));
  const isLive = (head: RunHead) =>
    runStatus(contracts.get(`${head.slug}@${head.version}`)!, head.state) === 'live';
  const newest = new Map<string, RunHead>();
  for (const head of readable) {
    const current = newest.get(head.slug);
    if (
      !current ||
      Number(isLive(head)) > Number(isLive(current)) ||
      (isLive(head) === isLive(current) && head.updatedAtMs > current.updatedAtMs)
    )
      newest.set(head.slug, head);
  }
  const chosen = [...newest.values()];
  const [actors, viewer] = await Promise.all([
    loadActors(db, chosen.flatMap(headBindingIds)),
    loadViewer(db, viewerId),
  ]);
  const workflows = chosen
    .map((head) =>
      summarize(
        head,
        contracts.get(`${head.slug}@${head.version}`)!,
        actors,
        viewer,
        earlierThan(readable, head),
      ),
    )
    .sort(
      (left, right) =>
        Number(right.status === 'live') - Number(left.status === 'live') ||
        right.updatedAt - left.updatedAt,
    );
  return { workflows };
}

/** One run in `roomId`, with its pinned contract and every card in order. Null when unreadable. */
export async function readWorkflowRun(
  db: SqlDatabase,
  input: { roomId: string; runId: string },
  viewerId: string,
): Promise<WorkflowRunDetailView | null> {
  const room = (
    await db.query<{ parent_id: string | null }>(`SELECT parent_id FROM rooms WHERE id=$1`, [
      input.roomId,
    ])
  ).rows[0];
  if (!room) return null;
  const topRoomId = room.parent_id ?? input.roomId;
  const cards = (
    await db.query<{
      from_state: string | null;
      outcome: string | null;
      to_state: string;
      status: WorkflowRunStepView['status'] | null;
      reassigned: boolean;
      created_at: Date;
      author_id: string;
      author_name: string;
      author_kind: 'human' | 'agent';
      workflow_slug: string;
    }>(
      `SELECT message.card->>'fromState' from_state,message.card->>'outcome' outcome,
              message.card->>'toState' to_state,message.card->>'status' status,
              COALESCE((message.card->>'reassigned')::boolean,false) reassigned,
              message.created_at,author.id author_id,author.name author_name,
              author.kind author_kind,message.card->>'workflowSlug' workflow_slug
       FROM messages message
       JOIN identities author ON author.id=message.author_id
       WHERE message.room_id=$1 AND message.card_type=ANY($3::text[])
         AND message.card->>'runId'=$2 AND message.card->>'toState' IS NOT NULL
       ORDER BY message.created_at,(message.card->>'seq')::int NULLS FIRST,message.id`,
      [input.roomId, input.runId, RUN_CARD_TYPES],
    )
  ).rows;
  if (cards.length === 0) return null;
  const heads = await loadRunHeads(db, topRoomId, viewerId, cards[0]!.workflow_slug);
  const head = heads.find((entry) => entry.runId === input.runId && entry.roomId === input.roomId);
  if (!head) return null;
  const contract = (await loadContracts(db, head.workspaceId, [head])).get(
    `${head.slug}@${head.version}`,
  );
  if (!contract) return null;
  const [actors, viewer] = await Promise.all([
    loadActors(db, headBindingIds(head)),
    loadViewer(db, viewerId),
  ]);
  const roleHolders: Record<string, WorkflowActorView> = {};
  for (const [role, binding] of Object.entries(head.roleBindings)) {
    const holder = actors.get(boundIdentityId(head, binding) ?? '');
    if (holder) roleHolders[role] = holder;
  }
  const history: WorkflowRunStepView[] = cards
    .filter((card) => !card.reassigned)
    .map((card) => ({
      ...(card.from_state ? { fromState: card.from_state } : {}),
      ...(card.from_state && card.outcome ? { outcome: card.outcome } : {}),
      toState: card.to_state,
      ...(card.status ? { status: card.status } : {}),
      actor: { id: card.author_id, name: card.author_name, kind: card.author_kind },
      at: unix(card.created_at),
    }));
  return {
    run: summarize(head, contract, actors, viewer, earlierThan(heads, head)),
    contract,
    history,
    roleHolders,
  };
}
