import { createHash, randomUUID } from 'node:crypto';
import {
  INSTITUTIONAL_HISTORY_MATCH_SCAN_MAX,
  INSTITUTIONAL_HISTORY_MAX_AGE_DAYS,
  INSTITUTIONAL_HISTORY_QUERY_MAX_BYTES,
  INSTITUTIONAL_HISTORY_RESULT_MAX,
  INSTITUTIONAL_HISTORY_SNIPPET_MAX_BYTES,
  type SearchInstitutionalHistoryInput,
  type SearchInstitutionalHistoryResult,
} from '@beeline/api-contract/daemon';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { institutionalCornerRequesterAuthority } from './institutional-memory-shadow.js';
import { institutionalWorkspaceRolloutStage, rolloutAllowsLive } from './institutional-rollout.js';

type SearchRow = {
  message_id: string | null;
  room_id: string;
  room_name: string;
  author_id: string;
  text: string;
  created_at: Date;
  rank: number;
  matched_count: string;
  authorized_room_count: string;
};

/**
 * Params: $1 output Room, $2 durable requester, $3 Workspace, $4 answering agent.
 * A source Room qualifies only when the requester, the agent, and every current
 * human of the output Room can all read it.
 */
export const AUTHORIZED_ROOMS_CTE = `authorized_rooms AS (
         SELECT source.id
         FROM rooms source
         WHERE source.workspace_id=$3
           AND EXISTS (
             SELECT 1 FROM memberships member
             WHERE member.room_id=source.id AND member.identity_id=$4
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
       )`;

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

const CLIP_MARK = '…';

