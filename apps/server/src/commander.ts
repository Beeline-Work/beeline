import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { normalizeAgentAsk } from './tray-approval-ask.js';
import { createHash, randomBytes } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import {
  createAgentCommand,
  repairReviewerCornerMembership,
  nextAgentDepth,
  type CommandRow,
  type PrivateCommandPayload,
} from './agent-command.js';
import { resolveCurrentMemberMentions, tagsKnownIdentitySql } from './message-mentions.js';
import { cornerImplementerSql } from './corner-worker.js';
import { CommandRefusalError } from './command-refusal.js';
import { systemLine } from './system-line.js';
import { mediaIdFromUrl } from './media-ttl.js';
export { CommandRefusalError } from './command-refusal.js';

/** A report/lifecycle wake resumes the recipient's original incoming order. */
export async function commandOrder(db: SqlDatabase, command: CommandRow): Promise<CommandRow> {
  if (command.private_payload?.kind === 'order') return command;
  return (
    (
      await db.query<CommandRow>(
        `WITH RECURSIVE chain AS (
       SELECT command.*,0 hop FROM agent_commands command WHERE id=$1
       UNION ALL SELECT parent.*,child.hop+1 FROM agent_commands parent JOIN chain child
         ON parent.id=child.parent_command_id
     ) SELECT chain.* FROM chain LEFT JOIN messages source ON source.id=chain.source_message_id
     WHERE (chain.private_payload->>'kind'='order' AND (chain.agent_id=$2 OR chain.room_id=$3))
       OR (chain.private_payload IS NULL AND chain.agent_id=$2 AND source.id IS NOT NULL AND source.system_event IS NULL)
     ORDER BY hop LIMIT 1`,
        [command.id, command.agent_id, command.room_id],
      )
    ).rows[0] ?? command
  );
}

/** An address is a Room id (including corners and DMs). Reach stays membership based. */
export async function commandAddress(
  db: SqlDatabase,
  address: string,
  agentId: string,
  allowArchived = false,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(address))
    throw new CommandRefusalError('address requires current membership', 403);
  const row = (
    await db.query<{ id: string; worker: string | null; parent_id: string | null }>(
      `SELECT room.id,room.parent_id,${cornerImplementerSql('fact', 'room')} worker
     FROM rooms room LEFT JOIN corner_facts fact ON fact.corner_id=room.id
     JOIN memberships member ON member.room_id=COALESCE(room.parent_id,room.id)
       AND member.identity_id=$2 AND member.removed_at IS NULL
     WHERE room.id=$1 AND ($3::boolean OR room.archived_at IS NULL)
     LIMIT 1 FOR SHARE OF room,member`,
      [address, agentId, allowArchived],
    )
  ).rows[0];
  if (!row) throw new CommandRefusalError('address requires current membership', 403);
  return row;
}

/** Corner turns reject DMs and ancestors, with a direct-parent exception for orders. */
export async function assertCornerCommandTarget(
  db: SqlDatabase, sourceRoomId: string, targetRoomId: string, allowParentOrder = false,
) {
  const dm = await db.query(
    `SELECT 1 FROM rooms source WHERE source.id=$1 AND source.parent_id IS NOT NULL
       AND (EXISTS (SELECT 1 FROM rooms target WHERE target.id::text=lower($2) AND target.direct_participants IS NOT NULL)
         OR EXISTS (SELECT 1 FROM identities agent WHERE agent.kind='agent'
           AND (agent.id=$2 OR lower(agent.handle)=lower(ltrim($2,'@'))))) LIMIT 1`,
    [sourceRoomId, targetRoomId],
  );
  if (dm.rowCount)
    throw new CommandRefusalError(
      "Corners can't order DMs. Report to your commander instead.", 403,
    );
  const blocked = await db.query(
    `WITH RECURSIVE ancestors(id) AS (
       SELECT id FROM rooms WHERE id=$1 AND parent_id IS NOT NULL
       UNION
       SELECT parent.id FROM ancestors ancestor
       JOIN rooms room ON room.id=ancestor.id
       LEFT JOIN corner_facts fact ON fact.corner_id=room.id
       CROSS JOIN LATERAL (VALUES (room.parent_id),(fact.opened_from_corner_id)) parent(id)
       WHERE parent.id IS NOT NULL
     ) SELECT 1 FROM ancestors WHERE id<>$1 AND id::text=lower($2)
       AND NOT ($3::boolean AND id=(SELECT parent_id FROM rooms WHERE id=$1)) LIMIT 1`,
    [sourceRoomId, targetRoomId, allowParentOrder],
  );
  if (blocked.rowCount)
    throw new CommandRefusalError(
      "Corners can't order their parent Room. Report to your commander instead.", 403,
    );
}

