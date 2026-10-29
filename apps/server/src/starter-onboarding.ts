import { CommandRefusalError } from './command-refusal.js';
import type { ObjectService } from './object-service.js';
import { randomBytes, randomUUID } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { postRoomChoice, skipRoomChoice } from './room-choice.js';
import { recordOnboardingEvent } from './signin-funnel.js';

export const STARTER_OPTIONS = [
  { label: 'Write code in your repo' },
  { label: 'Post a video to your YouTube' },
  { label: 'Something else' },
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
      .map(option => ({ ...option, consequence: option.label })),
  });
  await database.query(`UPDATE messages SET created_at=clock_timestamp(),card=card || '{"starterOnboarding":"welcome"}'::jsonb WHERE id=$1`, [choice.messageId]);
  if (input.manualUserId) {
    await database.query(`UPDATE messages SET card=card || $2::jsonb WHERE id=$1`, [choice.messageId,
      JSON.stringify({ onboardingManual: true, onboardingUserId: input.manualUserId, onboardingRunId: input.runId ?? randomUUID() })]);
  }
  if (userId) await recordOnboardingEvent(database, userId, 'welcome_shown', { roomId: input.roomId });
  return choice;
}

/** Only the starter YouTube job adds this preview-tap requirement to the existing app boundary. */
export async function consumeStarterVideoPost(database: SqlDatabase, roomId: string, agentId: string, args: Record<string, unknown>): Promise<void> {
  const welcome = (await database.query<{ selected: string | null; created_at: Date }>(
    `SELECT m.card->>'selectedOptionId' selected,m.created_at FROM messages m
     WHERE m.room_id=$1 AND m.author_id=$2 AND m.card->>'starterOnboarding'='welcome'
     ORDER BY m.created_at DESC,m.id DESC LIMIT 1`, [roomId, agentId])).rows[0];
  if (welcome?.selected !== 'B') return;
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
  if (args.title !== approved.title || args.description !== approved.description ||
    args.privacyStatus !== approved.visibility || !file || typeof file !== 'object' ||
    Array.isArray(file) || Object.keys(file).length !== 1 ||
    (file as Record<string, unknown>).beelineObjectId !== approved.videoObjectId ||
    Object.keys(args).some(key => !['title', 'description', 'privacyStatus', 'videoFile', 'categoryId'].includes(key)) ||
    (args.categoryId !== undefined && args.categoryId !== '22'))
    throw new CommandRefusalError('Upload arguments must match the approved video preview exactly. Show a new preview for any changes.', 403);
  await database.query(`UPDATE messages SET card=card || '{"youtubeUploadUsed":true}'::jsonb WHERE id=$1`, [preview.id]);
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
