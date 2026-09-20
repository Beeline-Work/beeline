import { createHash, randomBytes } from 'node:crypto';
import type {
  AgentCommand,
  AgentCommandAction,
  RoomInboxResult,
} from '@beeline/api-contract/daemon';
import { parseAgentAccessPolicy, senderMayAddressAgent } from '@beeline/api-contract/agent-access';
import { isResumeKind } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { taggedIdentityIdsSql } from './message-mentions.js';
import { systemLine } from './system-line.js';

export const COMMAND_LEASE_SECONDS = 90;
export const COMMAND_MAX_DEPTH = 3;
/**
 * source + explicit targets -> eligibility -> command (same transaction)
 * pending -> claimed(generation, lease) -> complete / cancelled
 * expired claimed -> claimed(new generation); late writers lose the row lock.
 * Transcript visibility never grants execution authority.
 */
export const AGENT_COMMAND_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_commands (
 id text PRIMARY KEY,
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 agent_id text NOT NULL REFERENCES identities(id),
 source_message_id text NOT NULL REFERENCES messages(id),
 turn_request_id text NOT NULL,
 action text NOT NULL CHECK(action IN ('input','resume','stop')),
 reason text NOT NULL,
 root_command_id text NOT NULL,
 parent_command_id text,
 root_source_message_id text NOT NULL,
 agent_depth integer NOT NULL CHECK(agent_depth BETWEEN 0 AND 3),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','complete','cancelled')),
 generation_id text,
 lease_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 claimed_at timestamptz,
 completed_at timestamptz,
 result_message_id text REFERENCES messages(id),
 UNIQUE(room_id,source_message_id,agent_id,action)
);
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS hiccup_attempts integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS agent_commands_delivery ON agent_commands(agent_id,room_id,state,created_at);
CREATE INDEX IF NOT EXISTS agent_commands_turn ON agent_commands(room_id,agent_id,turn_request_id);
ALTER TABLE agent_grants ADD COLUMN IF NOT EXISTS command_id text;
ALTER TABLE corner_facts ADD COLUMN IF NOT EXISTS command_check_state text;
ALTER TABLE agent_pending_attachments ADD COLUMN IF NOT EXISTS request_id text;
ALTER TABLE agent_pending_attachments ADD COLUMN IF NOT EXISTS generation_id text;
`;
export type CommandRow = {
  id: string;
  room_id: string;
  agent_id: string;
  source_message_id: string;
  turn_request_id: string;
  action: AgentCommandAction;
  reason: string;
  root_command_id: string;
  parent_command_id: string | null;
  root_source_message_id: string;
  agent_depth: number;
  state: 'pending' | 'claimed' | 'complete' | 'cancelled';
  generation_id: string | null;
  lease_expires_at: Date | null;
  result_message_id: string | null;
  hiccup_attempts: number;
};

/** Read the same root requester that cancelAgentTurn authorizes, including relayed turns. */
export function turnRootMessageSql(turn: 'turn' | 'written'): string {
  return `COALESCE((SELECT command.root_source_message_id FROM agent_commands command
    WHERE command.room_id=${turn}.room_id AND command.agent_id=${turn}.agent_id
      AND command.turn_request_id=${turn}.request_id
    ORDER BY command.created_at DESC,command.id DESC LIMIT 1),${turn}.request_id)`;
}

export function nextAgentDepth(parentDepth: number): number | undefined {
  return parentDepth < COMMAND_MAX_DEPTH ? parentDepth + 1 : undefined;
}
/**
 * A corner's configured reviewer must hold CORNER membership to read its
 * review commands (`DaemonService.access`), but nothing else maintains that
 * projection: a reviewer configured after a corner was opened (or one whose
 * corner membership was never written) leaves every green check in that
 * corner without a reachable reviewer. Left alone, `routeSystemCommand`
 * rerouted the REVIEW to the corner owner, whose daemon then ran the review
 * and posted its text under the OWNER's name — the producing agent's
 * authorship was lost. This repairs the reviewer's corner membership in the
 * caller's transaction — restoring a removed projection row too, because
 * `rooms.reviewer_agent_id` is the sole authority and a configured reviewer
 * still holding parent membership is a live review actor, not a removal
 * intent (a retired agent fails the parent-membership guard and is never
 * restored). The repair is silent: no join note, push, or wake belongs to it.
 * Returns whether the reviewer can now read the corner.
 */
export async function repairReviewerCornerMembership(
  db: SqlDatabase,
  cornerId: string,
  reviewerAgentId: string,
): Promise<boolean> {
  await db.query(
    `UPDATE memberships m SET removed_at=NULL,joined_at=now()
     FROM rooms corner
     WHERE corner.id=$1 AND corner.parent_id IS NOT NULL
       AND m.room_id=corner.id AND m.identity_id=$2 AND m.removed_at IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM memberships parent_member
         WHERE parent_member.room_id=corner.parent_id
           AND parent_member.identity_id=$2 AND parent_member.removed_at IS NULL
       )`,
    [cornerId, reviewerAgentId],
  );
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     SELECT parent.workspace_id,corner.id,$2,'member'
     FROM rooms corner
     JOIN rooms parent ON parent.id=corner.parent_id
     WHERE corner.id=$1 AND corner.parent_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM memberships parent_member
         WHERE parent_member.room_id=corner.parent_id
           AND parent_member.identity_id=$2 AND parent_member.removed_at IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM memberships corner_member
         WHERE corner_member.room_id=corner.id AND corner_member.identity_id=$2
       )`,
    [cornerId, reviewerAgentId],
  );
  const member = await db.query(
    `SELECT 1 FROM memberships m JOIN identities i ON i.id=m.identity_id AND i.kind='agent'
     WHERE m.room_id=$1 AND m.identity_id=$2 AND m.removed_at IS NULL`,
    [cornerId, reviewerAgentId],
  );
  return member.rowCount > 0;
}

