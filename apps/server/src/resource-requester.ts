import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';

type RequesterCommand = Pick<CommandRow, 'root_source_message_id'> & Partial<Pick<CommandRow, 'root_command_id'>>;
type RequesterSource = {
  author_id: string;
  room_id: string;
  workspace_id: string;
  text: string;
  agent_order: boolean;
  message_backed: boolean;
};
type Requester = {
  id: string;
  kind: 'human' | 'agent';
  name: string;
  handle: string | null;
  avatar: string | null;
};

/** Stored root provenance only; never borrow the executing agent's owner. */
export async function resourceRequester(
  db: SqlDatabase, command: RequesterCommand, options: { includeDeletedMessage?: boolean } = {},
) {
  const source = (await db.query<RequesterSource>(
    `SELECT message.author_id,message.room_id,room.workspace_id,message.text,true message_backed,
            EXISTS(SELECT 1 FROM agent_commands root WHERE root.id=$2
              AND root.root_command_id=root.id AND root.root_source_message_id=message.id
              AND root.reason IN ('order','agent_tag','mcp_call')) agent_order
     FROM messages message JOIN rooms room ON room.id=message.room_id
     WHERE message.id=$1 AND ($3::boolean OR message.deleted_at IS NULL)`,
    [command.root_source_message_id, command.root_command_id ?? null, options.includeDeletedMessage ?? false],
  )).rows[0] ?? (await db.query<RequesterSource>(
    `SELECT CASE WHEN root.reason='mcp_call' THEN root.agent_id
                ELSE root.private_payload->>'authorId' END author_id,
            root.room_id,room.workspace_id,COALESCE(root.private_payload->>'text','') text,
            author.kind='agent' agent_order,false message_backed
     FROM agent_commands root JOIN rooms room ON room.id=root.room_id
     JOIN identities author ON author.id=CASE WHEN root.reason='mcp_call' THEN root.agent_id
                                             ELSE root.private_payload->>'authorId' END
     WHERE root.id=$1 AND root.id=$2 AND root.root_command_id=root.id
       AND root.root_source_message_id=root.id
       AND root.source_message_id IS NULL AND root.parent_command_id IS NULL
       AND ((root.reason='order' AND root.private_payload->>'kind'='order'
             AND (author.kind='agent' OR author.id=$3))
         OR (root.reason='mcp_call' AND root.private_payload IS NULL AND author.kind='agent')
         OR (root.reason='report' AND root.private_payload->>'kind'='report'
           AND root.private_payload->>'automatic'='true'
           AND NULLIF(root.private_payload->>'idleSince','') IS NOT NULL AND author.id=$3))`,
    [command.root_command_id ?? null, command.root_source_message_id, SYSTEM_IDENTITY_ID],
  )).rows[0];
  if (!source) return undefined;
  // Agent-owned agents are followed to the first human owner. Cycles and
  // unowned MCP identities cannot supply authority for a command-only order.
  const requester = (await db.query<Requester>(
    `WITH RECURSIVE owners AS (
       SELECT identity.id,identity.kind,identity.name,identity.handle,identity.avatar,ARRAY[identity.id] path
       FROM identities identity WHERE identity.id=$1
       UNION ALL
       SELECT owner.id,owner.kind,owner.name,owner.handle,owner.avatar,chain.path||owner.id FROM owners chain
       JOIN agents agent ON agent.agent_id=chain.id AND chain.kind='agent'
       JOIN identities owner ON owner.id=agent.owner_id
       WHERE $2::boolean AND NOT owner.id=ANY(chain.path)
     ) SELECT id,kind,name,handle,avatar FROM owners ORDER BY cardinality(path) DESC LIMIT 1`,
    [source.author_id, source.agent_order],
  )).rows[0];
  if (source.agent_order && !source.message_backed && requester?.kind !== 'human') return undefined;
  return requester ? { requester, source } : undefined;
}

/** Institutional reads retain the root's Workspace boundary for private orders too. */
export async function resourceReadAuthority(
  db: SqlDatabase, command: RequesterCommand & Pick<CommandRow, 'room_id'>,
) {
  const resolved = await resourceRequester(db, command);
  if (!resolved || (!resolved.source.message_backed && !resolved.source.agent_order)) return undefined;
  const room = (await db.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM rooms WHERE id=$1', [command.room_id],
  )).rows[0];
  if (!room || room.workspace_id !== resolved.source.workspace_id) return undefined;
  return { workspace_id: room.workspace_id, requester_identity_id: resolved.requester.id, source: resolved.source };
}
