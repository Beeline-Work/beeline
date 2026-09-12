import { randomBytes } from 'node:crypto';
import type {
  AgentCommand,
  AgentCommandAction,
  RoomInboxResult,
} from '@beeline/api-contract/daemon';
import { parseAgentAccessPolicy, senderMayAddressAgent } from '@beeline/api-contract/agent-access';
import type { SqlDatabase } from './database.js';
import { taggedIdentityIdsSql, typedMentionHandles } from './message-mentions.js';

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
};

export function nextAgentDepth(parentDepth: number): number | undefined {
  return parentDepth < COMMAND_MAX_DEPTH ? parentDepth + 1 : undefined;
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
  const targets = new Set([...source.tagged_ids, ...(source.direct_participants ?? [])]);
  targets.delete(source.author_id);
  // An untagged top-level message continues only the immediately preceding
  // conversational agent message. Do not search farther back: intervening
  // human or agent traffic ends that continuity.
  let continuationAgent: string | undefined;
  if (!targets.size && typedMentionHandles(source.text).size === 0) {
    continuationAgent = (
      await db.query<{ author_id: string }>(
        `SELECT previous.author_id
         FROM messages current
         JOIN LATERAL (
           SELECT message.author_id
           FROM messages message
           WHERE message.room_id=current.room_id AND message.id<>current.id
             AND message.presentation='message'
           ORDER BY message.created_at DESC,message.id DESC LIMIT 1
         ) previous ON true
         JOIN identities identity ON identity.id=previous.author_id AND identity.kind='agent'
         WHERE current.id=$1 AND current.reply_to_message_id IS NULL`,
        [sourceId],
      )
    ).rows[0]?.author_id;
    if (continuationAgent) targets.add(continuationAgent);
  }
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
      reason:
        source.direct_participants
          ? 'direct_message'
          : continuationAgent === target
            ? 'human_continuation'
            : 'human_tag',
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
  if (input.kind === 'check-passed' || input.kind === 'check-failed') {
    const fact = (
      await db.query<{ owner_agent_id: string; state: string; command_check_state: string | null }>(
        `SELECT owner_agent_id,lifecycle->>'checks' state,command_check_state FROM corner_facts WHERE corner_id=$1 FOR UPDATE`,
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
      const carrier =
        (
          await db.query<{ agent_id: string }>(
            `SELECT agent_id FROM agent_commands WHERE room_id=$1 AND result_message_id IS NOT NULL ORDER BY completed_at DESC LIMIT 1`,
            [input.roomId],
          )
        ).rows[0]?.agent_id ?? fact.owner_agent_id;
      await createAgentCommand(db, {
        roomId: input.roomId,
        agentId: carrier,
        sourceMessageId: input.sourceMessageId,
        reason: 'corner_check',
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
        : input.kind === 'grant-decided'
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
