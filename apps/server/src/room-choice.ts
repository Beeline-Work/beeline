import { randomBytes, randomUUID } from 'node:crypto';
import type { ChoiceCardView, RoomViewIdentity } from '@beeline/api-contract/phone';
import {
  CHOICE_CARD_TYPE,
  CHOICE_POLL_ELECTORATE_MAX,
  CHOICE_POLL_ELECTORATE_MIN,
  CHOICE_WAKE_CARD_TYPES,
  choiceClosedFooter,
  decorateChoiceOptions,
  normalizeChoiceConstraint,
  normalizeChoiceOptions,
  normalizeChoicePrompt,
  normalizeChoiceTtl,
  tallyChoiceVotes,
  type ChoiceMode,
  type ChoiceOptionRecord,
  type ChoiceStatus,
  type ChoiceWakeCardType,
} from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { typedMentionHandles } from './message-mentions.js';
import { identitySubject, systemLine } from './system-line.js';

/**
 * Decision and wake rows kept only for a daemon and never shown (C101): a
 * grant decision, an accepted connector offer, and a choice/poll settlement
 * all settle their card in place, so the hidden line would read the same
 * answer twice.
 */
export function hiddenWakeCardSql(alias?: string): string {
  const column = alias ? `${alias}.card_type` : 'card_type';
  return (
    `${column} IS DISTINCT FROM 'grant-decision' ` +
    `AND ${column} IS DISTINCT FROM 'connector-offer-decision' ` +
    CHOICE_WAKE_CARD_TYPES.map((kind) => ` AND ${column} IS DISTINCT FROM '${kind}'`).join('')
  );
}

type IdentityRow = {
  id: string;
  kind: 'human' | 'agent';
  name: string;
  handle: string | null;
  avatar: string | null;
  face_id?: string | null;
};

function unix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function cardIdentity(row: IdentityRow): RoomViewIdentity {
  return {
    pubkey: row.id,
    kind: row.kind,
    name: row.name,
    ...(row.handle ? { handle: row.handle } : {}),
    ...(row.avatar ? { avatar: row.avatar } : {}),
    ...(row.face_id ? { face: row.face_id } : {}),
  };
}

export async function loadHumanElectorate(
  database: SqlDatabase,
  roomId: string,
): Promise<string[]> {
  const rows = await database.query<{ id: string }>(
    `SELECT identity.id
     FROM memberships member
     JOIN identities identity ON identity.id=member.identity_id
     WHERE member.room_id=$1 AND member.removed_at IS NULL
       AND identity.kind='human' AND COALESCE(identity.hidden_from_roster,false)=false
     ORDER BY identity.id`,
    [roomId],
  );
  return rows.rows.map((row) => row.id);
}

async function loadIdentity(database: SqlDatabase, id: string): Promise<IdentityRow> {
  const row = (
    await database.query<IdentityRow>(
      `SELECT id,kind,name,handle,avatar,face_id FROM identities WHERE id=$1`,
      [id],
    )
  ).rows[0];
  if (!row) throw new Error('identity not found');
  return row;
}

async function loadMentionIds(
  database: SqlDatabase,
  roomId: string,
  prompt: string,
  constraint: string | undefined,
): Promise<string[]> {
  const handles = [...typedMentionHandles(`${prompt} ${constraint ?? ''}`)].map((handle) =>
    handle.toLowerCase(),
  );
  if (!handles.length) return [];
  const rows = await database.query<{ id: string }>(
    `SELECT identity.id
     FROM memberships member
     JOIN identities identity ON identity.id=member.identity_id
     WHERE member.room_id=$1 AND member.removed_at IS NULL
       AND identity.kind='human' AND COALESCE(identity.hidden_from_roster,false)=false
       AND lower(btrim(identity.handle, '@')) = ANY($2::text[])`,
    [roomId, handles],
  );
  return rows.rows.map((row) => row.id);
}

async function loadResponses(
  database: SqlDatabase,
  choiceId: string,
): Promise<Array<{ identityId: string; optionId: string }>> {
  const rows = await database.query<{ voter_id: string; option_id: string }>(
    `SELECT voter_id,option_id FROM room_choice_votes WHERE choice_id=$1 ORDER BY created_at,voter_id`,
    [choiceId],
  );
  return rows.rows.map((row) => ({ identityId: row.voter_id, optionId: row.option_id }));
}

