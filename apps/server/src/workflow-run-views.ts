import type {
  WorkflowActorView,
  WorkflowReadContract,
  WorkflowGateRecordView,
  WorkflowOpenedCornerView,
  WorkflowRunDetailView,
  WorkflowReceipt,
  WorkflowRunListResult,
  WorkflowRunStatus,
  WorkflowRunStepView,
  WorkflowRunSummaryView,
} from '@beeline/api-contract/phone';
import { workflowStepDisplayStatus } from '@beeline/api-contract/phone';
import { isAgentIdentityReference } from '@beeline/api-contract/daemon';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { WORKFLOW_HANDOFF_CARD_TYPE, workflowGatePrompt } from './workflow-runs.js';

/** Read-only projections of saved workflow runs for the phone.
 * Lifecycle bookkeeping is not a workflow run. Callers check Room read access;
 * every query also limits itself to rooms the viewer is a member of.
 */

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
  workspace_id: string;
  card_type: string;
  workflow_slug: string;
  workflow_version: number;
  to_state: string;
  run_status: WorkflowRunStatus;
  from_state: string | null;
  author_id: string;
  role_bindings: Record<string, string> | null;
  started_by: WorkflowActorView;
  start_kind: WorkflowRunSummaryView['startKind'];
  started_at: Date;
  updated_at: Date;
  contract_markdown: string | null;
  actor_rows: ActorRow[];
  viewer_row: ActorRow;
};

type RunHead = {
  runId: string;
  roomId: string;
  roomName: string;
  parentRoomId?: string;
  workspaceId: string;
  slug: string;
  version: number;
  /** Its contract: the pinned `slug@version`. */
  key: string;
  state: string;
  /** Saved on the start card whenever the run moves. */
  status: WorkflowRunStatus;
  /** The state the newest card left, when it is a handoff rather than the start. */
  fromState?: string;
  /** Author of the newest card. */
  authorId: string;
  roleBindings: Record<string, string>;
  startedBy: WorkflowActorView;
  startKind?: WorkflowRunSummaryView['startKind'];
  startedAt: number;
  updatedAt: number;
  /** Millisecond times for ordering runs that started within the same second. */
  updatedAtMs: number;
  contractMarkdown?: string;
  actorRows: ActorRow[];
  viewerRow: ActorRow;
};

function unix(date: Date): number {
  return Math.floor(new Date(date).getTime() / 1000);
}

const RUN_HEADS_SQL = `WITH scope AS (
         SELECT room.id,room.name,room.parent_id,room.workspace_id
         FROM rooms room
         WHERE (room.id=$1 OR room.parent_id=$1) AND ${VIEWER_CAN_READ_ROOM_SQL}
       ), starts AS (
         SELECT start.id,start.room_id,start.created_at,start.card,start.author_id
         FROM scope
         JOIN messages start ON start.room_id=scope.id
         WHERE start.card_type='workflow-handoff' AND start.id=start.card->>'runId'
           AND ($3::text IS NULL OR start.card->>'workflowSlug'=$3)
           AND ($4::text IS NULL OR start.id=$4)
       )
       SELECT start.id run_id,start.room_id,'workflow-handoff' card_type,
              scope.name room_name,scope.parent_id,scope.workspace_id,
              latest.card->>'workflowSlug' workflow_slug,
              COALESCE((latest.card->>'workflowVersion')::int,1) workflow_version,
              latest.card->>'toState' to_state,latest.card->>'fromState' from_state,
              latest.author_id,start.card->>'runStatus' run_status,
              latest.card->'roleBindings' role_bindings,
              start.created_at started_at,latest.created_at updated_at,
              jsonb_build_object('id',starter.id,'name',starter.name,'kind',starter.kind) started_by,
              start.card->>'startKind' start_kind,
              pinned.markdown contract_markdown,
              actors.actor_rows,
              jsonb_build_object('id',viewer.id,'name',viewer.name,'kind',viewer.kind,
                'handle',viewer.handle,'avatar',viewer.avatar,'face_id',viewer.face_id) viewer_row
       FROM starts start
       JOIN scope ON scope.id=start.room_id
       JOIN LATERAL (
         SELECT message.card,message.author_id,message.created_at
         FROM messages message
         WHERE message.room_id=start.room_id AND message.card_type='workflow-handoff'
           AND message.card->>'runId'=start.id
           AND message.card->>'runId' IS NOT NULL
         ORDER BY (message.card->>'seq')::int DESC NULLS LAST,
                  message.created_at DESC,message.id DESC LIMIT 1
       ) latest ON latest.card->>'toState' IS NOT NULL
       JOIN identities starter ON starter.id=start.author_id
       JOIN identities viewer ON viewer.id=$2
       LEFT JOIN workspace_skills skill ON skill.workspace_id=scope.workspace_id
         AND skill.kind='workflow' AND skill.slug=latest.card->>'workflowSlug'
       LEFT JOIN workspace_skill_versions pinned ON pinned.skill_id=skill.id
         AND pinned.version=COALESCE((latest.card->>'workflowVersion')::int,1)
       LEFT JOIN LATERAL (
         SELECT COALESCE(jsonb_agg(jsonb_build_object('id',actor.id,'name',actor.name,
           'kind',actor.kind,'handle',actor.handle,'avatar',actor.avatar,
           'face_id',actor.face_id)),'[]'::jsonb) actor_rows
         FROM identities actor
         WHERE actor.id IN (
           SELECT value FROM jsonb_each_text(CASE
             WHEN jsonb_typeof(latest.card->'roleBindings')='object'
               THEN latest.card->'roleBindings' ELSE '{}'::jsonb END)
           UNION SELECT latest.author_id
         )
       ) actors ON true
       ORDER BY (start.card->>'runStatus'='live') DESC,
                latest.created_at DESC,start.id DESC LIMIT 200`;

