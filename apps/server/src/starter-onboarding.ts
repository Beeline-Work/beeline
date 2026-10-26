import { randomBytes } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { postRoomChoice } from './room-choice.js';
import { readFile } from 'node:fs/promises';
import { identityFaceDataUri } from './identity-face.js';
import type { ObjectService } from './object-service.js';
import { recordOnboardingEvent } from './signin-funnel.js';

const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

async function buildStarterGame(database: SqlDatabase, roomId: string, userId: string) {
  const members = (await database.query<{ id: string; name: string; kind: 'human' | 'agent'; face_id: string | null; starter_role: string | null }>(
    `SELECT i.id,i.name,i.kind,i.face_id,f.starter_role FROM memberships m JOIN identities i ON i.id=m.identity_id
     LEFT JOIN free_agents f ON f.agent_id=i.id AND f.owner_id=$2 AND f.removed_at IS NULL AND f.starter_role IS NOT NULL
     WHERE m.room_id=$1 AND m.removed_at IS NULL AND (i.id=$2 OR f.agent_id IS NOT NULL)
     ORDER BY f.created_at,i.name`, [roomId, userId],
  )).rows;
  const person = members.find(member => member.id === userId);
  // The onboarding roles survive an agent rename; Luna is the second provisioned teammate.
  const agents = members.filter(member => member.kind === 'agent');
  const rival = agents.find(member => member.starter_role === 'luna') ?? agents[1];
  const ally = agents.find(member => member.id !== rival?.id);
  if (!person || !ally || !rival) throw new Error('Your starter team is no longer in this Room');
  const [userFace, allyFace, rivalFace] = await Promise.all([person, ally, rival].map(identityFaceDataUri));
  const data = { user: { name: person.name, face: userFace }, ally: { name: ally.name, face: allyFace }, rival: { name: rival.name, face: rivalFace } };
  const template = await readFile(new URL('../assets/game.template.html', import.meta.url), 'utf8');
  const values: Record<string, string> = {
    __USER_FACE__: userFace!, __ALLY_FACE__: allyFace!, __RIVAL_FACE__: rivalFace!,
    __ALLY_NAME__: escapeHtml(ally.name), __RIVAL_NAME__: escapeHtml(rival.name),
    __GAME_DATA__: JSON.stringify(data).replaceAll('<', '\\u003c'),
  };
  return { html: template.replace(/__(?:USER_FACE|ALLY_FACE|RIVAL_FACE|ALLY_NAME|RIVAL_NAME|GAME_DATA)__/g, token => values[token]!), ally, rival };
}

async function postStarterNextStep(database: SqlDatabase, roomId: string, agentId: string) {
  const choice = await postRoomChoice(database, {
    roomId, agentId, mode: 'question', prompt: 'After your game, what next?', options: [
      { label: 'Invite a friend to play', consequence: 'Opens your share sheet with a link to this chat' },
      { label: 'Give us a real task', consequence: 'Your team answers, then checks the work' },
    ],
  });
  await database.query(`UPDATE messages SET created_at=clock_timestamp(),card=card || '{"starterOnboarding":"next"}'::jsonb WHERE id=$1`, [choice.messageId]);
  return choice;
}

export async function postStarterGame(database: SqlDatabase, objects: ObjectService | undefined, roomId: string, userId: string) {
  if (!objects) throw new Error('Object storage is not configured');
  const game = await buildStarterGame(database, roomId, userId);
  const stored = await objects.uploadArtifact(game.rival.id, Buffer.from(game.html), 'application/vnd.beeline.game+html', 'Tic-tac-toe', database);
  await database.query(`INSERT INTO messages(id,room_id,author_id,text,attachments,created_at,card)
    VALUES($1,$2,$3,$4,$5::jsonb,clock_timestamp(),'{"starterOnboarding":"game"}'::jsonb)`, [
    randomBytes(32).toString('hex'), roomId, game.rival.id,
    `Game on. You and ${game.ally.name} play against me. Tap Open to start.`,
    JSON.stringify([{ url: stored.url, name: stored.title, mimeType: stored.mimeType, size: stored.size }]),
  ]);
  await postStarterNextStep(database, roomId, game.ally.id);
  await recordOnboardingEvent(database, userId, 'game_posted');
}

const STARTER_EXPLANATION = `Most AI apps give you one assistant in a private chat. Beeline is a team.
- **Several AIs, one chat.** Luna and I run on different models and check each other's work.
- **Your people too.** Invite friends or coworkers. Everyone sees the same conversation.
- **Big jobs get a side thread.** We plan, do and check the work there, then bring you one thing to approve.`;

const STARTER_OPTIONS = [
  { label: 'Give us a task', consequence: 'Beebee answers, then Luna checks the work' },
  { label: 'Play a quick game with us', consequence: 'Tic-tac-toe: you and Beebee against Luna' },
  { label: 'Invite friends to this chat', consequence: 'Get a link to share' },
  { label: 'What makes Beeline special?', consequence: 'Meet your team and see how Beeline works' },
] as const;

export async function postStarterWelcome(database: SqlDatabase, input: {
  roomId: string; agentId: string; includeExplanation?: boolean;
}) {
  const choice = await postRoomChoice(database, {
    roomId: input.roomId, agentId: input.agentId, mode: 'question',
    prompt: 'What should we do first?',
    options: input.includeExplanation === false ? STARTER_OPTIONS.slice(0, 3) : [...STARTER_OPTIONS],
  });
  await database.query(`UPDATE messages SET created_at=clock_timestamp(),card=card || '{"starterOnboarding":"welcome"}'::jsonb WHERE id=$1`, [choice.messageId]);
  return choice;
}

export async function postStarterExplanation(database: SqlDatabase, roomId: string, agentId: string) {
  await database.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,clock_timestamp())`, [
    randomBytes(32).toString('hex'), roomId, agentId, STARTER_EXPLANATION,
  ]);
  return postStarterWelcome(database, { roomId, agentId, includeExplanation: false });
}