function votesFromResponses(
  responses: readonly { identityId: string; optionId: string }[],
): Record<string, number> {
  const votes: Record<string, number> = {};
  for (const response of responses) {
    votes[response.optionId] = (votes[response.optionId] ?? 0) + 1;
  }
  return votes;
}

export function buildChoiceCard(input: {
  choiceId: string;
  mode: ChoiceMode;
  status: ChoiceStatus;
  agent: RoomViewIdentity;
  requester?: RoomViewIdentity;
  prompt: string;
  constraint?: string;
  options: readonly ChoiceOptionRecord[];
  electorate: readonly string[];
  mentionIds?: readonly string[];
  closesAt?: Date | null;
  responses: readonly { identityId: string; optionId: string }[];
  answeredBy?: RoomViewIdentity;
  selectedOptionId?: string;
  footer?: string;
}): ChoiceCardView {
  const closed = input.status === 'closed';
  const tally = closed
    ? tallyChoiceVotes(input.options, votesFromResponses(input.responses))
    : undefined;
  const votedCount = input.responses.length;
  return {
    choiceId: input.choiceId,
    mode: input.mode,
    status: input.status,
    agent: input.agent,
    ...(input.requester ? { requester: input.requester } : {}),
    prompt: input.prompt,
    ...(input.constraint ? { constraint: input.constraint } : {}),
    options: decorateChoiceOptions(input.options, tally),
    electorate: [...input.electorate],
    ...(input.mentionIds?.length ? { mentionIds: [...input.mentionIds] } : {}),
    ...(input.closesAt ? { closesAt: unix(input.closesAt) } : {}),
    votedCount,
    electorateCount: input.electorate.length,
    responses: [...input.responses],
    ...(input.answeredBy ? { answeredBy: input.answeredBy } : {}),
    ...(input.selectedOptionId ? { selectedOptionId: input.selectedOptionId } : {}),
    ...(tally ? { outcome: tally.outcome } : {}),
    ...(input.footer
      ? { footer: input.footer }
      : tally
        ? { footer: choiceClosedFooter(tally, votedCount, input.electorate.length) }
        : {}),
  };
}

async function writeChoiceCard(
  database: SqlDatabase,
  messageId: string,
  card: ChoiceCardView,
): Promise<void> {
  await database.query(`UPDATE messages SET card=$2::jsonb WHERE id=$1`, [
    messageId,
    JSON.stringify(card),
  ]);
}