const REVIEWER_NOT_PARENT_MEMBER = 'not a current member of the parent Room';
const REVIEWER_NOT_CORNER_MEMBER = 'not a current member of this corner';

/**
 * A configured reviewer that cannot be dispatched must be named in the corner,
 * not collapsed into the no-reviewer author path. Deterministic id so a later
 * retry of the same gap does not spam; leave command_check_state alone so the
 * next transition can still wake them once membership is restored.
 */
async function noteUnreachableReviewer(
  db: SqlDatabase,
  input: {
    cornerId: string;
    sourceMessageId: string;
    reviewerId: string;
    reviewerKind: string | null;
    reviewerName: string | null;
    reason: string;
  },
): Promise<void> {
  const id = createHash('sha256')
    .update(`beeline:${input.cornerId}:reviewer-unreachable:${input.reviewerId}:${input.reason}`)
    .digest('hex');
  await systemLine(db, {
    id,
    roomId: input.cornerId,
    subject: {
      kind: input.reviewerKind === 'human' ? 'person' : 'agent',
      id: input.reviewerId,
      name: input.reviewerName ?? 'the configured reviewer',
    },
    verb: 'could not be reached',
    consequence: input.reason,
    afterMessageId: input.sourceMessageId,
  });
}

export async function createAgentCommand(
  db: SqlDatabase,
  input: {
    roomId: string;
    agentId: string;
    sourceMessageId: string;
    reason: string;
    action?: AgentCommandAction;
    turnRequestId?: string;
    parent?: CommandRow;
    /** Lifecycle transfer/resumption retains the chain; only agent delegation increments. */
    retainDepth?: boolean;
  },
): Promise<CommandRow | undefined> {
  const depth = input.parent
    ? input.retainDepth
      ? input.parent.agent_depth
      : nextAgentDepth(input.parent.agent_depth)
    : 0;
  if (depth === undefined) return undefined;
  // Row locks make concurrent membership removal serialize with dispatch.
  const member = await db.query(
    `SELECT m.identity_id FROM memberships m JOIN rooms r ON r.id=m.room_id
 JOIN identities i ON i.id=m.identity_id AND i.kind='agent'
 WHERE m.room_id=$1 AND m.identity_id=$2 AND m.removed_at IS NULL AND r.archived_at IS NULL
 FOR SHARE OF m,r`,
    [input.roomId, input.agentId],
  );
  if (!member.rowCount) return undefined;
  const id = randomBytes(32).toString('hex');
  const result = await db.query<CommandRow>(
    `INSERT INTO agent_commands
 (id,room_id,agent_id,source_message_id,turn_request_id,action,reason,root_command_id,parent_command_id,root_source_message_id,agent_depth)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
 ON CONFLICT(room_id,source_message_id,agent_id,action) DO UPDATE SET id=agent_commands.id RETURNING *`,
    [
      id,
      input.roomId,
      input.agentId,
      input.sourceMessageId,
      input.turnRequestId ?? input.sourceMessageId,
      input.action ?? 'input',
      input.reason,
      input.parent?.root_command_id ?? id,
      input.parent?.id ?? null,
      input.parent?.root_source_message_id ?? input.sourceMessageId,
      depth,
    ],
  );
  return result.rows[0];
}

