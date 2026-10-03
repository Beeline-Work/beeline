import { readWorkflowOwnership } from './workflow-ownership.js';
import type {
  WorkflowActorView,
  WorkflowContract,
  WorkflowGateRecordView,
  WorkflowOpenedCornerView,
  WorkflowRunDetailView,
  WorkflowReceipt,
  WorkflowRunListResult,
  WorkflowRunStatus,
  WorkflowRunStepView,
  WorkflowRunSummaryView,
} from '@beeline/api-contract/phone';
import { isAgentIdentityReference } from '@beeline/api-contract/daemon';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { CORNER_WORKFLOW_CONTRACT, CORNER_WORKFLOW_SLUG } from './corner-workflow.js';
import { CORNER_WORKFLOW_HANDOFF_CARD_TYPE } from './room-choice.js';
import { WORKFLOW_HANDOFF_CARD_TYPE, workflowGatePrompt } from './workflow-runs.js';

/**
 * Read-only projections of agent workflow runs for the phone: a corner's
 * workflow line and the run page. Runs have no
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
  from_state: string | null;
  author_id: string;
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
  /** The state the newest card left, when it is a handoff rather than the start. */
  fromState?: string;
  /** Author of the newest card. Corner lifecycle cards are the system identity. */
  authorId: string;
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
                message.card->>'toState' to_state,message.card->>'fromState' from_state,
                message.author_id,message.card->'roleBindings' role_bindings,
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
              cards.workflow_version,cards.to_state,cards.from_state,cards.author_id,
              cards.role_bindings,started.started_at,cards.created_at updated_at
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
    ...(row.from_state ? { fromState: row.from_state } : {}),
    authorId: row.author_id,
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

/**
 * Who the list should name. A live state uses its own role. A terminal has
 * none, so the row keeps the role that handed the run off, and otherwise the
 * person who wrote that card. The system identity writes corner lifecycle
 * cards and is not a holder.
 */
function holderIdentityId(head: RunHead, contract: WorkflowContract): string | undefined {
  const current = stateRole(contract, head.state);
  if (current) return boundIdentityId(head, head.roleBindings[current]);
  if (runStatus(contract, head.state) === 'live') return undefined;
  const left = head.fromState ? stateRole(contract, head.fromState) : undefined;
  const leftHolder = left ? boundIdentityId(head, head.roleBindings[left]) : undefined;
  if (leftHolder) return leftHolder;
  return head.authorId !== SYSTEM_IDENTITY_ID ? head.authorId : undefined;
}

function summarize(
  head: RunHead,
  contract: WorkflowContract,
  actors: ReadonlyMap<string, WorkflowActorView>,
  viewer: { id: string; kind: 'human' | 'agent' },
  earlierRunCount: number,
  activeRunIds: readonly string[] = [],
): WorkflowRunSummaryView {
  const status = runStatus(contract, head.state);
  const holderId = holderIdentityId(head, contract);
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
    ...(activeRunIds.length ? { activeRunIds: [...activeRunIds] } : {}),
  };
}

/** Every live run id, grouped by workflow slug, among the given heads. */
function liveRunIdsBySlug(
  heads: readonly RunHead[],
  contracts: ReadonlyMap<string, WorkflowContract>,
): Map<string, string[]> {
  const bySlug = new Map<string, string[]>();
  for (const head of heads) {
    const contract = contracts.get(`${head.slug}@${head.version}`);
    if (!contract || runStatus(contract, head.state) !== 'live') continue;
    const list = bySlug.get(head.slug) ?? [];
    list.push(head.runId);
    bySlug.set(head.slug, list);
  }
  return bySlug;
}

function headBindingIds(head: RunHead): string[] {
  return [...Object.values(head.roleBindings), head.authorId]
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
  workflowSlug?: string,
): Promise<WorkflowRunListResult> {
  const heads = await loadRunHeads(db, roomId, viewerId, workflowSlug);
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
  const chosen = workflowSlug ? readable : [...newest.values()];
  const [actors, viewer] = await Promise.all([
    loadActors(db, chosen.flatMap(headBindingIds)),
    loadViewer(db, viewerId),
  ]);
  const liveBySlug = liveRunIdsBySlug(readable, contracts);
  const workflows = (
    await Promise.all(
      chosen.map(async (head) => ({
        ...summarize(
          head,
          contracts.get(`${head.slug}@${head.version}`)!,
          actors,
          viewer,
          earlierThan(readable, head),
          liveBySlug.get(head.slug) ?? [],
        ),
        ...(await workflowStartInfo(db, head.roomId, head.runId)),
        ...(head.slug !== CORNER_WORKFLOW_SLUG
          ? { ownership: await readWorkflowOwnership(db, head.roomId, head.slug, viewerId) }
          : {}),
      })),
    )
  ).sort(
    (left, right) =>
      Number(right.status === 'live') - Number(left.status === 'live') ||
      right.updatedAt - left.updatedAt,
  );
  return { workflows };
}