/**
 * One order wakes exactly one agent: a corner's worker, the other agent of an
 * agent DM, or the `agent` named at a Room address. A Room order never fans out.
 */
export async function sendOrder(
  db: SqlDatabase,
  command: CommandRow,
  agentId: string,
  address: string,
  text: string,
  agent?: string,
) {
  if (!text.trim() || text.length > 16_000)
    throw new CommandRefusalError('order text must be 1 to 16000 characters', 400);
  const named = agent?.trim().replace(/^@/, '');
  if (agent !== undefined && !named) throw new CommandRefusalError('order agent must name one agent', 400);
  await assertCornerCommandTarget(db, command.room_id, address, true);
  const source = (await db.query<{ parent_id: string | null }>(
    `SELECT parent_id FROM rooms WHERE id=$1`, [command.room_id])).rows[0];
  const target = await commandAddress(db, address, agentId);
  if (source?.parent_id && !target.parent_id && target.id !== source.parent_id)
    throw new CommandRefusalError("Corners can only order their own parent Room", 403);
  let worker: string | undefined;
  if (target.parent_id) {
    if (!target.worker) throw new CommandRefusalError('address has no working agent', 409);
    worker = target.worker;
    if (named) {
      const member = (await db.query<{ id: string }>(
        `SELECT identity.id FROM effective_memberships member JOIN identities identity
           ON identity.id=member.identity_id AND identity.kind='agent'
         WHERE member.room_id=$1 AND member.removed_at IS NULL
           AND (identity.id=$2 OR lower(identity.handle)=$3)`, [address, named, named.toLowerCase()],
      )).rows[0];
      if (!member || !await repairReviewerCornerMembership(db, address, member.id))
        throw new CommandRefusalError('order agent must be an agent member of this corner or its parent Room', 403);
      worker = member.id;
    }
  } else {
    const direct = (
      await db.query<{ direct: boolean }>(`SELECT direct_participants IS NOT NULL direct FROM rooms WHERE id=$1`, [address])
    ).rows[0]?.direct;
    const agents = (
      await db.query<{ id: string; handle: string | null }>(
        `SELECT identity.id,lower(identity.handle) handle FROM effective_memberships member JOIN identities identity
         ON identity.id=member.identity_id AND identity.kind='agent'
       WHERE member.room_id=$1 AND member.removed_at IS NULL AND (identity.id<>$2 OR $3::boolean)`,
        [address, agentId, Boolean(named)],
      )
    ).rows;
    const matches = named
      ? agents.filter((row) => row.id === named || row.handle === named.toLowerCase())
      : direct ? agents : [];
    if (!named && !direct)
      throw new CommandRefusalError(
        'a Room order must name exactly one agent: pass agent with its handle or id, or use its DM or corner address',
        400,
      );
    if (named && !matches.length)
      throw new CommandRefusalError(`order agent ${named} is not an agent member of this address`, 400);
    if (!matches.length) throw new CommandRefusalError('address has no working agent', 409);
    if (matches.length > 1)
      throw new CommandRefusalError('order must name exactly one agent: pass agent with its handle or id', 400);
    worker = matches[0]!.id;
  }
  if (worker === agentId && target.id === command.room_id)
    throw new CommandRefusalError('an agent cannot order itself in its current place', 400);
  // Self-wakes across places and peer recruitment consume the existing depth
  // budget; handoffs to another implementer retain it.
  const peerOrder = worker === agentId || Boolean(source?.parent_id && (!target.parent_id || worker !== target.worker));
  if (peerOrder && nextAgentDepth(command.agent_depth) === undefined)
    throw new CommandRefusalError('agent order chain depth limit reached', 400);
  const queued = await createAgentCommand(db, {
    id: createHash('sha256')
      .update(`order:${command.id}:${address}:${worker}:${text}`)
      .digest('hex'),
    roomId: address,
    agentId: worker,
    sourceMessageId: null,
    privatePayload: { text, authorId: agentId, fromRoomId: command.room_id, kind: 'order' },
    reason: 'order',
    parent: command,
    retainDepth: !peerOrder,
  });
  if (!queued) throw new CommandRefusalError('order recipient is no longer a member', 403);
  if (target.parent_id)
    await recordAgentCommandCard(db, { id: queued.id, cornerId: address, kind: 'order', authorId: agentId, recipientId: worker, text });
  return { id: queued.id, createdAt: Math.floor(Date.now() / 1000),
    effect: 'order', address, agent: worker, visibility: 'private', reportsAssignment: false,
    accepted: true, executionConfirmed: false, receipt: 'Order queued privately; not confirmation of execution.' };
}

