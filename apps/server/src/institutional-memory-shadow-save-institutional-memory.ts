import { INSTITUTIONAL_SEARCH_QUERY_MAX_CHARACTERS, institutionalMemoryRequestWords, INSTITUTIONAL_MEMORY_SEARCH_RESULT_MAX, INSTITUTIONAL_MEMORY_SEARCH_SCAN_MAX, INSTITUTIONAL_MEMORY_VECTOR_CANDIDATES_MAX, INSTITUTIONAL_MEMORY_VECTOR_MAX_DISTANCE, type DeleteInstitutionalMemoryInput, type InstitutionalMemoryWriteResult, type ReportInstitutionalMemoryUsedInput, type ReportInstitutionalMemoryUsedResult, type SaveInstitutionalMemoryInput, type SearchInstitutionalMemoryInput, type SearchInstitutionalMemoryResult, type UpdateInstitutionalMemoryInput } from '@beeline/api-contract/daemon';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { createDefaultEmbedFn, pgvectorLiteral, memoryEnvLimit, scheduleEmbedInstitutionalMemoryItem, runAfterCommit, withDeadline, type AfterCommit, type EmbedFn } from './institutional-memory-embeddings.js';
import { memoryWriteAuthority, memoryProposal, insertMemoryItem, lockMemoryTarget, memoryReadAuthority, searchRelevance } from './institutional-memory-shadow.js';



/** save_memory: one new sourced fact. Only a person's explicit ask makes it a standing order. */
export async function saveInstitutionalMemory(
  database: SqlDatabase,
  command: CommandRow,
  input: SaveInstitutionalMemoryInput,
  afterCommit?: AfterCommit,
): Promise<InstitutionalMemoryWriteResult> {
  const saved = await database.transaction(async (db) => {
    const authority = await memoryWriteAuthority(db, command, input);
    const proposal = memoryProposal(command, authority, input);
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      [
        'institutional-memory-item',
        authority.workspaceId,
        proposal.memoryKind,
        proposal.subjectIdentityId ?? '',
        proposal.canonicalKey,
        proposal.audience,
      ].join(':'),
    ]);
    const current = (
      await db.query<{ id: string; version: number }>(
        `SELECT id,version FROM institutional_memory_items
         WHERE workspace_id=$1 AND kind=$2 AND subject_identity_id IS NOT DISTINCT FROM $3
           AND canonical_key=$4 AND audience_kind=$5 AND state='active'`,
        [
          authority.workspaceId,
          proposal.memoryKind,
          proposal.subjectIdentityId ?? null,
          proposal.canonicalKey,
          proposal.audience,
        ],
      )
    ).rows[0];
    if (current) {
      throw new Error(
        `institutional memory already has item ${current.id} (version ${current.version}) under this key; skip this save if it says the same, or update_memory that item`,
      );
    }
    const itemId = await insertMemoryItem(db, command, authority.workspaceId, proposal, {
      version: 1,
      explicitSave: input.personAsked,
    });
    return { itemId, version: 1 };
  });
  // Event-driven, not polled: this save schedules its OWN row's embed once
  // the caller's transaction commits, on the pool, never blocking or failing
  // the save above. See institutional-memory-embeddings.ts.
  runAfterCommit(afterCommit, database, (pool) =>
    scheduleEmbedInstitutionalMemoryItem(pool, saved.itemId));
  return saved;
}


/** update_memory: replace one item at its current version; the old text is deleted now. */
export async function updateInstitutionalMemory(
  database: SqlDatabase,
  command: CommandRow,
  input: UpdateInstitutionalMemoryInput,
  afterCommit?: AfterCommit,
): Promise<InstitutionalMemoryWriteResult> {
  const updated = await database.transaction(async (db) => {
    const authority = await memoryWriteAuthority(db, command, input);
    const target = await lockMemoryTarget(db, authority, input.itemId, input.version);
    if (target.explicit_save && !input.personAsked) {
      throw new Error(
        "this item is a standing order; update it only on a person's explicit correction",
      );
    }
    const proposal = memoryProposal(command, authority, {
      memoryKind: target.kind,
      canonicalKey: target.canonical_key,
      body: input.body,
      keywords: input.keywords ?? target.keywords,
      sourceMessageIds: input.sourceMessageIds,
      confidence: target.confidence,
    });
    await db.query(
      `UPDATE institutional_memory_items
       SET state='stale',body='',deleted_at=now(),updated_at=now() WHERE id=$1`,
      [target.id],
    );
    const version = target.version + 1;
    const itemId = await insertMemoryItem(db, command, authority.workspaceId, proposal, {
      version,
      explicitSave: target.explicit_save,
      predecessorId: target.id,
    });
    return { itemId, version };
  });
  runAfterCommit(afterCommit, database, (pool) =>
    scheduleEmbedInstitutionalMemoryItem(pool, updated.itemId));
  return updated;
}