export async function routeHumanMessage(db: SqlDatabase, sourceId: string): Promise<void> {
  // Who this message tags is read in the SAME statement that reads the message.
  // Routing is on the write path of every human message in every Room, so the
  // tags cost no round trip of their own.
  const source = (
    await db.query<{
      room_id: string;
      author_id: string;
      text: string;
      direct_participants: string[] | null;
      tagged_ids: string[];
    }>(
      `SELECT m.room_id,m.author_id,m.text,r.direct_participants,
   ${taggedIdentityIdsSql('m')} tagged_ids
 FROM messages m JOIN identities i ON i.id=m.author_id AND i.kind='human'
 JOIN rooms r ON r.id=m.room_id
 WHERE m.id=$1`,
      [sourceId],
    )
  ).rows[0];
  if (!source) return;
  // A human message reaches an agent only when it addresses that agent: a
  // typed tag, or membership of a direct conversation. Nothing routes on
  // transcript adjacency — an untagged top-level message starts no turn.
  const targets = new Set([...source.tagged_ids, ...(source.direct_participants ?? [])]);
  targets.delete(source.author_id);
  for (const target of targets) {
    const agent = (
      await db.query<{ owner_id: string; access_policy: unknown }>(
        `SELECT a.owner_id,a.access_policy FROM agents a
   JOIN memberships m ON m.identity_id=$2 AND m.room_id=$3 AND m.removed_at IS NULL
   WHERE a.agent_id=$1 FOR SHARE OF a,m`,
        [target, source.author_id, source.room_id],
      )
    ).rows[0];
    if (
      !agent ||
      !senderMayAddressAgent(
        parseAgentAccessPolicy(agent.access_policy),
        source.author_id,
        agent.owner_id,
      )
    )
      continue;
    await createAgentCommand(db, {
      roomId: source.room_id,
      agentId: target,
      sourceMessageId: sourceId,
      reason: source.direct_participants ? 'direct_message' : 'human_tag',
    });
  }
}

export async function routeAgentResult(
  db: SqlDatabase,
  parent: CommandRow,
  sourceId: string,
): Promise<void> {
  // An agent-to-agent tag hands work on, so only an agent it names is a target;
  // a person this reply tags is reached by push and highlight, not by a turn.
  const source = (
    await db.query<{ tagged_agent_ids: string[] }>(
      `SELECT ARRAY(
     SELECT tagged.id FROM identities tagged
     WHERE tagged.id=ANY(${taggedIdentityIdsSql('m')}) AND tagged.kind='agent'
   ) tagged_agent_ids
   FROM messages m WHERE m.id=$1 AND m.room_id=$2 AND m.author_id=$3`,
      [sourceId, parent.room_id, parent.agent_id],
    )
  ).rows[0];
  if (!source) return;
  const targets = new Set(source.tagged_agent_ids);
  targets.delete(parent.agent_id);
  for (const agentId of targets)
    await createAgentCommand(db, {
      roomId: parent.room_id,
      agentId,
      sourceMessageId: sourceId,
      parent,
      reason: 'agent_tag',
    });
}

