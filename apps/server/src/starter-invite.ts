import { createHash, randomBytes } from 'node:crypto';
import { createCommunityInviteToken } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { recordOnboardingEvent } from './signin-funnel.js';

export async function postStarterInviteOffer(database: SqlDatabase, roomId: string, agentId: string, personId: string, publicOrigin: string) {
  const invite = await createStarterInvite(database, roomId, personId, publicOrigin);
  const beebee = (await database.query<{ agent_id: string }>(
    `SELECT f.agent_id FROM free_agents f JOIN memberships m ON m.identity_id=f.agent_id
     AND m.room_id=$1 AND m.removed_at IS NULL WHERE f.owner_id=$2
     AND f.starter_role='beebee' AND f.removed_at IS NULL LIMIT 1`, [roomId, personId],
  )).rows[0];
  const messageId = randomBytes(32).toString('hex');
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`,
    [messageId, roomId, beebee?.agent_id ?? agentId, invite.message]);
  await recordOnboardingEvent(database, personId, 'invite_shared');
  return { ...invite, messageId };
}

export async function createStarterInvite(database: SqlDatabase, roomId: string, personId: string, publicOrigin: string) {
  const room = (await database.query<{ workspace_id: string; name: string }>(
    `SELECT r.workspace_id,r.name FROM rooms r
     JOIN memberships m ON m.room_id=r.id AND m.identity_id=$2 AND m.removed_at IS NULL
     JOIN memberships manager ON manager.workspace_id=r.workspace_id AND manager.room_id IS NULL
       AND manager.identity_id=$2 AND manager.removed_at IS NULL AND manager.role IN ('owner','admin')
     WHERE r.id=$1 AND r.parent_id IS NULL AND r.direct_participants IS NULL AND r.archived_at IS NULL`, [roomId, personId],
  )).rows[0];
  if (!room) throw new Error('Only a Room member who manages this Workspace can create an invite');
  const token = createCommunityInviteToken(randomBytes(32));
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await database.query(`INSERT INTO invites(token_hash,workspace_id,created_by,expires_at,onboarding_room_id,onboarding_created_at)
    VALUES($1,$2,$3,now()+interval '7 days',$4,clock_timestamp())`, [tokenHash, room.workspace_id, personId, roomId]);
  await recordOnboardingEvent(database, personId, 'invite_created');
  const url = new URL(`/join/${encodeURIComponent(token)}`, new URL(publicOrigin).hostname.endsWith('usebeeline.app') ? 'https://usebeeline.app' : publicOrigin).href;
  return { url, message: `Here's your invite link. Send it to anyone you want in this chat: ${url}` };
}
