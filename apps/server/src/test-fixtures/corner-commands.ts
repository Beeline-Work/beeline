import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from '../database.js';

// Fixture command rows. Real code creates commands only through
// createAgentCommand (agent-command.ts); these seed completed history.

/**
 * A person's tag that assigned `agentId` in a corner, as `routeHumanMessage`
 * records it. The worker is derived from these commands (`cornerImplementerSql`);
 * the row is complete, so it wakes nobody.
 */
export async function assignCornerWorker(db: SqlDatabase, cornerId: string, agentId: string): Promise<void> {
  const id = `assign-${randomUUID()}`;
  await db.query(
    `INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,
       root_source_message_id,agent_depth,state,completed_at)
     VALUES($1,$2,$3,$1,'input','human_tag',$1,$1,0,'complete',now())`,
    [id, cornerId, agentId],
  );
}

/** Seed durable opening provenance without queueing work or a visible transcript. */
export async function seedCornerOpening(database: SqlDatabase, input: {
  cornerId: string;
  agentId?: string | null;
  commissionedBy?: string | null;
  fromRoomId?: string;
  requestId?: string;
  openKey?: string;
}): Promise<string> {
  const id = randomUUID();
  const root = randomUUID();
  if (input.commissionedBy) await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,deleted_at)
     SELECT $1,COALESCE(parent_id,id),$3,'Opening fixture',now() FROM rooms WHERE id=$2`,
    [root, input.cornerId, input.commissionedBy],
  );
  await database.query(
    `INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,
       action,reason,root_command_id,root_source_message_id,agent_depth,state,private_payload)
     SELECT $1,corner.id,COALESCE($3,(SELECT id FROM identities WHERE kind='agent' ORDER BY id LIMIT 1),corner.created_by),
       NULL,$4,'input','corner_objective',$1,$5,0,'complete',
       jsonb_build_object('text','Opening fixture','authorId',corner.created_by,
         'fromRoomId',COALESCE($6,corner.parent_id::text),'kind','order')
         || CASE WHEN $7::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('openKey',$7::text) END
     FROM rooms corner WHERE corner.id=$2`,
    [id,input.cornerId,input.agentId ?? null,input.requestId ?? id,root,input.fromRoomId ?? null,input.openKey ?? null],
  );
  return id;
}

/** A fixture corner row with exactly the facts a test names. */
export async function seedCornerFactsRow(
  db: SqlDatabase, cornerId: string, lifecycle: string | null, locked: boolean, reviewerAgentId: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO corner_facts(corner_id,lifecycle,locked,reviewer_agent_id)
     VALUES($1,COALESCE($2::jsonb,'{"lifecycle":"unknown","checks":"unknown"}'::jsonb),$3,$4)`,
    [cornerId, lifecycle, locked, reviewerAgentId],
  );
}