const MEMORY_DELETE_REASONS: ReadonlySet<string> = new Set(['wrong', 'duplicate', 'obsolete']);


/** delete_memory: remove one wrong, duplicate, or obsolete item at its current version. */
export async function deleteInstitutionalMemory(
  database: SqlDatabase,
  command: CommandRow,
  input: DeleteInstitutionalMemoryInput,
): Promise<InstitutionalMemoryWriteResult> {
  return database.transaction(async (db) => {
    if (!MEMORY_DELETE_REASONS.has(input.reason)) {
      throw new Error('institutional memory delete reason must be wrong, duplicate, or obsolete');
    }
    const authority = await memoryWriteAuthority(db, command, input);
    const target = await lockMemoryTarget(db, authority, input.itemId, input.version);
    if (target.explicit_save && !input.personAsked) {
      throw new Error("this item is a standing order; delete it only on a person's instruction");
    }
    await db.query(
      `UPDATE institutional_memory_items
       SET state='stale',body='',deleted_at=now(),updated_at=now() WHERE id=$1`,
      [target.id],
    );
    return { itemId: target.id, version: target.version };
  });
}


const MEMORY_USED_REPORT_MAX = 20;


/**
 * The end-of-turn used report: the only read that keeps a Workspace fact from
 * expiring. Snapshot numbers resolve against this agent's own serve row for
 * this turn, so a report can only name items this turn actually saw or could
 * search.
 */
export async function reportInstitutionalMemoryUsed(
  database: SqlDatabase,
  command: CommandRow,
  input: ReportInstitutionalMemoryUsedInput,
): Promise<ReportInstitutionalMemoryUsedResult> {
  const itemIds = input.itemIds ?? [];
  const snapshotItems = input.snapshotItems ?? [];
  if (
    !Array.isArray(itemIds) ||
    !Array.isArray(snapshotItems) ||
    itemIds.length + snapshotItems.length > MEMORY_USED_REPORT_MAX ||
    itemIds.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) ||
    snapshotItems.some((number) => !Number.isSafeInteger(number) || number < 1)
  ) {
    throw new Error('institutional memory used report is invalid');
  }
  return database.transaction(async (db) => {
    const authority = await memoryReadAuthority(db, command);
    const served = snapshotItems.length
      ? ((
          await db.query<{ item_ids: string[] }>(
            `SELECT item_ids FROM institutional_context_serves
             WHERE room_id=$1 AND request_id=$2 AND agent_id=$3 AND mode='live'
             ORDER BY created_at DESC,id DESC LIMIT 1`,
            [command.room_id, command.turn_request_id, command.agent_id],
          )
        ).rows[0]?.item_ids ?? [])
      : [];
    const ids = [
      ...itemIds,
      ...snapshotItems.map((number) => served[number - 1]).filter((id) => id !== undefined),
    ];
    if (!ids.length) return { refreshed: 0 };
    const refreshed = await db.query(
      `UPDATE institutional_memory_items SET last_used_at=now()
       WHERE id=ANY($1::uuid[]) AND workspace_id=$2 AND state='active' AND deleted_at IS NULL
         AND (kind='workspace_fact' OR (kind='human_profile_fact' AND subject_identity_id=$3))`,
      [ids, authority.workspace_id, authority.requester_identity_id],
    );
    return { refreshed: refreshed.rowCount };
  });
}


/** Search the full active item set; snapshot recency and byte limits do not apply. */
/** search_memory's own embedding call gets a turn-friendly bound — a tool
 *  call, not the passive snapshot, so it can afford more than the snapshot's
 *  slice, but must still never hang the turn on a stalled network call. */
export const SEARCH_MEMORY_EMBEDDING_TIMEOUT_MS = 3_000;