/**
 * The newest card of every run in `topRoomId` and its corners the viewer can
 * read, with the run's first-card time. Cards written in one transaction share
 * `created_at`, so a card's `seq` breaks the tie.
 */
async function loadRunHeads(
  db: SqlDatabase,
  topRoomId: string,
  viewerId: string,
  only?: { cardType: string; slug?: string; runId?: string },
): Promise<RunHead[] | null> {
  const result = (
    await db.query<{ heads: RunHeadRow[] }>(
      `WITH authorized AS (
         SELECT 1 FROM rooms room WHERE room.id=$1 AND ${VIEWER_CAN_READ_ROOM_SQL}
       ), heads AS (${RUN_HEADS_SQL})
       SELECT COALESCE((SELECT jsonb_agg(to_jsonb(head)) FROM heads head),'[]'::jsonb) heads
       FROM authorized`,
      [topRoomId, viewerId, only?.slug ?? null, only?.runId ?? null],
    )
  ).rows[0];
  return result ? result.heads.map(runHeadFromRow) : null;
}

function runHeadFromRow(row: RunHeadRow): RunHead {
  return {
      runId: row.run_id,
      roomId: row.room_id,
      roomName: row.room_name,
      ...(row.parent_id ? { parentRoomId: row.parent_id } : {}),
      workspaceId: row.workspace_id,
      slug: row.workflow_slug,
      version: row.workflow_version,
      key: `${row.workflow_slug}@${row.workflow_version}`,
      state: row.to_state,
      status: row.run_status,
      ...(row.from_state ? { fromState: row.from_state } : {}),
      authorId: row.author_id,
      roleBindings: row.role_bindings ?? {},
      startedBy: row.started_by,
      ...(row.start_kind ? { startKind: row.start_kind } : {}),
      startedAt: unix(row.started_at),
      updatedAt: unix(row.updated_at),
      updatedAtMs: new Date(row.updated_at).getTime(),
      ...(row.contract_markdown ? { contractMarkdown: row.contract_markdown } : {}),
      actorRows: row.actor_rows,
      viewerRow: row.viewer_row,
  };
}

type ActorRow = {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  handle: string | null;
  avatar: string | null;
  face_id: string | null;
};

/** An identity as the run page draws it: name, handle, and what its mark needs. */
function actorView(row: ActorRow, publicOrigin: string): WorkflowActorView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    ...(row.handle ? { handle: row.handle } : {}),
    ...(row.avatar
      ? { avatar: row.avatar.startsWith('/') ? `${publicOrigin}${row.avatar}` : row.avatar }
      : {}),
    ...(row.face_id ? { face: row.face_id } : {}),
  };
}