export async function claimAgentCommand(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
  commandId: string,
  generation: string,
): Promise<CommandRow> {
  if (!generation || generation.length > 200) throw new Error('command generation is required');
  const row = (
    await db.query<CommandRow & { turn_claimed: boolean }>(
      `WITH eligible AS MATERIALIZED (
           SELECT * FROM agent_commands
           WHERE id=$1 AND room_id=$2 AND agent_id=$3 AND
             (state='pending' OR (state='claimed' AND lease_expires_at<=now()) OR (state='claimed' AND generation_id=$4))
           FOR UPDATE
         ), working AS (
           INSERT INTO agent_turns(room_id,request_id,agent_id,status,generation_id)
           SELECT room_id,turn_request_id,agent_id,'working',$4 FROM eligible WHERE action<>'stop'
           ON CONFLICT(room_id,request_id,agent_id) DO UPDATE SET
             status='working',generation_id=EXCLUDED.generation_id,failure_reason=NULL,created_at=now()
           WHERE agent_turns.status<>'cancelled'
           RETURNING 1
         ), claimed AS (
           UPDATE agent_commands command SET state='claimed',generation_id=$4,
             lease_expires_at=now()+interval '90 seconds',claimed_at=now()
           FROM eligible
           WHERE command.id=eligible.id AND
             (eligible.action='stop' OR EXISTS(SELECT 1 FROM working))
           RETURNING command.*
         )
         SELECT claimed.*,true turn_claimed FROM claimed
         UNION ALL
         SELECT eligible.*,false turn_claimed FROM eligible
         WHERE eligible.action<>'stop' AND NOT EXISTS(SELECT 1 FROM working)`,
      [commandId, roomId, agentId, generation],
    )
  ).rows[0];
  if (!row) throw new Error('command claim conflict');
  if (!row.turn_claimed) throw new Error('command turn cancelled');
  return row;
}

export async function authorizeCommandOutput(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
  requestId: unknown,
  generation: unknown,
  allowCompleted = false,
): Promise<CommandRow> {
  const row =
    typeof requestId === 'string' && typeof generation === 'string'
      ? (
          await db.query<CommandRow & { turn_cancelled: boolean }>(
            `SELECT command.*,
               EXISTS(SELECT 1 FROM agent_turns turn
                 WHERE turn.room_id=command.room_id AND turn.agent_id=command.agent_id
                   AND turn.request_id=command.turn_request_id AND turn.status='cancelled') turn_cancelled
             FROM agent_commands command
             WHERE command.room_id=$1 AND command.agent_id=$2 AND command.turn_request_id=$3
               AND command.action IN ('input','resume') AND command.generation_id=$4
             ORDER BY command.created_at DESC,command.id DESC LIMIT 1 FOR UPDATE OF command`,
            [roomId, agentId, requestId, generation],
          )
        ).rows[0]
      : undefined;
  if (
    !row ||
    (row.state !== 'claimed' && !(allowCompleted && row.state === 'complete')) ||
    (row.state === 'claimed' &&
      (!row.lease_expires_at || row.lease_expires_at.getTime() <= Date.now()))
  ) {
    console.error('command output rejected', {
      command: row?.id,
      agent: agentId,
      room: roomId,
      generation: typeof generation === 'string' ? generation : undefined,
    });
    throw new Error('command output authority rejected');
  }
  if (row.turn_cancelled) throw new Error('command turn cancelled');
  return row;
}

/**
 * A failed receipt is bound to the command that asked, including a pending
 * corner-start command that never got a generation. Claimed output still
 * requires the stored generation; omitting it is how startup reports fail
 * without fabricating one.
 */
export async function authorizeFailedTurnOutput(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
  requestId: unknown,
  generation: unknown,
): Promise<CommandRow> {
  if (typeof generation === 'string' && generation) {
    return authorizeCommandOutput(db, roomId, agentId, requestId, generation);
  }
  const row =
    typeof requestId === 'string'
      ? (
          await db.query<CommandRow & { turn_cancelled: boolean }>(
            `SELECT command.*,
               EXISTS(SELECT 1 FROM agent_turns turn
                 WHERE turn.room_id=command.room_id AND turn.agent_id=command.agent_id
                   AND turn.request_id=command.turn_request_id AND turn.status='cancelled') turn_cancelled
             FROM agent_commands command
             WHERE command.room_id=$1 AND command.agent_id=$2 AND command.turn_request_id=$3
               AND command.action IN ('input','resume') AND command.state='pending'
             ORDER BY command.created_at DESC,command.id DESC LIMIT 1 FOR UPDATE OF command`,
            [roomId, agentId, requestId],
          )
        ).rows[0]
      : undefined;
  if (!row) {
    console.error('command output rejected', {
      agent: agentId,
      room: roomId,
      generation: typeof generation === 'string' ? generation : undefined,
    });
    throw new Error('command output authority rejected');
  }
  if (row.turn_cancelled) throw new Error('command turn cancelled');
  return row;
}

