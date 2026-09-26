import { createHash, randomUUID } from 'node:crypto';
import {
  INSTITUTIONAL_HISTORY_QUERY_MAX_BYTES,
  INSTITUTIONAL_HISTORY_RESULT_MAX,
  INSTITUTIONAL_HISTORY_SNIPPET_MAX_BYTES,
  type SearchInstitutionalHistoryInput,
  type SearchInstitutionalHistoryResult,
} from '@beeline/api-contract/daemon';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { institutionalWorkspaceRolloutStage, rolloutAllowsLive } from './institutional-rollout.js';

type SearchRow = {
  message_id: string;
  room_id: string;
  room_name: string;
  author_id: string;
  text: string;
  created_at: Date;
  rank: number;
  total_count: string;
  authorized_room_count: string;
};

function boundedQuery(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error('institutional history query is invalid');
  }
  const query = value.trim();
  if (!query || Buffer.byteLength(query, 'utf8') > INSTITUTIONAL_HISTORY_QUERY_MAX_BYTES) {
    throw new Error('institutional history query is invalid');
  }
  return query;
}

function boundedLimit(value: unknown): number {
  if (value === undefined) return 5;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10) {
    throw new Error('institutional history limit is invalid');
  }
  return Math.min(value as number, INSTITUTIONAL_HISTORY_RESULT_MAX);
}

function clipUtf8(value: string, maximum: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximum) return value;
  let end = Math.min(value.length, maximum);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maximum) end -= 1;
  return `${value.slice(0, Math.max(0, end - 1)).trimEnd()}…`;
}

function snippet(text: string, query: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const terms = query
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length >= 2);
  const lower = normalized.toLocaleLowerCase();
  const hit = terms.reduce((best, term) => {
    const index = lower.indexOf(term);
    return index >= 0 && (best < 0 || index < best) ? index : best;
  }, -1);
  const start = Math.max(0, hit < 0 ? 0 : hit - 100);
  const prefix = start > 0 ? '…' : '';
  return clipUtf8(`${prefix}${normalized.slice(start)}`, INSTITUTIONAL_HISTORY_SNIPPET_MAX_BYTES);
}

/**
 * Search only messages whose source Room is visible to the requester, the
 * answering agent, and every current human member of the output Room.
 */
export async function searchInstitutionalHistory(
  database: SqlDatabase,
  command: CommandRow,
  input: SearchInstitutionalHistoryInput,
): Promise<SearchInstitutionalHistoryResult> {
  const query = boundedQuery(input.query);
  const limit = boundedLimit(input.limit);
  const started = performance.now();
  return database.transaction(async (db) => {
    const authority = (
      await db.query<{ workspace_id: string; requester_identity_id: string }>(
        `SELECT output.workspace_id,root.author_id requester_identity_id
         FROM rooms output
         JOIN messages root ON root.id=$2 AND root.deleted_at IS NULL
         JOIN identities requester ON requester.id=root.author_id AND requester.kind='human'
         WHERE output.id=$1 AND root.room_id=output.id`,
        [command.room_id, command.root_source_message_id],
      )
    ).rows[0];
    if (!authority) throw new Error('institutional history requester authority is unavailable');
    if (!rolloutAllowsLive(await institutionalWorkspaceRolloutStage(db, authority.workspace_id))) {
      throw new Error('institutional history is not enabled for this Workspace');
    }

    const rows = await db.query<SearchRow>(
      `WITH search_query AS (
         SELECT websearch_to_tsquery('simple',$4) query
       ), authorized_rooms AS (
         SELECT source.id
         FROM rooms source
         WHERE source.workspace_id=$3
           AND EXISTS (
             SELECT 1 FROM memberships member
             WHERE member.room_id=source.id AND member.identity_id=$5
               AND member.removed_at IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM memberships member
             WHERE member.room_id=source.id AND member.identity_id=$2
               AND member.removed_at IS NULL
           )
           AND NOT EXISTS (
             SELECT 1
             FROM memberships output_member
             JOIN identities human ON human.id=output_member.identity_id AND human.kind='human'
             WHERE output_member.room_id=$1 AND output_member.removed_at IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM memberships source_member
                 WHERE source_member.room_id=source.id
                   AND source_member.identity_id=output_member.identity_id
                   AND source_member.removed_at IS NULL
               )
           )
       ), matches AS (
         SELECT message.id message_id,message.room_id,room.name room_name,
                message.author_id,message.text,message.created_at,
                ts_rank_cd(message.search_document,search_query.query)::double precision rank
         FROM search_query
         JOIN messages message ON message.search_document @@ search_query.query
         JOIN authorized_rooms authorized ON authorized.id=message.room_id
         JOIN rooms room ON room.id=message.room_id
         WHERE message.deleted_at IS NULL AND message.presentation='message'
           AND length(trim(message.text))>0
       ), counted AS (
         SELECT matches.*,count(*) OVER() total_count FROM matches
       )
       SELECT counted.*,
              (SELECT count(*)::text FROM authorized_rooms) authorized_room_count
       FROM counted
       ORDER BY rank DESC,created_at DESC,message_id DESC
       LIMIT $6`,
      [
        command.room_id,
        authority.requester_identity_id,
        authority.workspace_id,
        query,
        command.agent_id,
        limit,
      ],
    );
    const total = Number(rows.rows[0]?.total_count ?? 0);
    const authorizedRoomCount = Number(rows.rows[0]?.authorized_room_count ?? 0);
    const result = rows.rows.map((row) => ({
      messageId: row.message_id,
      roomId: row.room_id,
      roomName: row.room_name,
      authorId: row.author_id,
      createdAt: Math.floor(row.created_at.getTime() / 1_000),
      snippet: snippet(row.text, query),
      rank: row.rank,
    }));
    await db.query(
      `INSERT INTO institutional_history_searches
       (id,workspace_id,output_room_id,request_id,requester_identity_id,agent_id,
        query_hash,result_message_ids,authorized_room_count,result_count,omitted_count,latency_ms)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        randomUUID(),
        authority.workspace_id,
        command.room_id,
        command.turn_request_id,
        authority.requester_identity_id,
        command.agent_id,
        createHash('sha256').update(query).digest('hex'),
        result.map((item) => item.messageId),
        authorizedRoomCount,
        result.length,
        Math.max(0, total - result.length),
        Math.max(0, Math.round(performance.now() - started)),
      ],
    );
    return { results: result, omitted: Math.max(0, total - result.length) };
  });
}