export async function postRoomChoice(
  database: SqlDatabase,
  input: {
    roomId: string;
    agentId: string;
    mode: ChoiceMode;
    prompt: unknown;
    constraint?: unknown;
    options: unknown;
    ttlSeconds?: unknown;
  },
): Promise<{
  choiceId: string;
  messageId: string;
  mode: ChoiceMode;
  electorateCount: number;
  closesAt?: number;
}> {
  const prompt = normalizeChoicePrompt(input.prompt);
  const constraint = normalizeChoiceConstraint(input.constraint);
  const options = normalizeChoiceOptions(input.options);
  const ttlSeconds = normalizeChoiceTtl(input.ttlSeconds, input.mode === 'poll');
  const room = (
    await database.query<{
      workspace_id: string;
      direct_participants: unknown;
    }>(`SELECT workspace_id,direct_participants FROM rooms WHERE id=$1`, [input.roomId])
  ).rows[0];
  if (!room) throw new Error('room not found');
  if (input.mode === 'poll' && room.direct_participants != null) {
    throw new Error('open_poll is invalid in a direct message; use ask_choice');
  }
  const electorate = await loadHumanElectorate(database, input.roomId);
  if (input.mode === 'poll') {
    if (electorate.length < CHOICE_POLL_ELECTORATE_MIN) {
      throw new Error(
        `a poll is invalid below ${CHOICE_POLL_ELECTORATE_MIN} human members; use ask_choice`,
      );
    }
    if (electorate.length > CHOICE_POLL_ELECTORATE_MAX) {
      throw new Error(
        `a poll is invalid above ${CHOICE_POLL_ELECTORATE_MAX} electors (${electorate.length} in this Room)`,
      );
    }
  }
  const open = (
    await database.query<{ id: string }>(
      `SELECT id FROM room_choices WHERE agent_id=$1 AND room_id=$2 AND status='open' LIMIT 1`,
      [input.agentId, input.roomId],
    )
  ).rows[0];
  if (open) throw new Error('choice conflict: this agent already has an open choice in this Room');
  const agent = await loadIdentity(database, input.agentId);
  const requesterRow = (
    await database.query<IdentityRow>(
      `SELECT identity.id,identity.kind,identity.name,identity.handle,identity.avatar,identity.face_id
       FROM agent_commands command
       JOIN messages message ON message.id=command.source_message_id
       JOIN identities identity ON identity.id=message.author_id
       WHERE command.room_id=$1 AND command.agent_id=$2 AND message.author_id<>$2
       ORDER BY command.created_at DESC,command.id DESC LIMIT 1`,
      [input.roomId, input.agentId],
    )
  ).rows[0];
  const requester = requesterRow ? cardIdentity(requesterRow) : undefined;
  const mentionIds = await loadMentionIds(database, input.roomId, prompt, constraint);
  const choiceId = randomUUID();
  const messageId = randomBytes(32).toString('hex');
  const closesAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null;
  const card = buildChoiceCard({
    choiceId,
    mode: input.mode,
    status: 'open',
    agent: cardIdentity(agent),
    requester,
    prompt,
    constraint,
    options,
    electorate,
    mentionIds,
    closesAt,
    responses: [],
  });
  await systemLine(database, {
    id: messageId,
    roomId: input.roomId,
    authorId: input.agentId,
    subject: identitySubject({ id: agent.id, kind: agent.kind, name: agent.name }),
    verb: 'asked',
    object: prompt,
    ...(constraint ? { consequence: constraint } : {}),
    presentation: 'card',
    cardType: CHOICE_CARD_TYPE,
    card: card as unknown as Record<string, unknown>,
  });
  await database.query(
    `INSERT INTO room_choices(
       id,room_id,workspace_id,agent_id,message_id,mode,prompt,constraint_text,options,
       electorate,closes_at,status
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::text[],$11,'open')`,
    [
      choiceId,
      input.roomId,
      room.workspace_id,
      input.agentId,
      messageId,
      input.mode,
      prompt,
      constraint ?? null,
      JSON.stringify(options),
      electorate,
      closesAt,
    ],
  );
  return {
    choiceId,
    messageId,
    mode: input.mode,
    electorateCount: electorate.length,
    ...(closesAt ? { closesAt: unix(closesAt) } : {}),
  };
}

type ChoiceRow = {
  id: string;
  room_id: string;
  agent_id: string;
  message_id: string;
  mode: ChoiceMode;
  prompt: string;
  constraint_text: string | null;
  options: ChoiceOptionRecord[];
  electorate: string[];
  closes_at: Date | null;
  status: ChoiceStatus;
};

async function loadChoice(database: SqlDatabase, choiceId: string): Promise<ChoiceRow | undefined> {
  return (
    await database.query<ChoiceRow>(
      `SELECT id,room_id,agent_id,message_id,mode,prompt,constraint_text,options,electorate,closes_at,status
       FROM room_choices WHERE id::text=$1`,
      [choiceId],
    )
  ).rows[0];
}

async function wakeChoice(
  database: SqlDatabase,
  input: {
    roomId: string;
    authorId: string;
    agentId: string;
    subject: IdentityRow;
    verb: string;
    object?: string;
    consequence?: string;
    kind: ChoiceWakeCardType;
    card: Record<string, unknown>;
  },
): Promise<void> {
  await systemLine(database, {
    roomId: input.roomId,
    authorId: input.authorId,
    subject: identitySubject({
      id: input.subject.id,
      kind: input.subject.kind,
      name: input.subject.name,
    }),
    verb: input.verb,
    ...(input.object ? { object: input.object } : {}),
    ...(input.consequence ? { consequence: input.consequence } : {}),
    kind: input.kind,
    wakes: [input.agentId],
    cardType: input.kind,
    card: input.card,
  });
}

export async function closeExpiredChoices(database: SqlDatabase, now = new Date()): Promise<number> {
  const due = await database.query<{ id: string }>(
    `SELECT id FROM room_choices WHERE status='open' AND closes_at IS NOT NULL AND closes_at<=$1`,
    [now],
  );
  let closed = 0;
  for (const row of due.rows) {
    try {
      await database.transaction((tx) => settleExpiredChoice(tx, row.id));
      closed += 1;
    } catch (error) {
      if (error instanceof Error && error.message.includes('conflict')) continue;
      throw error;
    }
  }
  return closed;
}