export async function searchInstitutionalMemory(
  database: SqlDatabase,
  command: CommandRow,
  input: SearchInstitutionalMemoryInput,
  embed: EmbedFn = createDefaultEmbedFn(),
): Promise<SearchInstitutionalMemoryResult> {
  const rawQuery = typeof input.query === 'string' ? input.query : '';
  const query = rawQuery.trim();
  if (
    !query ||
    rawQuery.includes('\0') ||
    [...rawQuery].length > INSTITUTIONAL_SEARCH_QUERY_MAX_CHARACTERS
  ) {
    throw new Error(`institutional memory query must be non-empty after trimming, contain no NUL, and be at most ${INSTITUTIONAL_SEARCH_QUERY_MAX_CHARACTERS} characters`);
  }
  const limit = input.limit === undefined ? 5 : input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > INSTITUTIONAL_MEMORY_SEARCH_RESULT_MAX) {
    throw new Error('institutional memory limit must be an integer from 1 to 10');
  }
  const queryEmbedding = await withDeadline(embed, SEARCH_MEMORY_EMBEDDING_TIMEOUT_MS)(
    query, 'query');
  return database.transaction(async (db) => {
    const authority = await memoryReadAuthority(db, command);
    // The same tokenizer and any-word-overlap semantics as the per-turn
    // snapshot (getInstitutionalContext): a natural-language query matches on
    // its individual words, not as one literal phrase. Word extraction is
    // Latin-only, so a non-Latin-script query (Korean, Japanese, ...)
    // extracts no words at all; the literal whole-query substring match
    // below is what the old strpos-only code relied on and remains a
    // standing OR alternative rather than only a fallback, so it keeps
    // finding non-Latin facts the tokenizer cannot see into.
    const words = institutionalMemoryRequestWords(query);
    const literalQuery = query.toLocaleLowerCase('en-US');
    type CandidateRow = {
      id: string;
      kind: 'workspace_fact' | 'human_profile_fact';
      canonical_key: string;
      body: string;
      keywords: string[];
      version: number;
      explicit_save: boolean;
      updated_at: Date;
      distance?: number;
    };
    const candidates = (
      await db.query<CandidateRow>(
        `SELECT item.id,item.kind,item.canonical_key,item.body,item.keywords,item.version,
                item.explicit_save,item.updated_at
       FROM institutional_memory_items item
       WHERE item.workspace_id=$1 AND item.state='active' AND item.deleted_at IS NULL
         AND (item.kind='workspace_fact' OR
              (item.kind='human_profile_fact' AND item.subject_identity_id=$2))
         AND (item.keywords && $3::text[] OR EXISTS (
               SELECT 1 FROM unnest($3::text[]) word
               WHERE strpos(lower(item.canonical_key),word)>0 OR strpos(lower(item.body),word)>0
             ) OR strpos(lower(item.canonical_key),$4)>0 OR strpos(lower(item.body),$4)>0)
         AND NOT EXISTS (
           SELECT 1 FROM institutional_memory_item_sources source
           JOIN messages message ON message.id=source.message_id
           WHERE source.item_id=item.id AND message.deleted_at IS NOT NULL
         )
       ORDER BY item.updated_at DESC,item.id
       LIMIT $5`,
        [
          authority.workspace_id,
          authority.requester_identity_id,
          [...words],
          literalQuery,
          INSTITUTIONAL_MEMORY_SEARCH_SCAN_MAX,
        ],
      )
    ).rows;
    // Hybrid: the query's meaning UNIONs with the word-overlap/literal match
    // above under the SAME scope filters. A query sharing no words with a
    // stored fact (e.g. "where does my wife live" against a fact keyworded
    // "daeun,tokyo,delivery,address") still finds it here.
    const vectorCandidates =
      queryEmbedding.outcome === 'served' && queryEmbedding.vector
        ? (
            await db.query<CandidateRow>(
              `SELECT item.id,item.kind,item.canonical_key,item.body,item.keywords,item.version,
                      item.explicit_save,item.updated_at,(item.embedding <=> $3::vector) distance
             FROM institutional_memory_items item
             WHERE item.workspace_id=$1 AND item.state='active' AND item.deleted_at IS NULL
               AND (item.kind='workspace_fact' OR
                    (item.kind='human_profile_fact' AND item.subject_identity_id=$2))
               AND item.embedding IS NOT NULL
               AND item.embedding <=> $3::vector <= $5
               AND NOT EXISTS (
                 SELECT 1 FROM institutional_memory_item_sources source
                 JOIN messages message ON message.id=source.message_id
                 WHERE source.item_id=item.id AND message.deleted_at IS NOT NULL
               )
             ORDER BY item.embedding <=> $3::vector
             LIMIT $4`,
              [
                authority.workspace_id,
                authority.requester_identity_id,
                pgvectorLiteral(queryEmbedding.vector),
                INSTITUTIONAL_MEMORY_VECTOR_CANDIDATES_MAX,
                memoryEnvLimit('INSTITUTIONAL_MEMORY_VECTOR_MAX_DISTANCE', INSTITUTIONAL_MEMORY_VECTOR_MAX_DISTANCE),
              ],
            )
          ).rows
        : [];
    const merged = new Map<string, CandidateRow>();
    for (const row of candidates) merged.set(row.id, row);
    for (const row of vectorCandidates) if (!merged.has(row.id)) merged.set(row.id, row);
    const ranked = [...merged.values()].sort((left, right) => {
      const relevance =
        searchRelevance(right, words, literalQuery) - searchRelevance(left, words, literalQuery);
      if (relevance) return relevance;
      // Neither side has keyword/literal overlap: a nearer vector match (a
      // lower cosine distance) wins. A side with no distance at all (found
      // only by the keyword path, or the vector pass never ran) sorts last
      // of the two.
      const leftDistance = left.distance ?? Number.POSITIVE_INFINITY;
      const rightDistance = right.distance ?? Number.POSITIVE_INFINITY;
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      const recency = right.updated_at.getTime() - left.updated_at.getTime();
      return recency || left.id.localeCompare(right.id);
    });
    const selected = ranked.slice(0, limit);
    // The serve row this turn's snapshot already wrote (if any) carries how
    // many times search_memory was called and how many came back empty, for
    // the daemon-side turn trace to read back after the turn settles.
    await db.query(
      `UPDATE institutional_context_serves
       SET search_memory_calls=search_memory_calls+1,
           search_memory_misses=search_memory_misses+CASE WHEN $4=0 THEN 1 ELSE 0 END
       WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [command.room_id, command.turn_request_id, command.agent_id, selected.length],
    );
    return {
      quotedContext: true,
      results: selected.map((row) => ({
        id: row.id,
        kind: row.kind,
        canonicalKey: row.canonical_key,
        body: row.body,
        version: row.version,
        standingOrder: row.explicit_save,
      })),
    };
  });
}


/**
 * This turn's search_memory call/miss counters, read back from the serve row
 * `getInstitutionalContext` (or `searchInstitutionalMemory` itself) already
 * wrote — for the daemon's own turn trace, after the turn has settled and no
 * active command remains to authorize through. Scoped to the caller's own
 * agent identity; a mismatched or turn-less caller reads zero, never throws.
 */
export async function getInstitutionalMemoryTurnStats(
  database: SqlDatabase,
  authenticatedAgentId: string,
  input: { roomId: string; agentId: string; requestId?: string },
): Promise<{ searchCalls: number; searchMisses: number }> {
  if (authenticatedAgentId !== input.agentId || !input.requestId) {
    return { searchCalls: 0, searchMisses: 0 };
  }
  const row = (
    await database.query<{ search_memory_calls: number; search_memory_misses: number }>(
      `SELECT search_memory_calls,search_memory_misses FROM institutional_context_serves
       WHERE room_id=$1 AND agent_id=$2 AND request_id=$3
       ORDER BY created_at DESC LIMIT 1`,
      [input.roomId, input.agentId, input.requestId],
    )
  ).rows[0];
  return {
    searchCalls: row?.search_memory_calls ?? 0,
    searchMisses: row?.search_memory_misses ?? 0,
  };
}


/** Blank every derivative before a deleted source can be served again. */
export async function tombstoneInstitutionalMemoryForMessage(
  database: SqlDatabase,
  messageId: string,
): Promise<void> {
  const affectedJobs = await database.query<{ id: string }>(
    `UPDATE institutional_memory_jobs
     SET proposal=NULL,proposal_hash=NULL,context=NULL,
         source_deleted_at=COALESCE(source_deleted_at,now()),
         status=CASE WHEN status='completed' THEN status ELSE 'dead' END,
         lease_owner_agent_id=NULL,lease_owner_machine_id=NULL,lease_token=NULL,
         lease_expires_at=NULL,
         updated_at=now()
     WHERE source_message_id=$1 OR proposal->'source'->'messageIds' ? $1
       OR context->'evidenceMessageIds' ? $1
       OR context->'priorSkill'->'sourceMessageIds' ? $1
       OR context->'candidates' @> jsonb_build_array(jsonb_build_object('sourceMessageId',$1))
     RETURNING id`,
    [messageId],
  );
  await database.query(
    `UPDATE institutional_memory_items item
     SET state='stale',body='',deleted_at=COALESCE(item.deleted_at,now()),updated_at=now()
     WHERE EXISTS (
       SELECT 1 FROM institutional_memory_item_sources source
       WHERE source.item_id=item.id AND source.message_id=$1
     )`,
    [messageId],
  );
  await database.query(
    `WITH affected_versions AS (
       UPDATE workspace_skill_versions
       SET markdown='',source_deleted_at=COALESCE(source_deleted_at,now())
       WHERE source_message_ids @> ARRAY[$1]::text[]
       RETURNING skill_id,version
     )
     UPDATE workspace_skills skill
     SET state='stale',updated_at=now()
     WHERE EXISTS (
       SELECT 1 FROM affected_versions affected
       WHERE affected.skill_id=skill.id AND affected.version=skill.current_version
     )`,
    [messageId],
  );
  if (affectedJobs.rowCount) {
    const jobIds = affectedJobs.rows.map((row) => row.id);
    await database.query(
      `DELETE FROM institutional_memory_correction_events WHERE job_id=ANY($1::uuid[])`,
      [jobIds],
    );
    await database.query(
      `DELETE FROM institutional_memory_fact_events WHERE job_id=ANY($1::uuid[])`,
      [jobIds],
    );
    await database.query(`DELETE FROM institutional_review_findings WHERE job_id=ANY($1::uuid[])`, [
      jobIds,
    ]);
  }
}
