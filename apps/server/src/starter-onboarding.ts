import { CommandRefusalError } from './command-refusal.js';
import type { ObjectService } from './object-service.js';
import { randomBytes, randomUUID } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { postRoomChoice, skipRoomChoice } from './room-choice.js';
import { readFile } from 'node:fs/promises';
import { identityFaceDataUri } from './identity-face.js';
import { recordOnboardingEvent } from './signin-funnel.js';

export const STARTER_OPTIONS = [
  { label: 'Make a welcome video and post it to my YouTube', consequence: 'Beebee makes it, Luna checks it, you approve the post' },
  { label: 'Play tic-tac-toe with me', consequence: 'You and Beebee against Luna' },
  { label: 'Something else', consequence: 'Tell us the job in your own words' },
] as const;

export function starterHello(name: string) {
  return `Hi ${name.trim().split(/\s+/u)[0] || 'there'}, I'm Beebee and that's Luna. We're your free agents. We run on different AI models, so one of us does the work and the other checks it. What should we start on?`;
}

export async function postStarterWelcome(database: SqlDatabase, input: {
  roomId: string; agentId: string; userId?: string; manualUserId?: string; runId?: string;
}) {
  if (input.manualUserId) {
    const previous = (await database.query<{ id: string }>(
      `SELECT c.id FROM room_choices c JOIN messages m ON m.id=c.message_id
       WHERE c.room_id=$1 AND c.agent_id=$2 AND c.status='open'
       AND m.card->>'starterOnboarding' IN ('welcome','next') FOR UPDATE OF c`, [input.roomId, input.agentId],
    )).rows;
    for (const choice of previous) await skipRoomChoice(database, {
      choiceId: choice.id, viewerId: input.manualUserId,
    }, { wake: false });
  }
  const userId = input.userId ?? input.manualUserId ?? (await database.query<{ owner_id: string }>(
    `SELECT owner_id FROM free_agents WHERE agent_id=$1`, [input.agentId])).rows[0]?.owner_id;
  const person = (await database.query<{ name: string }>(`SELECT name FROM identities WHERE id=$1`, [userId])).rows[0];
  await database.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,clock_timestamp())`, [
    randomBytes(32).toString('hex'), input.roomId, input.agentId, starterHello(person?.name ?? 'there'),
  ]);
  const choice = await postRoomChoice(database, {
    roomId: input.roomId, agentId: input.agentId, mode: 'question',
    prompt: 'Pick a first job',
    options: STARTER_OPTIONS
      .map(option => ({ ...option })),
  });
  await database.query(`UPDATE messages SET created_at=clock_timestamp(),card=card || '{"starterOnboarding":"welcome","starterVersion":2}'::jsonb WHERE id=$1`, [choice.messageId]);
  if (input.manualUserId) {
    await database.query(`UPDATE messages SET card=card || $2::jsonb WHERE id=$1`, [choice.messageId,
      JSON.stringify({ onboardingManual: true, onboardingUserId: input.manualUserId, onboardingRunId: input.runId ?? randomUUID() })]);
  }
  if (userId) await recordOnboardingEvent(database, userId, 'welcome_shown', { roomId: input.roomId });
  return choice;
}

/** Only the starter YouTube job adds this preview-tap requirement to the existing app boundary. */
export async function consumeStarterVideoPost(database: SqlDatabase, roomId: string, agentId: string, args: Record<string, unknown>): Promise<{ messageId: string; attemptId: string } | undefined> {
  const welcome = (await database.query<{ selected: string | null; starter_version: string | null; created_at: Date }>(
    `SELECT m.card->>'selectedOptionId' selected,m.card->>'starterVersion' starter_version,m.created_at FROM messages m
     WHERE m.room_id=$1 AND m.card->>'starterOnboarding'='welcome'
       AND ((m.card->>'starterVersion'='2' AND m.card->>'selectedOptionId'='A')
         OR (m.card->>'starterVersion' IS DISTINCT FROM '2' AND m.card->>'selectedOptionId'='B'))
     ORDER BY m.created_at DESC,m.id DESC LIMIT 1`, [roomId])).rows[0];
  if (!welcome) return;
  const preview = (await database.query<{ id: string; card: { status?: string; selectedOptionId?: string; options?: { optionId: string; label: string }[]; youtubeUploadUsed?: boolean; videoPreview?: { videoObjectId: string; title: string; description: string; visibility: string } } }>(
    `SELECT m.id,m.card FROM messages m JOIN room_choices c ON c.message_id=m.id
     WHERE m.room_id=$1 AND m.author_id=$2 AND m.created_at>$3 AND m.card->>'starterOnboarding' IS NULL AND m.card->'videoPreview' IS NOT NULL
     ORDER BY m.created_at DESC,m.id DESC LIMIT 1 FOR UPDATE OF m`, [roomId, agentId, welcome.created_at])).rows[0];
  const card = preview?.card;
  if (!preview || !card?.videoPreview || card?.status !== 'answered' || card.youtubeUploadUsed ||
    card.options?.find(option => option.optionId === card.selectedOptionId)?.label !== 'Post')
    throw new CommandRefusalError('Show the video preview with Post and Cancel, and wait for the person to tap Post before uploading.', 403);
  const approved = card.videoPreview;
  const file = args.videoFile;
  const mismatch = args.title !== approved.title ? 'title'
    : args.description !== approved.description ? 'description'
    : args.privacyStatus !== approved.visibility ? 'privacyStatus'
    : !file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).length !== 1 ||
      (file as Record<string, unknown>).beelineObjectId !== approved.videoObjectId ? 'videoFile shape'
    : Object.keys(args).some(key => !['title', 'description', 'privacyStatus', 'videoFile', 'categoryId'].includes(key)) ? 'extra key'
    : args.categoryId !== undefined && args.categoryId !== '22' ? 'categoryId' : undefined;
  if (mismatch)
    throw new CommandRefusalError(`Upload arguments must match the approved video preview exactly: ${mismatch} mismatched. ` +
      'Use videoFile: {beelineObjectId: "<videoObjectId from the preview>"}. Show a new preview for any changes.', 403);
  const attemptId = randomUUID();
  await database.query(`UPDATE messages SET card=card || $2::jsonb WHERE id=$1`,
    [preview.id, JSON.stringify({ youtubeUploadUsed: true, youtubeUploadAttempt: attemptId })]);
  return { messageId: preview.id, attemptId };
}


export async function postStarterVideoPreview(database: SqlDatabase, objects: ObjectService | undefined,
  input: { roomId: string; agentId: string; videoObjectId: string; frameObjectId: string; title: string; description: string; visibility: 'public' | 'unlisted' | 'private' }) {
  if (!objects) throw new Error('Room files are unavailable');
  if (!input.title?.trim() || input.title.length > 100 || typeof input.description !== 'string' || Buffer.byteLength(input.description) > 5000 || !['public','unlisted','private'].includes(input.visibility))
    throw new Error('A title, description and valid visibility are required for the preview');
  const video = await objects.readRoomObject(input.roomId, input.agentId, input.videoObjectId, database);
  const frame = await objects.readRoomObject(input.roomId, input.agentId, input.frameObjectId, database);
  if (!video?.mimeType.startsWith('video/') || !frame?.mimeType.startsWith('image/') || !frame.url)
    throw new Error('The preview needs a video clip and an image frame from this Room');
  const posted = await postRoomChoice(database, { roomId: input.roomId, agentId: input.agentId, mode: 'question',
    prompt: input.title.trim(), constraint: `Visibility: ${input.visibility}`,
    options: [{ label: 'Post', consequence: 'Post' }, { label: 'Cancel', consequence: 'Cancel' }] });
  await database.query(`UPDATE messages SET card=card || $2::jsonb WHERE id=$1`, [posted.messageId,
    JSON.stringify({ videoPreview: { videoObjectId: input.videoObjectId, frameUrl: frame.url,
      title: input.title.trim(), description: input.description, visibility: input.visibility } })]);
  return posted;
}

/** Restore only this failed reservation; never clear a later attempt's approval. */
export async function restoreStarterVideoPost(database: SqlDatabase, claim: { messageId: string; attemptId: string }) {
  await database.query(`UPDATE messages SET card=card - 'youtubeUploadUsed' - 'youtubeUploadAttempt'
    WHERE id=$1 AND card->>'youtubeUploadAttempt'=$2`, [claim.messageId, claim.attemptId]);
}

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
      { label: 'Invite a friend to play', consequence: 'Invite a friend to play' },
      { label: 'Give us a real task', consequence: 'Give us a real task' },
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
  await recordOnboardingEvent(database, userId, 'game_posted', { artifactId: stored.objectId, roomId });
}
