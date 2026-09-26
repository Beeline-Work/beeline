import type { AgentGrantStatus } from '@beeline/api-contract/agent-grants';
import type { AgentGrantView, RoomViewIdentity } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { identitySubject, workspaceSystemLine } from './system-line.js';

const unix = (date: Date) => Math.floor(date.getTime() / 1_000);

/**
 * Settles one grant's entry on the latest `grant-request` card in place, so
 * the Room shows the answer where the question was asked.
 */
export async function settleGrantCard(
  database: SqlDatabase,
  input: {
    roomId: string;
    grantId: string;
    status: AgentGrantStatus;
    decidedBy: RoomViewIdentity;
    decidedAt: Date;
  },
) {
  const card = (
    await database.query<{ id: string; card: { grants: AgentGrantView[] } }>(
      `SELECT id,card FROM messages
       WHERE room_id=$1 AND card_type='grant-request'
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(card->'grants') entry WHERE entry->>'grantId'=$2
         )
       ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
      [input.roomId, input.grantId],
    )
  ).rows[0];
  if (!card) return;
  const grants = card.card.grants.map((entry) =>
    entry.grantId === input.grantId && entry.status === 'pending'
      ? {
          ...entry,
          status: input.status,
          decidedBy: input.decidedBy,
          decidedAt: unix(input.decidedAt),
        }
      : entry,
  );
  await database.query(
    `UPDATE messages SET card=jsonb_set(card,'{grants}',$2::jsonb) WHERE id=$1`,
    [card.id, JSON.stringify(grants)],
  );
}

/**
 * Retires an agent from one Workspace: the one set of effects behind
 * `PhoneService.removeAgent`, shared with the release-owned Welcome
 * retirement so neither copies a reduced subset. Runs inside the caller's
 * transaction.
 *
 * Ends its Workspace memberships, revokes every daemon token (the helper's
 * next call is refused `agent_removed` and it retires itself), hides the
 * identity from every roster, clears the agent's mutable configuration in
 * place (the row keeps grant/owner history), deletes its schedules here,
 * revokes its live grants here and settles their cards, and writes the
 * attributed `removed` line. Turns, messages and corners are untouched: a
 * corner is carried by its members and its PR is a shared artifact.
 */
export async function retireAgentFromWorkspace(
  database: SqlDatabase,
  input: {
    workspaceId: string;
    agentId: string;
    remover: RoomViewIdentity;
    removed: RoomViewIdentity;
  },
) {
  const { workspaceId, agentId, remover, removed } = input;
  await database.query(
    `UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2`,
    [workspaceId, agentId],
  );
  await database.query(`UPDATE daemon_tokens SET revoked_at=now() WHERE agent_id=$1`, [agentId]);
  // No surface may draw it as a member again, whatever it reads from.
  await database.query(
    `UPDATE identities SET hidden_from_roster=true,updated_at=now()
     WHERE id=$1 AND kind='agent'`,
    [agentId],
  );
  await database.query(
    `UPDATE agents SET soul=NULL,selected_model=NULL,selected_effort=NULL,
       model_catalog='[]'::jsonb,model_unavailable=NULL,commands='[]'::jsonb,
       schedule_ids='[]'::jsonb,
       yolo_mode=false,yolo_set_by=NULL,yolo_set_at=NULL,
       access_policy='{"type":"everyone"}'::jsonb,updated_at=now()
     WHERE agent_id=$1`,
    [agentId],
  );
  // Nothing may fire for an agent that is gone; occurrences cascade.
  await database.query(`DELETE FROM agent_schedules WHERE agent_id=$1 AND workspace_id=$2`, [
    agentId,
    workspaceId,
  ]);
  const revoked = await database.query<{ id: string; room_id: string; decided_at: Date }>(
    `UPDATE agent_grants SET status='revoked',decided_by=$3,decided_at=now()
     WHERE agent_id=$1 AND workspace_id=$2 AND status IN ('pending','approved','once')
     RETURNING id,room_id,decided_at`,
    [agentId, workspaceId, remover.pubkey],
  );
  for (const grant of revoked.rows)
    await settleGrantCard(database, {
      roomId: grant.room_id,
      grantId: grant.id,
      status: 'revoked',
      decidedBy: remover,
      decidedAt: grant.decided_at,
    });
  // Removal retires the helper; it never closes the corners. A corner is
  // carried by its MEMBERS, and the branch/PR is a shared artifact other
  // people may still land. The removed agent's `owner_agent_id` stays as
  // the historical "opened by"; the merge webhook and a human close still
  // reach the corner, and a later helper can be addressed in it.
  await workspaceSystemLine(database, {
    workspaceId,
    subject: identitySubject({ id: remover.pubkey, kind: remover.kind, name: remover.name }),
    verb: 'removed',
    object: { text: removed.name, id: removed.pubkey },
    cardType: 'member-removed',
    card: { identityId: agentId },
  });
}