/** Microseconds since the epoch, as text so the value survives the driver exactly. */
const MICROS = (column: string) => `(extract(epoch FROM ${column})*1000000)::bigint::text`;

type RunCardRow = {
  from_state: string | null;
  outcome: string | null;
  to_state: string;
  status: WorkflowRunStepView['status'] | null;
  reassigned: boolean;
  contents: Record<string, unknown> | null;
  receipt: WorkflowReceipt | null;
  role_bindings: Record<string, string> | null;
  created_at: Date;
  created_us: string;
  author_id: string;
  author_name: string;
  author_kind: 'human' | 'agent';
  workflow_slug: string;
};

/** One stay in a state: the card that entered it, until the next card that moved the run. */
type Visit = { card: RunCardRow; from: number; until?: number };

function visitsOf(cards: readonly RunCardRow[]): Visit[] {
  const moves = cards.filter((card) => !card.reassigned);
  return moves.map((card, index) => ({
    card,
    from: Number(card.created_us),
    ...(moves[index + 1] ? { until: Number(moves[index + 1]!.created_us) } : {}),
  }));
}

const within = (visit: Visit, at: number) =>
  at >= visit.from && (visit.until === undefined || at < visit.until);

/**
 * Each gate visit's choice card. The card does not name its run, so it is the
 * card with the gate's prompt posted in the run's Room during that visit;
 * a reassigned gate posts a second card, and the answered one wins.
 */
async function loadGateRecords(
  db: SqlDatabase,
  roomId: string,
  contract: WorkflowContract,
  visits: readonly Visit[],
): Promise<Map<Visit, WorkflowGateRecordView>> {
  const records = new Map<Visit, WorkflowGateRecordView>();
  const gates = visits.filter((visit) => contract.handoffs[visit.card.to_state]?.kind === 'gate');
  if (gates.length === 0) return records;
  const prompts = [...new Set(gates.map((visit) => workflowGatePrompt(contract, visit.card.to_state)))];
  const choices = (
    await db.query<{
      prompt: string;
      options: Array<{ optionId: string; letter: string; label: string; consequence: string }>;
      status: WorkflowGateRecordView['status'];
      created_us: string;
      option_id: string | null;
      answered_at: Date | null;
      voter_id: string | null;
      voter_name: string | null;
      voter_kind: 'human' | 'agent' | null;
      note: string | null;
    }>(
      `SELECT choice.prompt,choice.options,choice.status,${MICROS('choice.created_at')} created_us,
              vote.option_id,vote.created_at answered_at,vote.note,
              voter.id voter_id,voter.name voter_name,voter.kind voter_kind
       FROM room_choices choice
       LEFT JOIN LATERAL (
         SELECT option_id,voter_id,created_at,note FROM room_choice_votes
         WHERE choice_id=choice.id ORDER BY created_at,voter_id LIMIT 1
       ) vote ON choice.mode='question'
       LEFT JOIN identities voter ON voter.id=vote.voter_id
       WHERE choice.room_id=$1 AND choice.prompt=ANY($2::text[])
         AND choice.created_at>=$3
       ORDER BY choice.created_at,choice.id`,
      [roomId, prompts, gates[0]!.card.created_at],
    )
  ).rows;
  for (const visit of gates) {
    const prompt = workflowGatePrompt(contract, visit.card.to_state);
    const mine = choices.filter(
      (choice) => choice.prompt === prompt && within(visit, Number(choice.created_us)),
    );
    const choice = mine.find((entry) => entry.status === 'answered') ?? mine[mine.length - 1];
    if (!choice) continue;
    const picked = choice.options.find((option) => option.optionId === choice.option_id);
    records.set(visit, {
      question: choice.prompt,
      options: choice.options.map(({ letter, label, consequence }) => ({ letter, label, consequence })),
      status: choice.status,
      ...(picked ? { answer: picked.label } : {}),
      ...(picked && choice.voter_id && choice.voter_name && choice.voter_kind
        ? { answeredBy: { id: choice.voter_id, name: choice.voter_name, kind: choice.voter_kind } }
        : {}),
      ...(picked && choice.answered_at ? { answeredAt: unix(choice.answered_at) } : {}),
      ...(picked && choice.note ? { note: choice.note } : {}),
    });
  }
  return records;
}

/** The `cornerId`s a handoff lists under `corners`, in order. */
function listedCornerIds(contents: Record<string, unknown> | null | undefined): string[] {
  const corners = contents?.corners;
  if (!Array.isArray(corners)) return [];
  return corners.flatMap((corner: unknown) => {
    const id = (corner as { cornerId?: unknown } | null)?.cornerId;
    return typeof id === 'string' ? [id] : [];
  });
}

/**
 * Corners each visit opened: the `cornerId`s the handoff that left it lists
 * under `corners`. They are the top Room's corners, and only those the viewer
 * can read.
 */