async function settleExpiredChoice(database: SqlDatabase, choiceId: string): Promise<void> {
  const choice = await loadChoice(database, choiceId);
  if (!choice || choice.status !== 'open') return;
  if (choice.mode === 'question') {
    await skipOpenChoice(database, choice, undefined, 'expired');
    return;
  }
  await closeOpenPoll(database, choice);
}

async function closeOpenPoll(database: SqlDatabase, choice: ChoiceRow): Promise<void> {
  const responses = await loadResponses(database, choice.id);
  const tally = tallyChoiceVotes(choice.options, votesFromResponses(responses));
  const agent = await loadIdentity(database, choice.agent_id);
  const footer = choiceClosedFooter(tally, responses.length, choice.electorate.length);
  const winner = tally.uniqueLeaderId
    ? choice.options.find((option) => option.optionId === tally.uniqueLeaderId)
    : undefined;
  const closed = await database.query(
    `UPDATE room_choices SET status='closed' WHERE id=$1 AND status='open'`,
    [choice.id],
  );
  if (!closed.rowCount) throw new Error('choice conflict: already decided');
  const card = buildChoiceCard({
    choiceId: choice.id,
    mode: 'poll',
    status: 'closed',
    agent: cardIdentity(agent),
    prompt: choice.prompt,
    constraint: choice.constraint_text ?? undefined,
    options: choice.options,
    electorate: choice.electorate,
    closesAt: choice.closes_at,
    responses,
    footer,
  });
  await writeChoiceCard(database, choice.message_id, card);
  const consequence =
    tally.outcome === 'winner' && winner
      ? `${responses.length} of ${choice.electorate.length} voted for ${winner.label}`
      : footer;
  await wakeChoice(database, {
    roomId: choice.room_id,
    authorId: choice.agent_id,
    agentId: choice.agent_id,
    subject: agent,
    verb: 'asked a poll',
    consequence,
    kind: 'poll-closed',
    card: { choiceId: choice.id, outcome: tally.outcome, votedCount: responses.length },
  });
}

async function skipOpenChoice(
  database: SqlDatabase,
  choice: ChoiceRow,
  viewer: IdentityRow | undefined,
  reason: 'skip' | 'expired',
): Promise<void> {
  const status: ChoiceStatus = 'skipped';
  const agent = await loadIdentity(database, choice.agent_id);
  const footer = reason === 'expired' ? 'expired · no answer' : `skipped · @${handleOf(viewer)}`;
  const updated = await database.query(
    `UPDATE room_choices SET status=$2 WHERE id=$1 AND status='open'`,
    [choice.id, status],
  );
  if (!updated.rowCount) throw new Error('choice conflict: already decided');
  const card = buildChoiceCard({
    choiceId: choice.id,
    mode: choice.mode,
    status,
    agent: cardIdentity(agent),
    prompt: choice.prompt,
    constraint: choice.constraint_text ?? undefined,
    options: choice.options,
    electorate: choice.electorate,
    closesAt: choice.closes_at,
    responses: [],
    footer,
  });
  await writeChoiceCard(database, choice.message_id, card);
  await wakeChoice(database, {
    roomId: choice.room_id,
    authorId: viewer?.id ?? choice.agent_id,
    agentId: choice.agent_id,
    subject: viewer ?? agent,
    verb: reason === 'expired' ? 'asked' : 'skipped',
    ...(reason === 'expired' ? { consequence: 'expired · no answer' } : {}),
    kind: 'choice-skipped',
    card: { choiceId: choice.id, status, reason },
  });
}

function handleOf(identity: IdentityRow | undefined): string {
  const handle = identity?.handle?.replace(/^@/, '');
  return handle || identity?.name || 'someone';
}