export async function readAgentCommands(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
): Promise<{ commandProtocol: 1; commands: AgentCommand[] }> {
  const rows = await db.query<
    CommandRow & {
      text: string;
      author_id: string;
      attachments: RoomInboxResult['items'][number]['attachments'];
      system_event: RoomInboxResult['items'][number]['systemEvent'];
      presentation: string;
      reply_to_message_id: string | null;
      reply_to_author_id: string | null;
      created_at: Date;
    }
  >(
    `SELECT c.*,CASE WHEN c.reason='corner_objective' THEN f.objective ELSE m.text END text,m.author_id,m.attachments,m.system_event,m.presentation,m.reply_to_message_id,(SELECT author_id FROM messages WHERE id=m.reply_to_message_id) reply_to_author_id FROM agent_commands c JOIN messages m ON m.id=c.source_message_id LEFT JOIN corner_facts f ON f.corner_id=c.room_id
 WHERE c.room_id=$1 AND c.agent_id=$2 AND (c.state='pending' OR (c.state='claimed' AND c.lease_expires_at<=now()))
   AND NOT (
     -- A review wake waits for the corner to go quiet. The checks-passed
     -- transition queues the configured reviewer the moment CI turns green,
     -- which is routinely while the corner's own worker is still mid-turn:
     -- two agents then stream into one transcript and can act on the same
     -- branch at once. Holding the wake here rather than at creation keeps
     -- the command durable and needs no completion hook: the daemon polls,
     -- and the row becomes deliverable as soon as no other agent in this
     -- corner holds a live lease. A dead worker cannot block it forever,
     -- because an expired lease no longer counts as busy.
     EXISTS(
       SELECT 1 FROM rooms corner
       JOIN rooms parent ON parent.id=corner.parent_id
       WHERE corner.id=c.room_id AND parent.reviewer_agent_id=c.agent_id
     )
     AND EXISTS(
       SELECT 1 FROM agent_commands busy
       WHERE busy.room_id=c.room_id AND busy.agent_id<>c.agent_id
         AND busy.state='claimed' AND busy.lease_expires_at>now()
     )
   )
 ORDER BY CASE c.action WHEN 'stop' THEN 0 WHEN 'resume' THEN 1 ELSE 2 END,c.created_at,c.id LIMIT 100`,
    [roomId, agentId],
  );
  return {
    commandProtocol: 1,
    commands: rows.rows.map((r) => ({
      id: r.id,
      roomId: r.room_id,
      agentId: r.agent_id,
      sourceMessageId: r.source_message_id,
      turnRequestId: r.turn_request_id,
      action: r.action,
      reason: r.reason,
      rootCommandId: r.root_command_id,
      ...(r.parent_command_id ? { parentCommandId: r.parent_command_id } : {}),
      rootSourceMessageId: r.root_source_message_id,
      agentDepth: r.agent_depth,
      source: {
        id: r.source_message_id,
        authorId: r.author_id,
        body: r.text,
        attachments: r.attachments ?? [],
        createdAt: Math.floor(r.created_at.getTime() / 1000),
        type: r.presentation,
        systemEvent: r.system_event,
        ...(r.reply_to_message_id ? { replyToMessageId: r.reply_to_message_id } : {}),
        ...(r.reply_to_author_id ? { replyToAuthorId: r.reply_to_author_id } : {}),
      },
    })),
  };
}

/** Compatibility is a projection of durable commands, never a history query. */
export async function commandInbox(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
): Promise<RoomInboxResult> {
  const { commands } = await readAgentCommands(db, roomId, agentId);
  return {
    dispatchVersion: 1,
    items: commands.map((c) => ({
      ...c.source,
      id: c.sourceMessageId,
      ...(c.action === 'stop'
        ? {
            type: 'system',
            requestId: c.turnRequestId,
            systemEvent: {
              kind: 'turn-cancelled' as const,
              subject: { kind: 'agent' as const, id: agentId, name: agentId },
              verb: 'stopped',
            },
          }
        : {}),
    })),
  };
}