/** The identity a saved workflow role binding names. */
function boundIdentityId(binding: string | undefined): string | undefined {
  if (!binding) return undefined;
  return isAgentIdentityReference(binding) ? binding : undefined;
}

function stateRole(contract: WorkflowReadContract, state: string): string | undefined {
  const declared = contract.handoffs[state];
  if (!declared || declared.kind === 'terminal') return undefined;
  return declared.role;
}

/**
 * Who the list should name. A live state uses its own role. A terminal has
 * none, so the row keeps the role that handed the run off, and otherwise the
 * person who wrote that card. The system identity is not a holder.
 */
function holderIdentityId(head: RunHead, contract: WorkflowReadContract): string | undefined {
  const current = stateRole(contract, head.state);
  if (current) return boundIdentityId(head.roleBindings[current]);
  if (head.status === 'live') return undefined;
  const left = head.fromState ? stateRole(contract, head.fromState) : undefined;
  const leftHolder = left ? boundIdentityId(head.roleBindings[left]) : undefined;
  if (leftHolder) return leftHolder;
  return head.authorId !== SYSTEM_IDENTITY_ID ? head.authorId : undefined;
}

function summarize(
  head: RunHead,
  contract: WorkflowReadContract,
  actors: ReadonlyMap<string, WorkflowActorView>,
  viewer: Pick<WorkflowActorView, 'id' | 'kind'>,
): WorkflowRunSummaryView {
  const { status } = head;
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
    startedBy: head.startedBy,
    ...(head.startKind ? { startKind: head.startKind } : {}),
  };
}

/**
 * The newest run of each workflow within each Room or corner: a live run
 * before an ended one, then the most recently moved. Ordered live first, then
 * by last movement.
 */
export async function listRoomWorkflowRuns(
  db: SqlDatabase,
  roomId: string,
  viewerId: string,
  workflowSlug?: string,
  publicOrigin = '',
): Promise<WorkflowRunListResult> {
  const heads = await loadRunHeads(
    db,
    roomId,
    viewerId,
    workflowSlug ? { cardType: WORKFLOW_HANDOFF_CARD_TYPE, slug: workflowSlug } : undefined,
  );
  if (!heads) throw new Error('room access denied');
  if (heads.length === 0) return { workflows: [] };
  const contracts = new Map<string, WorkflowReadContract>();
  for (const head of heads) {
    if (!head.contractMarkdown || contracts.has(head.key)) continue;
    try {
      contracts.set(head.key, JSON.parse(head.contractMarkdown) as WorkflowReadContract);
    } catch {
      // A bad pinned version hides that run alone.
    }
  }
  const readable = heads.filter((head) => contracts.has(head.key));
  const isLive = (head: RunHead) => head.status === 'live';
  const newest = new Map<string, RunHead>();
  for (const head of readable) {
    const scopeKey = `${head.roomId}:${head.slug}`;
    const current = newest.get(scopeKey);
    if (
      !current ||
      Number(isLive(head)) > Number(isLive(current)) ||
      (isLive(head) === isLive(current) && head.updatedAtMs > current.updatedAtMs)
    )
      newest.set(scopeKey, head);
  }
  const chosen = workflowSlug ? readable : [...newest.values()];
  const actors = new Map(chosen.flatMap((head) =>
    head.actorRows.map((row) => [row.id, actorView(row, publicOrigin)] as const)));
  const viewer = actorView(heads[0]!.viewerRow, publicOrigin);
  const workflows = chosen.map((head) => summarize(head, contracts.get(head.key)!, actors, viewer)).sort(
    (left, right) =>
      Number(right.status === 'live') - Number(left.status === 'live') ||
      right.updatedAt - left.updatedAt,
  );
  return { workflows };
}

/** Microseconds since the epoch, as text so the value survives the driver exactly. */
const MICROS = (column: string) => `(extract(epoch FROM ${column})*1000000)::bigint::text`;

type RunCardRow = {
  id: string;
  seq: number;
  output_turns: string[] | null;
  live_output: string | null;
  final_reply: WorkflowRunStepView['finalReply'] | null;
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
  author_handle: string | null;
  author_avatar: string | null;
  author_face_id: string | null;
  workflow_slug: string;
  card_type: string;
};