/**
 * One collapsed record card per order or report in a corner transcript. The
 * line names only sender, receiver and status; the full text stays in the
 * card for people to expand. It has no event kind, so it wakes nobody, and
 * its card type keeps it out of pushes and unread counts.
 */
async function recordAgentCommandCard(db: SqlDatabase, input: {
  id: string; cornerId: string; kind: 'order' | 'report'; authorId: string; recipientId: string;
  text: string; status?: string;
}) {
  const recipient = (await db.query<{ name: string; handle: string | null }>(
    'SELECT name,handle FROM identities WHERE id=$1', [input.recipientId])).rows[0];
  await systemLine(db, {
    id: createHash('sha256').update(`agent-command-card:${input.id}`).digest('hex'),
    roomId: input.cornerId,
    authorId: input.authorId,
    subject: { kind: 'agent', id: input.authorId, name: input.authorId },
    verb: input.kind === 'order' ? 'ordered' : 'reported to',
    object: { text: recipient?.name ?? input.recipientId, id: input.recipientId },
    ...(input.status ? { consequence: input.status } : {}),
    presentation: 'card',
    cardType: AGENT_COMMAND_CARD_TYPE,
    card: {
      kind: input.kind,
      recipient: { id: input.recipientId, name: recipient?.name ?? '', ...(recipient?.handle ? { handle: recipient.handle } : {}) },
      ...(input.status ? { status: input.status } : {}),
      text: input.text,
    },
  });
}

export const AGENT_COMMAND_CARD_TYPE = 'agent-command';