export async function routeSystemCommand(
  db: SqlDatabase,
  input: {
    roomId: string;
    sourceMessageId: string;
    kind?: string;
    targets: readonly string[];
    requestId?: string;
    causeId?: string;
    commandId?: string;
  },
): Promise<void> {
  if (!input.kind) return;
  if (input.kind === 'merged') {
    // A corner merge is a lifecycle handoff back to the agent that opened it
    // from the parent Room. The durable completion card identifies that
    // corner; command creation still enforces current parent membership, so a
    // retired or removed opener is never revived by history.
    const responsible = (
      await db.query<{ agent_id: string }>(
        `SELECT fact.owner_agent_id agent_id
         FROM messages source
         JOIN rooms corner ON corner.id::text=source.card->>'cornerId'
         JOIN corner_facts fact ON fact.corner_id=corner.id
         WHERE source.id=$1 AND source.room_id=$2
           AND corner.parent_id=source.room_id
           AND source.card_type='daemon-fact'
           AND source.card->>'type'='corner-complete'`,
        [input.sourceMessageId, input.roomId],
      )
    ).rows[0]?.agent_id;
    if (responsible)
      await createAgentCommand(db, {
        roomId: input.roomId,
        agentId: responsible,
        sourceMessageId: input.sourceMessageId,
        reason: 'corner_merged',
      });
  }
  if (input.kind === 'check-passed' || input.kind === 'check-failed') {
    const fact = (
      await db.query<{
        owner_agent_id: string;
        configured_reviewer_id: string | null;
        configured_reviewer_kind: string | null;
        configured_reviewer_name: string | null;
        reviewer_agent_id: string | null;
        state: string;
        command_check_state: string | null;
      }>(
        `SELECT fact.owner_agent_id,
                parent.reviewer_agent_id configured_reviewer_id,
                configured.kind configured_reviewer_kind,
                configured.name configured_reviewer_name,
                (
                  SELECT reviewer_membership.identity_id
                  FROM memberships reviewer_membership
                  JOIN identities reviewer ON reviewer.id=reviewer_membership.identity_id
                    AND reviewer.kind='agent'
                  WHERE reviewer_membership.room_id=parent.id
                    AND reviewer_membership.identity_id=parent.reviewer_agent_id
                    AND reviewer_membership.removed_at IS NULL
                ) reviewer_agent_id,
                fact.lifecycle->>'checks' state,fact.command_check_state
         FROM corner_facts fact
         JOIN rooms corner ON corner.id=fact.corner_id
         JOIN rooms parent ON parent.id=corner.parent_id
         LEFT JOIN identities configured ON configured.id=parent.reviewer_agent_id
         WHERE fact.corner_id=$1
         FOR UPDATE OF fact`,
        [input.roomId],
      )
    ).rows[0];
    if (fact) {
      if (
        fact.state === 'pending' ||
        fact.state === 'unknown' ||
        fact.state === fact.command_check_state
      )
        return;
      // Failed checks still wake the opener. The author fallback is only for
      // corners with no reviewer configured — a configured id whose parent
      // membership is missing is not "no reviewer".
      if (input.kind === 'check-failed' || !fact.configured_reviewer_id) {
        const fallbackCarrier =
          (
            await db.query<{ agent_id: string }>(
              `SELECT agent_id FROM agent_commands WHERE room_id=$1 AND result_message_id IS NOT NULL ORDER BY completed_at DESC LIMIT 1`,
              [input.roomId],
            )
          ).rows[0]?.agent_id ?? fact.owner_agent_id;
        await createAgentCommand(db, {
          roomId: input.roomId,
          agentId: fallbackCarrier,
          sourceMessageId: input.sourceMessageId,
          reason: 'corner_check',
        });
        await db.query(`UPDATE corner_facts SET command_check_state=$2 WHERE corner_id=$1`, [
          input.roomId,
          fact.state,
        ]);
        return;
      }
      const unreachable = {
        cornerId: input.roomId,
        sourceMessageId: input.sourceMessageId,
        reviewerId: fact.configured_reviewer_id,
        reviewerKind: fact.configured_reviewer_kind,
        reviewerName: fact.configured_reviewer_name,
      };
      if (!fact.reviewer_agent_id) {
        await noteUnreachableReviewer(db, {
          ...unreachable,
          reason: REVIEWER_NOT_PARENT_MEMBER,
        });
        return;
      }
      // A green review belongs to the configured reviewer and to nobody else.
      // Dispatch it only when the reviewer can actually read the corner: the
      // missing corner-membership projection is repaired above (never an
      // explicitly removed one). If the reviewer stays unreachable, dispatch
      // NOTHING — the old reroute handed the review to the corner owner,
      // whose daemon posted the review text under the owner's name. Leave
      // command_check_state alone so a later green transition retries, and
      // name them in the corner instead of staying silent.
      const deliverable = await repairReviewerCornerMembership(
        db,
        input.roomId,
        fact.reviewer_agent_id,
      );
      if (!deliverable) {
        await noteUnreachableReviewer(db, {
          ...unreachable,
          reason: REVIEWER_NOT_CORNER_MEMBER,
        });
        return;
      }
      await createAgentCommand(db, {
        roomId: input.roomId,
        agentId: fact.reviewer_agent_id,
        sourceMessageId: input.sourceMessageId,
        reason: 'subscribed_event',
      });
      await db.query(`UPDATE corner_facts SET command_check_state=$2 WHERE corner_id=$1`, [
        input.roomId,
        fact.state,
      ]);
      return;
    }
  }
  for (const agentId of new Set(input.targets)) {
    const action =
      input.kind === 'turn-cancelled'
        ? 'stop'
        : isResumeKind(input.kind)
          ? 'resume'
          : 'input';
    let parent: CommandRow | undefined;
    if (action !== 'input') {
      parent = (
        await db.query<CommandRow>(
          `SELECT * FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND action IN ('input','resume')
    AND (($3::text IS NOT NULL AND turn_request_id=$3) OR ($4::text IS NOT NULL AND id=$4)) ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [input.roomId, agentId, input.requestId ?? null, input.commandId ?? null],
        )
      ).rows[0];
      if (!parent) continue;
      await db.query(
        `UPDATE agent_commands SET state=$4,completed_at=now() WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 AND state IN ('pending','claimed')`,
        [
          input.roomId,
          agentId,
          parent.turn_request_id,
          action === 'stop' ? 'cancelled' : 'complete',
        ],
      );
    } else if (input.kind.startsWith('agent:')) {
      parent = (
        await db.query<CommandRow>(
          `SELECT * FROM agent_commands WHERE room_id=$1 AND id=$2 AND state='claimed' ORDER BY created_at DESC LIMIT 1`,
          [input.roomId, input.commandId ?? null],
        )
      ).rows[0];
      if (!parent) continue;
    }
    await createAgentCommand(db, {
      roomId: input.roomId,
      agentId,
      sourceMessageId: input.sourceMessageId,
      action,
      reason:
        action === 'input'
          ? input.kind === 'schedule-ran'
            ? 'schedule'
            : 'subscribed_event'
          : action,
      ...(parent
        ? {
            parent,
            retainDepth: action !== 'input',
            turnRequestId: action !== 'input' ? parent.turn_request_id : undefined,
          }
        : {}),
    });
  }
}

/**
 * Restore the two durable projections of a configured reviewer.
 *
 * Room configuration is the dispatch authority. The subscription remains a
 * visible description of what wakes the reviewer, but losing or overwriting
 * that projection must not lose a review. Existing green heads are dispatched
 * from their latest check fact when no exact-head verdict has been recorded.
 */
export async function reconcileConfiguredCornerReviewers(
  db: SqlDatabase,
  parentRoomId?: string,
): Promise<{ subscriptions: number; commands: number }> {
  const subscriptions = await db.query(
    `UPDATE memberships reviewer_membership
     SET event_subscriptions=reviewer_membership.event_subscriptions||'["check-passed"]'::jsonb
     FROM rooms surface
     JOIN rooms parent ON parent.id=COALESCE(surface.parent_id,surface.id)
     WHERE reviewer_membership.room_id=surface.id
       AND reviewer_membership.identity_id=parent.reviewer_agent_id
       AND reviewer_membership.removed_at IS NULL
       AND NOT reviewer_membership.event_subscriptions @> '["check-passed"]'::jsonb
       AND ($1::uuid IS NULL OR parent.id=$1)`,
    [parentRoomId ?? null],
  );
  // Repair the reviewer corner-membership projection first: the candidates
  // join below requires the reviewer to already read every corner, and
  // nothing else ever wrote that row for corners opened before the reviewer
  // was configured (or after the row was removed some other way). A retired
  // reviewer has no current parent membership and is never restored.
  await db.query(
    `UPDATE memberships m SET removed_at=NULL,joined_at=now()
     FROM rooms corner
     JOIN rooms parent ON parent.id=corner.parent_id
     JOIN memberships parent_reviewer ON parent_reviewer.room_id=parent.id
       AND parent_reviewer.identity_id=parent.reviewer_agent_id
       AND parent_reviewer.removed_at IS NULL
     WHERE corner.parent_id IS NOT NULL AND corner.archived_at IS NULL
       AND m.room_id=corner.id AND m.identity_id=parent.reviewer_agent_id
       AND m.removed_at IS NOT NULL
       AND ($1::uuid IS NULL OR parent.id=$1)`,
    [parentRoomId ?? null],
  );
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     SELECT parent.workspace_id,corner.id,parent.reviewer_agent_id,'member'
     FROM rooms corner
     JOIN rooms parent ON parent.id=corner.parent_id
     JOIN memberships parent_reviewer ON parent_reviewer.room_id=parent.id
       AND parent_reviewer.identity_id=parent.reviewer_agent_id
       AND parent_reviewer.removed_at IS NULL
     WHERE corner.parent_id IS NOT NULL AND corner.archived_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM memberships corner_member
         WHERE corner_member.room_id=corner.id
           AND corner_member.identity_id=parent.reviewer_agent_id
       )
       AND ($1::uuid IS NULL OR parent.id=$1)`,
    [parentRoomId ?? null],
  );
  const candidates = await db.query<{
    corner_id: string;
    reviewer_agent_id: string;
    source_message_id: string;
  }>(
    `SELECT corner.id corner_id,parent.reviewer_agent_id,source.id source_message_id
     FROM rooms corner
     JOIN rooms parent ON parent.id=corner.parent_id
     JOIN corner_facts fact ON fact.corner_id=corner.id
     JOIN memberships parent_reviewer ON parent_reviewer.room_id=parent.id
       AND parent_reviewer.identity_id=parent.reviewer_agent_id
       AND parent_reviewer.removed_at IS NULL
     JOIN memberships corner_reviewer ON corner_reviewer.room_id=corner.id
       AND corner_reviewer.identity_id=parent.reviewer_agent_id
       AND corner_reviewer.removed_at IS NULL
     JOIN identities reviewer ON reviewer.id=parent.reviewer_agent_id AND reviewer.kind='agent'
     JOIN LATERAL (
       SELECT message.id
       FROM messages message
       WHERE message.room_id=corner.id
         AND message.system_event->>'kind'='check-passed'
         AND (message.system_event->'object'->>'headSha' IS NULL
              OR message.system_event->'object'->>'headSha'=fact.lifecycle->'pr'->>'headSha')
       ORDER BY message.created_at DESC,message.id DESC LIMIT 1
     ) source ON true
     WHERE corner.archived_at IS NULL
       AND fact.lifecycle->>'checks'='passing'
       AND fact.lifecycle->'pr'->>'number' IS NOT NULL
       AND fact.lifecycle->'pr'->>'headSha' IS NOT NULL
       AND ($1::uuid IS NULL OR parent.id=$1)
       AND NOT EXISTS (
         SELECT 1 FROM corner_merge_approvals approval
         WHERE approval.corner_id=corner.id
           AND approval.approved_by=parent.reviewer_agent_id
           AND approval.pull_request_number=(fact.lifecycle->'pr'->>'number')::integer
           AND approval.head_sha=fact.lifecycle->'pr'->>'headSha'
       )
       AND NOT EXISTS (
         SELECT 1 FROM agent_commands command
         WHERE command.room_id=corner.id
           AND command.agent_id=parent.reviewer_agent_id
           AND command.source_message_id=source.id
           AND command.action='input'
       )`,
    [parentRoomId ?? null],
  );
  let commands = 0;
  for (const candidate of candidates.rows) {
    const command = await createAgentCommand(db, {
      roomId: candidate.corner_id,
      agentId: candidate.reviewer_agent_id,
      sourceMessageId: candidate.source_message_id,
      reason: 'subscribed_event',
    });
    if (command) {
      commands += 1;
      await db.query(`UPDATE corner_facts SET command_check_state='passing' WHERE corner_id=$1`, [
        candidate.corner_id,
      ]);
    }
  }
  return { subscriptions: subscriptions.rowCount, commands };
}