/** One stay in a state: the card that entered it, until the next card that moved the run. */
type Visit = { card: RunCardRow; attempts: number[]; from: number; until?: number };

function visitsOf(cards: readonly RunCardRow[]): Visit[] {
  const visits: Visit[] = [];
  for (const card of cards) {
    const previous = visits[visits.length - 1];
    if (card.reassigned) {
      previous?.attempts.push(card.seq);
    } else {
      if (previous) previous.until = Number(card.created_us);
      visits.push({ card, attempts: [card.seq], from: Number(card.created_us) });
    }
  }
  return visits;
}

const within = (visit: Visit, at: number) =>
  at >= visit.from && (visit.until === undefined || at < visit.until);

/**
 * Match gate cards by their recorded run and attempt, including reassignments
 * during the visit. Cards predating run ids use the prompt and visit window;
 * migrated run-linked cards always carry an attempt. An answered
 * card wins over the other cards posted during the same visit.
 */
type GateChoiceRow = {
  run_id: string | null; attempt: number | null; prompt: string;
  options: Array<{ optionId: string; letter: string; label: string; consequence: string }>;
  status: WorkflowGateRecordView['status']; created_us: string;
  option_id: string | null; answered_at: Date | null;
  voter_id: string | null; voter_name: string | null;
  voter_kind: 'human' | 'agent' | null; voter_handle: string | null;
  voter_avatar: string | null; voter_face_id: string | null;
};