/** Derive the return route from the open command or the current order; no work ledger. */
export async function reportToCommander(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
  text: string,
  command?: CommandRow,
  reportId = randomBytes(32).toString('hex'),
  options: { automatic?: boolean; agentOnly?: boolean; ask?: string; attachments?: PrivateCommandPayload['attachments']; digestSource?: boolean } = {},
): Promise<{ id: string; createdAt: number; delivered?: boolean; receipt?: string; skipped?: boolean }> {
  if ((!options.automatic && !/^(done|blocked|needs-decision|failed):\s*\S/.test(text)) || !text.trim() || text.length > 16_000)
    throw new CommandRefusalError(
      'report must begin done:, blocked:, needs-decision: or failed:',
      400,
    );
  const ask = options.ask === undefined ? undefined : normalizeAgentAsk(options.ask);
  if (command?.coalesced_context !== null && command?.coalesced_context !== undefined && !options.digestSource) {
    const sources = (await db.query<CommandRow>(
      `SELECT * FROM agent_commands WHERE room_id=$1 AND agent_id=$2
       AND (id=$3 OR cancellation_reason='coalesced_into:'||$3) ORDER BY inbox_sequence`,
      [roomId, agentId, command.id])).rows;
    const routes = new Map<string, { source: CommandRow; urls: Set<string> }>();
    const carriedUrls = new Set(sources.flatMap(source => (source.private_payload?.attachments ?? []).map(attachment => attachment.url)));
    for (const source of sources) {
      const order = await commandOrder(db, source);
      // Standalone system facts have no orderer. Explicit orders and incoming
      // messages retain their own return route even when their source was folded.
      if (order.private_payload?.kind !== 'order' && !(order.source_message_id &&
        (await db.query('SELECT 1 FROM messages WHERE id=$1 AND system_event IS NULL', [order.source_message_id])).rowCount)) continue;
      const route = await commanderReportAddress(db, roomId, source);
      if (route.recipient && route.returnRoom) {
        const key = `${route.returnRoom}:${route.recipient}`;
        const target = routes.get(key) ?? { source, urls: new Set<string>() };
        target.source = source;
        for (const attachment of source.private_payload?.attachments ?? []) target.urls.add(attachment.url);
        routes.set(key, target);
      }
    }
    if (routes.size) {
      let first: Awaited<ReturnType<typeof reportToCommander>> | undefined;
      let delivered = true;
      const reportOptions = options;
      for (const [route, { source, urls }] of routes) {
        // Files carried by a batched source follow that source's return route.
        // Files uploaded in the current turn retain their normal delivery.
        const attachments = reportOptions.attachments?.filter(attachment =>
          !carriedUrls.has(attachment.url) || urls.has(attachment.url));
        const options = { ...reportOptions, attachments };
        const result = await reportToCommander(db, roomId, agentId, text, source,
          first ? createHash('sha256').update(`${reportId}:${route}`).digest('hex') : reportId,
          { ...options, digestSource: true });
        first ??= result;
        delivered &&= result.delivered !== false;
      }
      return { ...first!, delivered };
    }
  }
  const strict = Boolean(command) && !options.automatic;
  const { recipient, returnRoom, parent, origin, incoming } = await commanderReportAddress(db, roomId, command, options.automatic === true && options.agentOnly === true && agentId === SYSTEM_IDENTITY_ID);
  // Closed work has no outstanding request. Do not move its stale reports to
  // an ancestor Room merely because that Room still exists.
  if (origin && (await db.query(`SELECT 1 FROM rooms corner LEFT JOIN corner_facts fact ON fact.corner_id=corner.id
    WHERE corner.id=$1 AND (corner.archived_at IS NOT NULL OR fact.lifecycle->>'lifecycle' IN ('closed','landed'))`, [origin])).rowCount)
    return { id: reportId, createdAt: Math.floor(Date.now() / 1000), delivered: true, skipped: true };
  // A standing failure can be observed by many dispatch attempts. Its wake
  // identity belongs to the corner and failure, not the failed attempt.
  if (origin && text.startsWith('failed:')) {
    const recovery = (await db.query<{ id: string }>(`SELECT request_id id FROM agent_turns
      WHERE agent_id=$1 AND status='complete' ORDER BY created_at DESC,request_id DESC LIMIT 1`, [agentId])).rows[0]?.id;
    reportId = createHash('sha256').update(`corner-failure:${origin}:${agentId}:${recipient}:${returnRoom}:${text}:${recovery ?? ''}:${JSON.stringify(command?.review_context?.reviewerConfiguration ?? null)}`).digest('hex');
  }
  const order = command ? await commandOrder(db, command) : undefined;
  const assignment = order?.agent_id === agentId && (order.private_payload?.kind === 'order' ||
    (!order.private_payload && order.source_message_id && (await db.query(
      `SELECT 1 FROM messages source JOIN identities author ON author.id=source.author_id
       WHERE source.id=$1 AND author.kind='human' AND source.presentation='message' AND source.system_event IS NULL`, [order.source_message_id])).rowCount)) ? order : undefined;
  if (assignment) {
    // The obligation belongs to the order, across generations and later
    // continuations. Keep explicit new blockers possible, but a terminal
    // result or final prose cannot continually re-answer a discharged order.
    const saved = (await db.query<{ report_outcome: string | null; result_message_id: string | null; no_reply: boolean; previously_reported: boolean }>(
      `SELECT report_outcome,result_message_id,
       COALESCE(private_payload->>'reportedGenerationId'=generation_id,false) previously_reported,
       EXISTS(SELECT 1 FROM agent_turns turn
        WHERE turn.room_id=command.room_id AND turn.agent_id=command.agent_id
          AND turn.request_id=command.turn_request_id AND turn.completion_kind='no-reply') no_reply
       FROM agent_commands command WHERE id=$1 FOR UPDATE`, [assignment.id])).rows[0];
    if ((options.automatic && (saved?.report_outcome || saved?.result_message_id || saved?.no_reply || saved?.previously_reported)) ||
      (/^(done|failed):/.test(text) && ['done','failed'].includes(saved?.report_outcome ?? '')))
      return { id: reportId, createdAt: Math.floor(Date.now() / 1000), delivered: true, skipped: true };
  }
  if (!recipient || !returnRoom) {
    if (strict) throw new CommandRefusalError('this order has no commander return address', 409);
    console.error(`[commander] ${roomId}: cannot route report without recorded opening provenance`);
    return { id: reportId, createdAt: Math.floor(Date.now() / 1000), delivered: false };
  }
  const member = (
    await db.query<{ kind: string }>(
      `SELECT identity.kind FROM memberships member JOIN identities identity ON identity.id=member.identity_id
     JOIN rooms room ON member.room_id=COALESCE(room.parent_id,room.id) AND room.archived_at IS NULL
     WHERE room.id=$1 AND member.identity_id=$2 AND member.removed_at IS NULL
     FOR SHARE OF member,room`,
      [returnRoom, recipient],
    )
  ).rows[0];
  if (!member) {
    if (strict)
      throw new CommandRefusalError('commander is no longer a member of the return address', 403);
    console.error(`[commander] ${roomId}: return address no longer has its commander`);
    return { id: reportId, createdAt: Math.floor(Date.now() / 1000), delivered: false };
  }
  // Automatic attention must never become a transcript post to a person.
  if (options.agentOnly && member.kind !== 'agent')
    return { id: reportId, createdAt: Math.floor(Date.now() / 1000), delivered: false, skipped: true };
  // Deduplicate after selecting the recipient: another route's identical
  // object must not displace this recipient's carried file.
  const ids = (options.attachments ?? []).flatMap(attachment => mediaIdFromUrl(attachment.url) ?? []);
  const hashes = new Map((ids.length ? (await db.query<{ id: string; sha256: string }>(
    `SELECT id::text id,sha256 FROM objects WHERE id=ANY($1::uuid[])`, [ids],
  )).rows : []).map(object => [object.id, object.sha256]));
  const seen = new Set<string>();
  const attachments = options.attachments?.filter(attachment => {
    const hash = hashes.get(mediaIdFromUrl(attachment.url) ?? '');
    if (!hash) return true;
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
  if (member.kind === 'agent') {
    const queued = await createAgentCommand(db, {
      id: reportId,
      roomId: returnRoom,
      agentId: recipient,
      sourceMessageId: null,
      privatePayload: {
        text,
        authorId: agentId,
        fromRoomId: roomId,
        kind: 'report',
        ask,
        attachments,
        originCornerId: origin,
      },
      parent,
      reportSource: command,
      retainDepth: true,
      reason: 'report',
    });
    if (!queued) throw new CommandRefusalError('commander could not receive report', 409);
  } else {
    // The existing attention index follows this transport provenance; no public relay is created.
    if (origin && incoming?.private_payload)
      await db.query(
        `UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{originCornerId}',to_jsonb($2::text)) WHERE id=$1`,
        [incoming.id, origin],
      );
    // Only a human address is a chat message; private coordination never enters messages.
    await db.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,attachments,request_id,card)
       VALUES($1,$2,$3,$4,'message',$5::jsonb,$6,$7::jsonb) ON CONFLICT(id) DO NOTHING`,
      [
        reportId,
        returnRoom,
        agentId,
        text,
        JSON.stringify(attachments ?? []),
        incoming?.id ?? null,
        ask || /^(needs-decision|blocked):/.test(text)
          ? JSON.stringify({ ...(ask ? { ask } : {}), ...(/^(needs-decision|blocked):/.test(text) ? { reportToId: recipient } : {}) })
          : null,
      ],
    );
  }
  // The corner keeps a collapsed record of what its agent reported, so a
  // person reading a relay can open the full text where it was written.
  let reportMessageId = member.kind === 'human' ? reportId : null;
  if (!options.automatic && (returnRoom !== roomId || member.kind === 'agent') &&
    (await db.query('SELECT 1 FROM rooms WHERE id=$1 AND parent_id IS NOT NULL', [roomId])).rowCount) {
    await recordAgentCommandCard(db, { id: reportId, cornerId: roomId, kind: 'report', authorId: agentId,
      recipientId: recipient, text, status: /^(done|blocked|needs-decision|failed):/.exec(text)?.[1] });
    if (member.kind === 'agent' && returnRoom === roomId)
      reportMessageId = createHash('sha256').update(`agent-command-card:${reportId}`).digest('hex');
  }
  if (!options.automatic && origin && (await db.query(
    'SELECT 1 FROM corner_facts WHERE corner_id=$1 AND COALESCE(worker_agent_id,owner_agent_id)=$2', [origin,agentId])).rowCount) {
    if (/^(needs-decision|blocked):/.test(text)) {
      await db.query(`UPDATE messages SET card=jsonb_set(card,'{waitingAnswered}','true')
        WHERE presentation='message' AND system_event IS NULL
          AND id IN (SELECT message_id FROM corner_report_blockers WHERE corner_id=$1) AND id<>$2`, [origin,reportId]);
      await db.query('DELETE FROM corner_report_blockers WHERE corner_id=$1', [origin]);
      await db.query(
      `INSERT INTO corner_report_blockers(corner_id,person_id,report_id,return_room_id,commander_id,message_id)
       SELECT $1,person.id,$2,$3,$6,$7 FROM identities person
       LEFT JOIN effective_memberships member ON member.identity_id=person.id AND member.room_id=$1 AND member.removed_at IS NULL
       CROSS JOIN (SELECT $4::text text,'message'::text presentation,$1::uuid room_id,$5::text author_id) item
       WHERE (person.id=$6 OR (member.identity_id IS NOT NULL AND person.kind='human' AND ${tagsKnownIdentitySql('item', 'person.id', 'person.handle', 'person.kind')}))
       AND EXISTS(SELECT 1 FROM corner_facts fact WHERE fact.corner_id=$1
         AND COALESCE(fact.worker_agent_id,fact.owner_agent_id)=$5)
       ON CONFLICT(corner_id,person_id) DO UPDATE SET report_id=EXCLUDED.report_id,
         return_room_id=EXCLUDED.return_room_id,created_at=EXCLUDED.created_at,
         commander_id=EXCLUDED.commander_id,message_id=EXCLUDED.message_id`,
      [origin, member.kind === 'agent' ? reportId : null, returnRoom, text, agentId, recipient, reportMessageId]);
    }
  }
  if (assignment) await db.query(`UPDATE agent_commands SET report_outcome=
    CASE WHEN report_outcome IN ('done','failed') THEN report_outcome ELSE $2 END WHERE id=$1`,
    [assignment.id, /^(done|blocked|failed|needs-decision):/.exec(text)?.[1] ?? 'reported']);
  return { id: reportId, createdAt: Math.floor(Date.now() / 1000), delivered: true,
    receipt: member.kind === 'agent' ? 'Report queued privately; not confirmation of execution.' : 'Report stored and visible.' };
}

/**
 * Chain of command: in a corner, an agent may tag a person only when that
 * person is its direct commander for this turn. Anyone higher hears through
 * the commander, at the place they gave the order.
 */
export async function refuseTagPastCommander(
  db: SqlDatabase, roomId: string, agentId: string, text: string, command?: CommandRow,
): Promise<void> {
  if (!(await db.query('SELECT 1 FROM rooms WHERE id=$1 AND parent_id IS NOT NULL', [roomId])).rowCount) return;
  const people = (await resolveCurrentMemberMentions(db, roomId, text, agentId)).filter(m => m.kind === 'human');
  if (!people.length) return;
  const { recipient, returnRoom } = await commanderReportAddress(db, roomId, command);
  const skipped = people.filter(person => person.id !== recipient);
  if (!skipped.length) return;
  const commander = recipient && returnRoom ? (await db.query<{ handle: string | null; name: string; place: string }>(
    `SELECT identity.handle,identity.name,room.name place FROM identities identity, rooms room
     WHERE identity.id=$1 AND room.id=$2`, [recipient, returnRoom])).rows[0] : undefined;
  const who = commander ? `@${(commander.handle ?? commander.name).replace(/^@/, '')} in ${commander.place}` : 'whoever assigned you';
  throw new CommandRefusalError(
    `post refused: ${skipped.map(person => `@${person.handle}`).join(', ')} is not your direct commander. ` +
    `Your commander is ${who}. Use report(needs-decision:) and they decide whether to ask further up.`, 403);
}

/** The recorded return route shared by lifecycle reports and commander approvals. */
export async function commanderReportAddress(db: SqlDatabase, roomId: string, command?: CommandRow, openingRoute = false) {
  // Idle attention belongs to the opening commander, regardless of later peer orders.
  if (openingRoute) command = undefined;
  if (!command && !openingRoute)
    command = (
      await db.query<CommandRow>(
        `SELECT ordered.* FROM agent_commands ordered JOIN rooms corner ON corner.id=ordered.room_id
     JOIN corner_facts fact ON fact.corner_id=corner.id
     WHERE corner.id=$1 AND ordered.agent_id=${cornerImplementerSql('fact', 'corner')}
       AND ordered.private_payload->>'kind'='order'
     ORDER BY ordered.created_at DESC,ordered.id DESC LIMIT 1`,
        [roomId],
      )
    ).rows[0];
  const incoming = command;
  const places = [
    incoming?.private_payload?.originCornerId,
    ...(incoming?.private_payload?.kind === 'report'
      ? [incoming.private_payload.fromRoomId, roomId]
      : [roomId, incoming?.private_payload?.fromRoomId]),
  ].filter((place): place is string => typeof place === 'string');
  const origin = (
    await db.query<{ id: string }>(
      `SELECT id FROM rooms WHERE id=ANY($1::uuid[]) AND parent_id IS NOT NULL
     ORDER BY array_position($1::uuid[],id) LIMIT 1`,
      [places],
    )
  ).rows[0]?.id;
  if (command) command = await commandOrder(db, command);
  let recipient: string | undefined;
  let returnRoom: string | undefined;
  let parent = command;
  if (command?.private_payload?.kind === 'order') {
    recipient = command.private_payload.authorId;
    returnRoom = command.private_payload.fromRoomId;
    if (command.parent_command_id)
      parent = (
        await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`, [
          command.parent_command_id,
        ])
      ).rows[0];
  } else if (command?.source_message_id) {
    const source = (
      await db.query<{ author_id: string; room_id: string }>(
        // System wakes carry facts, not an order from the system identity.
        // Without a message source, retain the corner's recorded opening route.
        `SELECT author_id,room_id FROM messages WHERE id=$1 AND system_event IS NULL`,
        [command.source_message_id],
      )
    ).rows[0];
    recipient = source?.author_id;
    returnRoom = source?.room_id;
  }
  if (!recipient || !returnRoom) {
    const corner = (
      await db.query<{ created_by: string; return_room: string; parent_command: string | null }>(
        `SELECT room.created_by,COALESCE(parent.room_id,source.room_id,room.parent_id) return_room,
         parent.id parent_command FROM rooms room
       LEFT JOIN LATERAL (SELECT * FROM agent_commands opened
         WHERE opened.room_id=room.id AND opened.reason='corner_objective'
         ORDER BY opened.created_at,opened.id LIMIT 1) opened ON true
       LEFT JOIN agent_commands parent ON parent.id=opened.parent_command_id
       LEFT JOIN messages source ON source.id=opened.root_source_message_id
       WHERE room.id=$1 AND room.parent_id IS NOT NULL`,
        [roomId],
      )
    ).rows[0];
    recipient = corner?.created_by;
    returnRoom = corner?.return_room;
    if (corner?.parent_command)
      parent = (
        await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`, [
          corner.parent_command,
        ])
      ).rows[0];
  }
  // Follow only the recorded opening ancestry. Keep the original commander;
  // moving a report never grants a different recipient access to its payload.
  if (returnRoom) {
    const live = (await db.query<{ id: string }>(
      `WITH RECURSIVE ancestry AS (
         SELECT room.id,room.archived_at,0 hop,ARRAY[room.id] path FROM rooms room WHERE room.id=$1
         UNION ALL
         SELECT ancestor.id,ancestor.archived_at,child.hop+1,child.path||ancestor.id
         FROM ancestry child JOIN rooms room ON room.id=child.id
         LEFT JOIN corner_facts fact ON fact.corner_id=room.id
         JOIN rooms ancestor ON ancestor.id=COALESCE(fact.opened_from_corner_id,room.parent_id)
         WHERE NOT ancestor.id=ANY(child.path)
       ) SELECT ancestry.id FROM ancestry LEFT JOIN corner_facts fact ON fact.corner_id=ancestry.id
       WHERE ancestry.archived_at IS NULL
         AND COALESCE(fact.lifecycle->>'lifecycle','') NOT IN ('closed','landed')
       ORDER BY hop LIMIT 1`, [returnRoom],
    )).rows[0];
    returnRoom = live?.id;
  }
  return { recipient, returnRoom, parent, origin, incoming };
}

/** Only durable waits belonging to this execution can discharge an empty order. */
export async function hasOrderContinuation(database: SqlDatabase, command: CommandRow): Promise<boolean> {
  const result = await database.query(
    `SELECT 1 FROM agent_commands current WHERE current.id=$1 AND (
       EXISTS(SELECT 1 FROM agent_commands child JOIN rooms destination ON destination.id=child.room_id
         WHERE child.parent_command_id=current.id AND child.state IN ('pending','claimed')
           AND destination.archived_at IS NULL AND child.created_at>=current.claimed_at
           AND (child.private_payload->>'kind'='order' OR child.action='resume'
             OR (child.reason='report' AND child.agent_id=current.agent_id)))
       OR EXISTS(SELECT 1 FROM agent_grants grant_row WHERE grant_row.command_id=current.id
         AND grant_row.status='pending' AND grant_row.superseded_at IS NULL AND grant_row.created_at>=current.claimed_at
         AND (grant_row.expires_at IS NULL OR grant_row.expires_at>now()))
       OR EXISTS(SELECT 1 FROM connector_offers offer WHERE offer.command_id=current.id
         AND offer.status IN ('pending','connecting') AND offer.created_at>=current.claimed_at)
       OR EXISTS(SELECT 1 FROM messages approval WHERE approval.card_type='squire-approval'
         AND approval.card->>'commandId'=current.id AND approval.card->>'generationId'=current.generation_id
         AND NOT EXISTS(SELECT 1 FROM messages decision WHERE decision.card_type='squire-approval-decision'
           AND decision.card->>'approvalId'=approval.card->>'approvalId'
           AND decision.card->>'agentId'=current.agent_id)
         AND (approval.card->>'expiresAt')::bigint>
           extract(epoch FROM now())*1000)
     )`, [command.id],
  );
  return Boolean(result.rowCount);
}