function clipUtf8(value: string, maximum: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximum) return value;
  const budget = maximum - Buffer.byteLength(CLIP_MARK, 'utf8');
  let end = Math.min(value.length, budget);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > budget) end -= 1;
  return `${value.slice(0, end).trimEnd()}${CLIP_MARK}`;
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
 * answering agent, and every current human member of the output Room. Indexed
 * exact/stemmed tokens and current Room names supply candidates inside the
 * recency window. Count distinct query words matched before the top-match cap;
 * fetch message bodies only for the requested results. Query bytes, history
 * age and the app pool's statement timeout bound the ranking work.
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
    const authority =
      (
        await db.query<{ workspace_id: string; requester_identity_id: string }>(
          `SELECT output.workspace_id,root.author_id requester_identity_id
         FROM rooms output
         JOIN messages root ON root.id=$2 AND root.deleted_at IS NULL
         JOIN rooms root_room ON root_room.id=root.room_id
           AND root_room.workspace_id=output.workspace_id
         JOIN identities requester ON requester.id=root.author_id AND requester.kind='human'
         WHERE output.id=$1`,
          [command.room_id, command.root_source_message_id],
        )
      ).rows[0] ?? (await institutionalCornerRequesterAuthority(db, command.room_id));
    if (!authority) throw new Error('institutional history requester authority is unavailable');
    if (!rolloutAllowsLive(await institutionalWorkspaceRolloutStage(db, authority.workspace_id))) {
      throw new Error('institutional history is not enabled for this Workspace');
    }

    const rows = await db.query<SearchRow>(
      `WITH ${AUTHORIZED_ROOMS_CTE}, query_terms AS (
         SELECT term,'stem' kind
         FROM unnest(tsvector_to_array(to_tsvector('english',$5))) term
         UNION ALL
         SELECT term,'exact' kind
         FROM unnest(tsvector_to_array(to_tsvector('simple',$5))) term
         WHERE numnode(plainto_tsquery('english',term))=0
       ), search_query AS MATERIALIZED (
         SELECT coalesce(string_agg(quote_literal(term),' | ')
                  FILTER (WHERE kind='exact'),'')::tsquery exact,
                coalesce(string_agg(quote_literal(term),' | ')
                  FILTER (WHERE kind='stem'),'')::tsquery stem,
                count(*) FILTER (WHERE kind='exact') exact_count,
                count(*) FILTER (WHERE kind='stem') stem_count,
                ts_rank('{1,1,1,1}',array_to_tsvector(ARRAY['unit']),'''unit'''::tsquery) unit_rank
         FROM query_terms
       ), room_documents AS MATERIALIZED (
         SELECT room.id,to_tsvector('simple',room.name) exact,
                strip(to_tsvector('english',room.name)) stem
         FROM authorized_rooms authorized JOIN rooms room ON room.id=authorized.id
       ), room_queries AS (
         SELECT room.id,
                coalesce(string_agg(quote_literal(term.term),' & ')
                  FILTER (WHERE term.kind='exact' AND NOT room.exact @@ quote_literal(term.term)::tsquery),'')::tsquery exact,
                coalesce(string_agg(quote_literal(term.term),' & ')
                  FILTER (WHERE term.kind='stem' AND NOT room.stem @@ quote_literal(term.term)::tsquery),'')::tsquery stem
         FROM room_documents room CROSS JOIN query_terms term GROUP BY room.id
       ), perfect_matches AS MATERIALIZED (
         -- A full page at maximum possible coverage dominates every partial
         -- match. This indexed route avoids scoring common words across history.
         SELECT message.id,message.created_at,
                (search_query.exact_count+search_query.stem_count)::double precision rank
         FROM room_queries room JOIN messages message ON message.room_id=room.id
         CROSS JOIN search_query
         WHERE (numnode(room.exact)=0 OR message.search_document @@ room.exact)
           AND (numnode(room.stem)=0 OR message.search_stem_document @@ room.stem)
           AND message.deleted_at IS NULL AND message.presentation='message'
           AND length(trim(message.text))>0
           AND message.created_at>=now()-$8*interval '1 day'
         ORDER BY message.created_at DESC,message.id DESC LIMIT $6
       ), perfect_page AS MATERIALIZED (
         SELECT count(*)=$6 complete FROM perfect_matches
       ), candidates AS MATERIALIZED (
         SELECT message.id,message.room_id,message.created_at,
                CASE WHEN search_query.exact_count>0 THEN message.search_document END search_document,
                message.search_stem_document
         FROM search_query
         JOIN messages message ON message.search_document @@ search_query.exact
                               OR message.search_stem_document @@ search_query.stem
         WHERE message.deleted_at IS NULL AND message.presentation='message'
           AND NOT (SELECT complete FROM perfect_page)
           AND message.room_id=ANY(ARRAY(SELECT id FROM authorized_rooms))
           AND length(trim(message.text))>0
           AND message.created_at>=now()-$8*interval '1 day'
         UNION ALL
         SELECT message.id,message.room_id,message.created_at,
                CASE WHEN search_query.exact_count>0 THEN message.search_document END search_document,
                message.search_stem_document
         FROM search_query JOIN room_documents room
           ON room.exact @@ search_query.exact OR room.stem @@ search_query.stem
         JOIN messages message ON message.room_id=room.id
         WHERE message.deleted_at IS NULL AND message.presentation='message'
           AND NOT (SELECT complete FROM perfect_page)
           AND length(trim(message.text))>0
           AND message.created_at>=now()-$8*interval '1 day'
           AND NOT (coalesce(message.search_document @@ search_query.exact,false)
                 OR coalesce(message.search_stem_document @@ search_query.stem,false))
       ), matches AS (
         SELECT id,created_at,rank FROM perfect_matches WHERE (SELECT complete FROM perfect_page)
         UNION ALL
         SELECT message.id,message.created_at,
                -- Stripped positions and uniform weights count distinct terms.
                -- Undo ts_rank's query-size averaging and single-term scaling.
                round((
                  CASE WHEN search_query.exact_count=0 THEN 0 ELSE
                    ts_rank('{1,1,1,1}',strip(coalesce(message.search_document,''::tsvector)||room.exact),
                            search_query.exact)*search_query.exact_count END
                  + ts_rank('{1,1,1,1}',coalesce(message.search_stem_document,''::tsvector)||room.stem,
                            search_query.stem)*search_query.stem_count
                )/search_query.unit_rank)::double precision rank
         FROM candidates message
         JOIN room_documents room ON room.id=message.room_id
         CROSS JOIN search_query
         ORDER BY rank DESC,created_at DESC,id DESC
         LIMIT $6
       ), ranked AS (
         SELECT message.id message_id,message.room_id,room.name room_name,
                message.author_id,message.text,message.created_at,
                matches.rank,
                count(*) OVER() matched_count
         FROM matches
         JOIN messages message ON message.id=matches.id
         JOIN rooms room ON room.id=message.room_id
         ORDER BY rank DESC,message.created_at DESC,message.id DESC
         LIMIT $7
       ), authorized_room_count AS (
         SELECT count(*)::text count FROM authorized_rooms
       )
       -- The authorization CTE is evaluated once and its count rides the same
       -- statement. The LEFT JOIN keeps that count when nothing matched, so an
       -- empty result still records how many Rooms were readable.
       SELECT authorized_room_count.count authorized_room_count,ranked.*
       FROM authorized_room_count LEFT JOIN ranked ON true
       ORDER BY ranked.rank DESC,ranked.created_at DESC,ranked.message_id DESC`,
      [
        command.room_id,
        authority.requester_identity_id,
        authority.workspace_id,
        command.agent_id,
        query,
        INSTITUTIONAL_HISTORY_MATCH_SCAN_MAX,
        limit,
        INSTITUTIONAL_HISTORY_MAX_AGE_DAYS,
      ],
    );
    const authorizedRoomCount = Number(rows.rows[0]?.authorized_room_count ?? 0);
    const matched = Number(rows.rows[0]?.matched_count ?? 0);
    const capped = matched >= INSTITUTIONAL_HISTORY_MATCH_SCAN_MAX;
    const result = rows.rows
      .filter((row): row is SearchRow & { message_id: string } => row.message_id !== null)
      .map((row) => ({
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
        query_hash,authorized_room_count,result_count,omitted_count,
        matches_capped,latency_ms)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        randomUUID(),
        authority.workspace_id,
        command.room_id,
        command.turn_request_id,
        authority.requester_identity_id,
        command.agent_id,
        createHash('sha256').update(query).digest('hex'),
        authorizedRoomCount,
        result.length,
        Math.max(0, matched - result.length),
        capped,
        Math.max(0, Math.round(performance.now() - started)),
      ],
    );
    return {
      results: result,
      omitted: Math.max(0, matched - result.length),
      capped,
      windowDays: INSTITUTIONAL_HISTORY_MAX_AGE_DAYS,
    };
  });
}