function loadGateRecords(
  runId: string,
  contract: WorkflowReadContract,
  visits: readonly Visit[],
  publicOrigin: string,
  choices: GateChoiceRow[],
): Map<Visit, WorkflowGateRecordView> {
  const records = new Map<Visit, WorkflowGateRecordView>();
  const gates = visits.filter((visit) => contract.handoffs[visit.card.to_state]?.kind === 'gate');
  if (gates.length === 0) return records;
  // The card that left a gate carries the exit receipt; when a person settled
  // the gate from chat, its `exit.sourceMessageId` is the answer's message.
  const transition = new Map<Visit, RunCardRow>();
  visits.forEach((visit, index) => {
    const next = visits[index + 1]?.card;
    if (next) transition.set(visit, next);
  });
  for (const visit of gates) {
    const prompt = workflowGatePrompt(contract, visit.card.to_state);
    const mine = choices.filter(
      (choice) => choice.run_id !== null
        ? choice.run_id === runId && choice.attempt !== null && visit.attempts.includes(choice.attempt)
        : choice.prompt === prompt && within(visit, Number(choice.created_us)),
    );
    const choice = mine.find((entry) => entry.status === 'answered') ?? mine[mine.length - 1];
    if (!choice) continue;
    const picked = choice.options.find((option) => option.optionId === choice.option_id);
    const sourceMessageId = transition.get(visit)?.receipt?.exit?.sourceMessageId;
    records.set(visit, {
      status: choice.status,
      ...(picked ? { answer: picked.label } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
      ...(picked && choice.voter_id && choice.voter_name && choice.voter_kind
        ? {
            answeredBy: actorView(
              {
                id: choice.voter_id,
                name: choice.voter_name,
                kind: choice.voter_kind,
                handle: choice.voter_handle,
                avatar: choice.voter_avatar,
                face_id: choice.voter_face_id,
              },
              publicOrigin,
            ),
          }
        : {}),
      ...(picked && choice.answered_at ? { answeredAt: unix(choice.answered_at) } : {}),
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
function loadOpenedCorners(
  visits: readonly Visit[],
  readableRows: Array<{ id: string; name: string; parent_id: string }>,
): Map<Visit, WorkflowOpenedCornerView[]> {
  const opened = new Map<Visit, WorkflowOpenedCornerView[]>();
  const listed = new Map<Visit, string[]>();
  visits.forEach((visit, index) => {
    const ids = listedCornerIds(visits[index + 1]?.card.contents);
    if (ids.length > 0) listed.set(visit, ids);
  });
  if (listed.size === 0) return opened;
  const readable = new Map(readableRows.map((corner) => [corner.id, corner]));
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
  publicOrigin = '',
): Promise<WorkflowRunDetailView | null> {
  const loaded = (
    await db.query<RunHeadRow & {
      cards: RunCardRow[];
      choices: GateChoiceRow[];
      opened: Array<{ id: string; name: string; parent_id: string }>;
    }>(
      `WITH authorized AS (
         SELECT 1 FROM rooms room WHERE room.id=$1 AND ${VIEWER_CAN_READ_ROOM_SQL}
       ), run_head AS (${RUN_HEADS_SQL}), cards AS (
SELECT message.id,(message.card->>'seq')::int seq,output.output_turns,output.live_output,output.final_reply,
              message.card->>'fromState' from_state,message.card->>'outcome' outcome,
              message.card->>'toState' to_state,message.card->>'status' status,
              COALESCE((message.card->>'reassigned')::boolean,false) reassigned,
              CASE WHEN jsonb_typeof(message.card->'contents')='object'
                THEN message.card->'contents' END contents,
              message.card->'receipt' receipt,message.card->'roleBindings' role_bindings,
              message.created_at,${MICROS('message.created_at')} created_us,
              author.id author_id,author.name author_name,
              author.kind author_kind,author.handle author_handle,author.avatar author_avatar,
              author.face_id author_face_id,message.card->>'workflowSlug' workflow_slug,
              message.card_type
       FROM messages message
       JOIN identities author ON author.id=message.author_id
       LEFT JOIN LATERAL (
         SELECT array_agg(command.agent_id||':'||command.turn_request_id)
           FILTER (WHERE command.state='claimed' AND turn.status='working'
             AND turn.created_at>now()-interval '90 seconds') output_turns,
           (array_agg(live.body->>'latestChunk' ORDER BY live.updated_at DESC)
             FILTER (WHERE command.state='claimed' AND turn.status='working'
               AND turn.created_at>now()-interval '90 seconds' AND live.body->>'latestChunk' IS NOT NULL))[1] live_output,
           (array_agg(jsonb_build_object('messageId',reply.id,'text',reply.text)
             ORDER BY reply.created_at DESC,reply.id DESC)
             FILTER (WHERE command.state='complete' AND reply.id IS NOT NULL))[1] final_reply
         FROM jsonb_array_elements_text(COALESCE(message.card->'outputCommandIds','[]'::jsonb)) pinned(command_id)
         JOIN agent_commands command ON command.id=pinned.command_id AND command.room_id=message.room_id
         LEFT JOIN agent_turns turn ON turn.room_id=command.room_id
           AND turn.agent_id=command.agent_id AND turn.request_id=command.turn_request_id
         LEFT JOIN live_outputs live ON live.room_id=command.room_id
           AND live.agent_id=command.agent_id AND live.turn_id=command.turn_request_id AND live.kind='draft'
         LEFT JOIN messages reply ON reply.id=command.result_message_id
           AND reply.room_id=message.room_id AND reply.author_id=command.agent_id
           AND reply.request_id=command.turn_request_id AND reply.presentation='message'
         WHERE turn.status IS NULL OR turn.status<>'cancelled'
       ) output ON true
       WHERE message.room_id=$1 AND message.card_type='workflow-handoff'
         AND message.card->>'runId'=$4 AND message.card->>'toState' IS NOT NULL
       ORDER BY (message.card->>'seq')::int NULLS FIRST,message.created_at,message.id
      ), choices AS (
        SELECT message.card->>'runId' run_id,(message.card->>'attempt')::int attempt,
          choice.prompt,choice.options,choice.status,${MICROS('choice.created_at')} created_us,
          vote.option_id,vote.created_at answered_at,
          voter.id voter_id,voter.name voter_name,voter.kind voter_kind,
          voter.handle voter_handle,voter.avatar voter_avatar,voter.face_id voter_face_id
        FROM run_head JOIN room_choices choice ON choice.room_id=run_head.room_id
        JOIN messages message ON message.id=choice.message_id AND message.room_id=choice.room_id
        LEFT JOIN LATERAL (
          SELECT option_id,voter_id,created_at FROM room_choice_votes
          WHERE choice_id=choice.id ORDER BY created_at,voter_id LIMIT 1
        ) vote ON choice.mode='question'
        LEFT JOIN identities voter ON voter.id=vote.voter_id
        WHERE message.card->>'runId'=$4 OR
          (message.card->>'runId' IS NULL AND choice.created_at>=run_head.started_at)
        ORDER BY choice.created_at,choice.id
      ), opened AS (
        SELECT room.id,room.name,room.parent_id FROM run_head
        JOIN rooms room ON room.parent_id=COALESCE(run_head.parent_id,run_head.room_id)
        WHERE ${VIEWER_CAN_READ_ROOM_SQL} AND EXISTS (
          SELECT 1 FROM cards card
          CROSS JOIN LATERAL jsonb_array_elements(CASE
            WHEN jsonb_typeof(card.contents->'corners')='array'
              THEN card.contents->'corners' ELSE '[]'::jsonb END) listed
          WHERE listed->>'cornerId'=room.id::text
        )
      )
      SELECT run_head.*,
        COALESCE((SELECT jsonb_agg(to_jsonb(card) ORDER BY card.seq NULLS FIRST,
          card.created_at,card.id) FROM cards card),'[]'::jsonb) cards,
        COALESCE((SELECT jsonb_agg(to_jsonb(choice)) FROM choices choice),'[]'::jsonb) choices,
        COALESCE((SELECT jsonb_agg(to_jsonb(corner)) FROM opened corner),'[]'::jsonb) opened
      FROM authorized LEFT JOIN run_head ON true`,
      [input.roomId, viewerId, null, input.runId],
    )
  ).rows[0];
  if (!loaded) throw new Error('room access denied');
  if (!loaded.run_id) return null;
  const cards = loaded.cards.map((card) => ({
    ...card,created_at: new Date(card.created_at),
  }));
  if (cards.length === 0) return null;
  const head = runHeadFromRow(loaded);
  let contract: WorkflowReadContract | undefined;
  try {
    if (head.contractMarkdown) contract = JSON.parse(head.contractMarkdown) as WorkflowReadContract;
  } catch {
    // A bad pinned version hides this run alone.
  }
  if (!contract) return null;
  const visits = visitsOf(cards);
  const actors = new Map(head.actorRows.map((row) => [row.id, actorView(row, publicOrigin)]));
  const viewer = actorView(head.viewerRow, publicOrigin);
  const gates = loadGateRecords(input.runId, contract, visits, publicOrigin,
    loaded.choices.map((choice) => ({ ...choice,
      answered_at: choice.answered_at ? new Date(choice.answered_at) : null })));
  const corners = loadOpenedCorners(visits, loaded.opened);
  const roleHolders: Record<string, WorkflowActorView> = {};
  for (const [role, binding] of Object.entries(head.roleBindings)) {
    const holder = actors.get(boundIdentityId(binding) ?? '');
    if (holder) roleHolders[role] = holder;
  }
  const { status } = head;
  const history: WorkflowRunStepView[] = visits.map((visit, index) => {
    const { card } = visit;
    const next = visits[index + 1]?.card;
    const closedHere = next && next.to_state === card.to_state &&
      next.from_state === next.to_state && (next.status === 'failed' || next.status === 'abandoned');
    const gate = gates.get(visit);
    const opened = corners.get(visit);
    return {
      ...(card.from_state ? { fromState: card.from_state } : {}),
      ...(card.from_state && card.outcome ? { outcome: card.outcome } : {}),
      visitId: card.id,
      ...(card.output_turns?.length ? { outputTurns: card.output_turns } : {}),
      ...(card.live_output ? { liveOutput: card.live_output } : {}),
      ...(card.final_reply ? { finalReply: card.final_reply } : {}),
      toState: card.to_state,
      displayStatus: workflowStepDisplayStatus(contract, card.to_state, status, Boolean(next && !closedHere)),
      ...(card.status ? { status: card.status } : {}),
      actor: actorView(
        {
          id: card.author_id,
          name: card.author_name,
          kind: card.author_kind,
          handle: card.author_handle,
          avatar: card.author_avatar,
          face_id: card.author_face_id,
        },
        publicOrigin,
      ),
      at: unix(card.created_at),
      ...(card.receipt ? { receipt: card.receipt } : {}),
      ...(gate ? { gate } : {}),
      ...(opened ? { openedCorners: opened } : {}),
    };
  });
  return {
    run: summarize(head, contract, actors, viewer),
    contract,
    history,
    roleHolders,
    viewer,
  };
}
