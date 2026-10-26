import { createHash, randomBytes } from 'node:crypto';
import { createCommunityInviteToken } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { recordOnboardingEvent } from './signin-funnel.js';
import { postRoomChoice } from './room-choice.js';

export async function postStarterInviteOffer(database: SqlDatabase, roomId: string, agentId: string, personId: string, publicOrigin: string) {
  const share = await createStarterInvite(database, roomId, personId, publicOrigin);
  const existing = (await database.query<{ message_id: string }>(
    `SELECT c.message_id FROM room_choices c JOIN messages m ON m.id=c.message_id
     JOIN free_agents f ON f.agent_id=c.agent_id AND f.owner_id=$2
     WHERE c.room_id=$1 AND c.status='open' AND m.card->>'starterOnboarding' IN ('welcome','next') LIMIT 1`,
    [roomId, personId],
  )).rows[0];
  if (existing) {
    await database.query(`UPDATE messages SET card=card || $2::jsonb WHERE id=$1`,
      [existing.message_id, JSON.stringify({ starterShare: share })]);
    return { ...share, messageId: existing.message_id };
  }
  const choice = await postRoomChoice(database, { roomId, agentId, mode: 'question', prompt: 'Invite friends to this chat', options: [
    { label: 'Share this chat', consequence: 'Opens your share sheet with an invite link' },
    { label: 'Give us a real task', consequence: 'Beebee answers, then Luna checks the work' },
  ] });
  await database.query(`UPDATE messages SET card=card || $2::jsonb WHERE id=$1`,
    [choice.messageId, JSON.stringify({ starterOnboarding: 'next', starterShare: share })]);
  return { ...share, messageId: choice.messageId };
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
  return { url, message: `Join me in #${room.name} on Beeline: ${url}` };
}