export async function answerRoomChoice(
  database: SqlDatabase,
  input: { choiceId: string; optionId: string; viewerId: string },
): Promise<{ choiceId: string; status: ChoiceStatus; roomId: string }> {
  const choice = await loadChoice(database, input.choiceId);
  if (!choice) throw new Error('choice not found');
  if (choice.status !== 'open') throw new Error('choice conflict: already decided');
  if (!choice.options.some((option) => option.optionId === input.optionId)) {
    throw new Error('choice option is invalid');
  }
  const viewer = await loadIdentity(database, input.viewerId);
  if (viewer.kind !== 'human') throw new Error('choice access denied');
  const member = (
    await database.query<{ id: string }>(
      `SELECT identity_id id FROM memberships
       WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
      [choice.room_id, input.viewerId],
    )
  ).rows[0];
  if (!member) throw new Error('room access denied');
  if (choice.mode === 'poll') {
    if (!choice.electorate.includes(input.viewerId)) {
      throw new Error('choice access denied');
    }
    await database.query(
      `INSERT INTO room_choice_votes(choice_id,voter_id,option_id)
       VALUES($1,$2,$3)
       ON CONFLICT(choice_id,voter_id) DO UPDATE
       SET option_id=EXCLUDED.option_id,updated_at=now()`,
      [choice.id, input.viewerId, input.optionId],
    );
    const responses = await loadResponses(database, choice.id);
    if (responses.length >= choice.electorate.length) {
      await closeOpenPoll(database, { ...choice, status: 'open' });
      return { choiceId: choice.id, status: 'closed', roomId: choice.room_id };
    }
    const agent = await loadIdentity(database, choice.agent_id);
    const card = buildChoiceCard({
      choiceId: choice.id,
      mode: 'poll',
      status: 'open',
      agent: cardIdentity(agent),
      prompt: choice.prompt,
      constraint: choice.constraint_text ?? undefined,
      options: choice.options,
      electorate: choice.electorate,
      closesAt: choice.closes_at,
      responses,
    });
    await writeChoiceCard(database, choice.message_id, card);
    return { choiceId: choice.id, status: 'open', roomId: choice.room_id };
  }
  const inserted = await database.query(
    `INSERT INTO room_choice_votes(choice_id,voter_id,option_id)
     VALUES($1,$2,$3) ON CONFLICT(choice_id,voter_id) DO NOTHING`,
    [choice.id, input.viewerId, input.optionId],
  );
  if (!inserted.rowCount) throw new Error('choice conflict: already decided');
  const closed = await database.query(
    `UPDATE room_choices SET status='answered' WHERE id=$1 AND status='open'`,
    [choice.id],
  );
  if (!closed.rowCount) throw new Error('choice conflict: already decided');
  const option = choice.options.find((entry) => entry.optionId === input.optionId)!;
  const agent = await loadIdentity(database, choice.agent_id);
  const responses = [{ identityId: input.viewerId, optionId: input.optionId }];
  const card = buildChoiceCard({
    choiceId: choice.id,
    mode: 'question',
    status: 'answered',
    agent: cardIdentity(agent),
    prompt: choice.prompt,
    constraint: choice.constraint_text ?? undefined,
    options: choice.options,
    electorate: choice.electorate,
    closesAt: choice.closes_at,
    responses,
    answeredBy: cardIdentity(viewer),
    selectedOptionId: input.optionId,
    footer: `picked ${option.letter} · @${handleOf(viewer)}`,
  });
  await writeChoiceCard(database, choice.message_id, card);
  await wakeChoice(database, {
    roomId: choice.room_id,
    authorId: input.viewerId,
    agentId: choice.agent_id,
    subject: viewer,
    verb: 'picked',
    object: option.letter,
    consequence: option.label,
    kind: 'choice-answered',
    card: { choiceId: choice.id, optionId: input.optionId, letter: option.letter },
  });
  return { choiceId: choice.id, status: 'answered', roomId: choice.room_id };
}

export async function skipRoomChoice(
  database: SqlDatabase,
  input: { choiceId: string; viewerId: string },
): Promise<{ choiceId: string; status: ChoiceStatus; roomId: string }> {
  const choice = await loadChoice(database, input.choiceId);
  if (!choice) throw new Error('choice not found');
  if (choice.mode !== 'question') throw new Error('skip is invalid on a poll');
  if (choice.status !== 'open') throw new Error('choice conflict: already decided');
  const viewer = await loadIdentity(database, input.viewerId);
  if (viewer.kind !== 'human') throw new Error('choice access denied');
  const member = (
    await database.query<{ id: string }>(
      `SELECT identity_id id FROM memberships
       WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
      [choice.room_id, input.viewerId],
    )
  ).rows[0];
  if (!member) throw new Error('room access denied');
  await skipOpenChoice(database, choice, viewer, 'skip');
  return { choiceId: choice.id, status: 'skipped', roomId: choice.room_id };
}