async function loadOpenedCorners(
  db: SqlDatabase,
  topRoomId: string,
  viewerId: string,
  visits: readonly Visit[],
): Promise<Map<Visit, WorkflowOpenedCornerView[]>> {
  const opened = new Map<Visit, WorkflowOpenedCornerView[]>();
  const listed = new Map<Visit, string[]>();
  visits.forEach((visit, index) => {
    const ids = listedCornerIds(visits[index + 1]?.card.contents);
    if (ids.length > 0) listed.set(visit, ids);
  });
  if (listed.size === 0) return opened;
  const readable = new Map(
    (
      await db.query<{ id: string; name: string; parent_id: string }>(
        `SELECT room.id,room.name,room.parent_id FROM rooms room
         WHERE room.parent_id=$1 AND room.id::text=ANY($3::text[]) AND ${VIEWER_CAN_READ_ROOM_SQL}`,
        [topRoomId, viewerId, [...new Set([...listed.values()].flat())]],
      )
    ).rows.map((corner) => [corner.id, corner]),
  );
  for (const [visit, ids] of listed) {
    const mine = [...new Set(ids)].flatMap((id) => {
      const corner = readable.get(id);
      return corner ? [{ id: corner.id, name: corner.name, parentRoomId: corner.parent_id }] : [];
    });
    if (mine.length > 0) opened.set(visit, mine);
  }
  return opened;
}

/**
 * One run in `roomId`, with its pinned contract and every card in order: what
 * each step handed off, each gate's recorded answer, and the corners each step
 * opened. Null when unreadable.
 */
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
    await db.query<RunCardRow>(
      `SELECT message.card->>'fromState' from_state,message.card->>'outcome' outcome,
              message.card->>'toState' to_state,message.card->>'status' status,
              COALESCE((message.card->>'reassigned')::boolean,false) reassigned,
              CASE WHEN jsonb_typeof(message.card->'contents')='object'
                THEN message.card->'contents' END contents,
              message.card->'receipt' receipt,message.card->'roleBindings' role_bindings,
              message.created_at,${MICROS('message.created_at')} created_us,
              author.id author_id,author.name author_name,
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
  const contracts = await loadContracts(
    db,
    head.workspaceId,
    [...new Map(heads.map((entry) => [`${entry.slug}@${entry.version}`, entry])).values()],
  );
  const contract = contracts.get(`${head.slug}@${head.version}`);
  if (!contract) return null;
  const visits = visitsOf(cards);
  const [actors, viewer, gates, corners] = await Promise.all([
    loadActors(db, headBindingIds(head)),
    loadViewer(db, viewerId),
    loadGateRecords(db, input.roomId, contract, visits),
    loadOpenedCorners(db, topRoomId, viewerId, visits),
  ]);
  const roleHolders: Record<string, WorkflowActorView> = {};
  for (const [role, binding] of Object.entries(head.roleBindings)) {
    const holder = actors.get(boundIdentityId(head, binding) ?? '');
    if (holder) roleHolders[role] = holder;
  }
  const history: WorkflowRunStepView[] = visits.map((visit) => {
    const { card } = visit;
    const gate = gates.get(visit);
    const opened = corners.get(visit);
    return {
      ...(card.from_state ? { fromState: card.from_state } : {}),
      ...(card.from_state && card.outcome ? { outcome: card.outcome } : {}),
      toState: card.to_state,
      ...(card.status ? { status: card.status } : {}),
      actor: { id: card.author_id, name: card.author_name, kind: card.author_kind },
      at: unix(card.created_at),
      ...(card.contents ? { contents: card.contents } : {}),
      ...(card.receipt ? { receipt: card.receipt } : {}),
      ...(gate ? { gate } : {}),
      ...(opened ? { openedCorners: opened } : {}),
    };
  });
  const activeRunIds = liveRunIdsBySlug(heads, contracts).get(head.slug) ?? [];
  return {
    ...(head.slug !== CORNER_WORKFLOW_SLUG
      ? { ownership: await readWorkflowOwnership(db, input.roomId, head.slug, viewerId) }
      : {}),
    run: {
      ...summarize(head, contract, actors, viewer, earlierThan(heads, head), activeRunIds),
      ...(await workflowStartInfo(db, head.roomId, head.runId)),
    },
    contract,
    history,
    roleHolders,
  };
}

async function workflowStartInfo(
  db: SqlDatabase,
  roomId: string,
  runId: string,
): Promise<Pick<WorkflowRunSummaryView, 'startedBy' | 'startKind'>> {
  const row = (
    await db.query<{
      id: string;
      name: string;
      kind: 'human' | 'agent';
      start_kind: 'owner' | 'schedule' | 'human_admin' | null;
    }>(
      `SELECT identity.id,identity.name,identity.kind,message.card->>'startKind' start_kind FROM messages message
    JOIN identities identity ON identity.id=message.author_id WHERE message.room_id=$1 AND message.id=$2`,
      [roomId, runId],
    )
  ).rows[0];
  return row
    ? {
        startedBy: { id: row.id, name: row.name, kind: row.kind },
        ...(row.start_kind ? { startKind: row.start_kind } : {}),
      }
    : {};
}
