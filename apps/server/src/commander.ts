import { createHash, randomBytes } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { createAgentCommand, type CommandRow } from './agent-command.js';
import { cornerImplementerSql } from './corner-worker.js';

export class CommandRefusalError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 409) { super(message); }
}

/** A report/lifecycle wake resumes the recipient's original incoming order. */
export async function commandOrder(db: SqlDatabase, command: CommandRow): Promise<CommandRow> {
  if (!command.private_payload || command.private_payload.kind === 'order') return command;
  return (await db.query<CommandRow>(
    `WITH RECURSIVE chain AS (
       SELECT command.*,0 hop FROM agent_commands command WHERE id=$1
       UNION ALL SELECT parent.*,child.hop+1 FROM agent_commands parent JOIN chain child
         ON parent.id=child.parent_command_id
     ) SELECT * FROM chain WHERE agent_id=$2
       AND (private_payload->>'kind'='order' OR private_payload IS NULL)
     ORDER BY hop LIMIT 1`, [command.id, command.agent_id],
  )).rows[0] ?? command;
}

/** An address is a Room id (including corners and DMs). Reach stays membership based. */
export async function commandAddress(db: SqlDatabase, address: string, agentId: string, allowArchived = false) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(address))
    throw new CommandRefusalError('address requires current membership', 403);
  const row = (await db.query<{ id: string; worker: string | null; parent_id: string | null }>(
    `SELECT room.id,room.parent_id,${cornerImplementerSql('fact', 'room')} worker
     FROM rooms room LEFT JOIN corner_facts fact ON fact.corner_id=room.id
     JOIN memberships member ON member.room_id IN (room.id,room.parent_id)
       AND member.identity_id=$2 AND member.removed_at IS NULL
     WHERE room.id=$1 AND ($3::boolean OR room.archived_at IS NULL)
     LIMIT 1 FOR SHARE OF room,member`, [address, agentId, allowArchived],
  )).rows[0];
  if (!row) throw new CommandRefusalError('address requires current membership', 403);
  return row;
}

export async function sendOrder(
  db: SqlDatabase, command: CommandRow, agentId: string, address: string, text: string,
) {
  if (!text.trim() || text.length > 16_000) throw new CommandRefusalError('order text must be 1 to 16000 characters', 400);
  const target = await commandAddress(db, address, agentId);
  const workers = target.parent_id
    ? target.worker ? [target.worker] : []
    : (await db.query<{ id: string }>(
      `SELECT identity.id FROM memberships member JOIN identities identity
         ON identity.id=member.identity_id AND identity.kind='agent'
       WHERE member.room_id=$1 AND member.removed_at IS NULL AND identity.id<>$2`,
      [address, agentId],
    )).rows.map(row => row.id);
  if (!workers.length) throw new CommandRefusalError('address has no working agent', 409);
  const commands = [];
  for (const worker of workers) {
    const queued = await createAgentCommand(db, {
      id: createHash('sha256').update(`order:${command.id}:${address}:${worker}:${text}`).digest('hex'),
      roomId: address, agentId: worker, sourceMessageId: null,
      privatePayload: { text, authorId: agentId, fromRoomId: command.room_id, kind: 'order' },
      reason: 'order', parent: command, retainDepth: true,
    });
    if (!queued) throw new CommandRefusalError('order recipient is no longer a member', 403);
    commands.push(queued.id);
  }
  return { id: commands[0]!, createdAt: Math.floor(Date.now() / 1000) };
}

/** Derive the return route from the open command or the current order; no work ledger. */
export async function reportToCommander(
  db: SqlDatabase, roomId: string, agentId: string, text: string,
  command?: CommandRow, reportId = randomBytes(32).toString('hex'),
) {
  if (!/^(done|blocked|needs-decision|failed):\s*\S/.test(text) || text.length > 16_000)
    throw new CommandRefusalError('report must begin done:, blocked:, needs-decision: or failed:', 400);
  if (command) command = await commandOrder(db, command);
  const corner = (await db.query<{ created_by: string; return_room: string; parent_command: string | null }>(
    `SELECT room.created_by,COALESCE(parent.room_id,source.room_id,room.parent_id) return_room,
       parent.id parent_command
     FROM rooms room
     LEFT JOIN LATERAL (SELECT * FROM agent_commands opened
       WHERE opened.room_id=room.id AND opened.reason='corner_objective'
       ORDER BY opened.created_at,opened.id LIMIT 1) opened ON true
     LEFT JOIN agent_commands parent ON parent.id=opened.parent_command_id
     LEFT JOIN messages source ON source.id=opened.root_source_message_id
     WHERE room.id=$1 AND room.parent_id IS NOT NULL`, [roomId],
  )).rows[0];
  let recipient: string | undefined;
  let returnRoom: string | undefined;
  let parent = command;
  if (corner) {
    recipient = corner.created_by;
    returnRoom = corner.return_room;
    if (corner.parent_command)
      parent = (await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`,
        [corner.parent_command])).rows[0];
  } else if (command?.private_payload?.kind === 'order') {
    recipient = command.private_payload.authorId;
    returnRoom = command.private_payload.fromRoomId;
    if (command.parent_command_id)
      parent = (await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`,
        [command.parent_command_id])).rows[0];
  } else if (command) {
    const source = (await db.query<{ author_id: string; room_id: string }>(
      `SELECT author_id,room_id FROM messages WHERE id=$1`, [command.root_source_message_id],
    )).rows[0];
    recipient = source?.author_id;
    returnRoom = source?.room_id;
  }
  if (!recipient || !returnRoom) {
    if (command) throw new CommandRefusalError('this order has no commander return address', 409);
    console.error(`[commander] ${roomId}: cannot route report without recorded opening provenance`);
    return { id: reportId, createdAt: Math.floor(Date.now() / 1000), delivered: false };
  }
  const member = (await db.query<{ kind: string }>(
    `SELECT identity.kind FROM memberships member JOIN identities identity ON identity.id=member.identity_id
     JOIN rooms room ON room.id=member.room_id AND room.archived_at IS NULL
     WHERE member.room_id=$1 AND member.identity_id=$2 AND member.removed_at IS NULL
     FOR SHARE OF member,room`, [returnRoom, recipient],
  )).rows[0];
  if (!member) {
    if (command) throw new CommandRefusalError('commander is no longer a member of the return address', 403);
    console.error(`[commander] ${roomId}: return address no longer has its commander`);
    return { id: reportId, createdAt: Math.floor(Date.now() / 1000), delivered: false };
  }
  if (member.kind === 'agent') {
    const queued = await createAgentCommand(db, {
      id: reportId, roomId: returnRoom, agentId: recipient, sourceMessageId: null,
      privatePayload: { text, authorId: agentId, fromRoomId: roomId, kind: 'report' },
      parent, retainDepth: true, reason: 'report',
    });
    if (!queued) throw new CommandRefusalError('commander could not receive report', 409);
  } else {
    // Only a human address is a chat message; private coordination never enters messages.
    await db.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation)
       VALUES($1,$2,$3,$4,'message') ON CONFLICT(id) DO NOTHING`,
      [reportId, returnRoom, agentId, text],
    );
  }
  return { id: reportId, createdAt: Math.floor(Date.now() / 1000) };
}
