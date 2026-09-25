import { createHash, randomUUID } from 'node:crypto';
import {
  INSTITUTIONAL_MEMORY_EXTRACTOR_VERSION_MAX_LENGTH,
  INSTITUTIONAL_MEMORY_JOB_ERROR_MAX_LENGTH,
  INSTITUTIONAL_MEMORY_MODEL_MAX_LENGTH,
  parseInstitutionalMemoryProposal,
  type CompleteInstitutionalMemoryJobInput,
  type FailInstitutionalMemoryJobInput,
  type InstitutionalMemoryJobUsage,
  type InstitutionalMemoryShadowJob,
} from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';

export const INSTITUTIONAL_MEMORY_SHADOW_FLAG = 'BEELINE_INSTITUTIONAL_MEMORY_SHADOW_ENABLED';
export const DEFAULT_INSTITUTIONAL_MEMORY_DAILY_JOB_LIMIT = 50;
export const DEFAULT_INSTITUTIONAL_MEMORY_LEASE_MS = 5 * 60_000;
export const INSTITUTIONAL_MEMORY_CONTEXT_MESSAGE_LIMIT = 16;
export const INSTITUTIONAL_MEMORY_CONTEXT_BYTE_LIMIT = 24_000;

export interface InstitutionalMemoryShadowConfig {
  readonly enabled: boolean;
  readonly dailyJobLimit?: number;
  readonly leaseMs?: number;
}

export function institutionalMemoryShadowConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): InstitutionalMemoryShadowConfig {
  const parsedLimit = Number(
    env.BEELINE_INSTITUTIONAL_MEMORY_DAILY_JOB_LIMIT ??
      DEFAULT_INSTITUTIONAL_MEMORY_DAILY_JOB_LIMIT,
  );
  return {
    enabled: env[INSTITUTIONAL_MEMORY_SHADOW_FLAG] === 'true',
    dailyJobLimit:
      Number.isSafeInteger(parsedLimit) && parsedLimit > 0 && parsedLimit <= 1_000
        ? parsedLimit
        : DEFAULT_INSTITUTIONAL_MEMORY_DAILY_JOB_LIMIT,
  };
}

type SourceRow = {
  workspace_id: string;
  room_id: string;
  message_id: string;
  requester_identity_id: string;
  direct_participants: unknown;
};

/** Queue one review only after the turn completion commits with it. */
export async function enqueueInstitutionalMemoryTurnReview(
  database: SqlDatabase,
  input: {
    roomId: string;
    sourceMessageId: string;
    requestId: string;
    config: InstitutionalMemoryShadowConfig;
  },
): Promise<string | undefined> {
  if (!input.config.enabled) return undefined;
  const source = (
    await database.query<SourceRow>(
      `SELECT r.workspace_id,r.id room_id,m.id message_id,m.author_id requester_identity_id,
              r.direct_participants
       FROM messages m
       JOIN rooms r ON r.id=m.room_id
       JOIN identities requester ON requester.id=m.author_id AND requester.kind='human'
       WHERE m.id=$1 AND m.room_id=$2 AND m.deleted_at IS NULL
         AND m.presentation='message' AND length(trim(m.text))>0`,
      [input.sourceMessageId, input.roomId],
    )
  ).rows[0];
  if (!source) return undefined;

  // The daily cap is a cost boundary, so serialize its count with enqueue for
  // this Workspace rather than accepting an unbounded concurrent overshoot.
  await database.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `institutional-memory:${source.workspace_id}`,
  ]);
  const count = (
    await database.query<{ count: string }>(
      `SELECT count(*)::text count FROM institutional_memory_jobs
       WHERE workspace_id=$1 AND created_at>=date_trunc('day',now())`,
      [source.workspace_id],
    )
  ).rows[0]?.count;
  if (
    Number(count ?? 0) >=
    (input.config.dailyJobLimit ?? DEFAULT_INSTITUTIONAL_MEMORY_DAILY_JOB_LIMIT)
  ) {
    return undefined;
  }

  const id = randomUUID();
  const key = `turn_review:${source.room_id}:${input.requestId}:${source.message_id}`;
  const inserted = await database.query<{ id: string }>(
    `INSERT INTO institutional_memory_jobs
       (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
        source_request_id,requester_identity_id,source_audience_kind,idempotency_key)
     VALUES($1,$2,'turn_review','shadow',$3,$4,$5,$6,$7,$8)
     ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
    [
      id,
      source.workspace_id,
      source.room_id,
      source.message_id,
      input.requestId,
      source.requester_identity_id,
      Array.isArray(source.direct_participants) ? 'human_private' : 'workspace_candidate',
      key,
    ],
  );
  return inserted.rows[0]?.id;
}

type ClaimedRow = {
  id: string;
  lease_token: string;
  lease_expires_at: Date;
  workspace_id: string;
  source_room_id: string;
  source_message_id: string;
  requester_identity_id: string;
  direct_participants: unknown;
  created_at: Date;
};

function clipUtf8(value: string, maximum: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximum) return value;
  let end = Math.min(value.length, maximum);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maximum) end -= 1;
  return value.slice(0, end);
}

function boundedMessages(
  rows: readonly { id: string; author_id: string; created_at: Date; text: string }[],
): InstitutionalMemoryShadowJob['messages'] {
  const selected: Array<(typeof rows)[number]> = [];
  let remaining = INSTITUTIONAL_MEMORY_CONTEXT_BYTE_LIMIT;
  for (const row of [...rows].reverse()) {
    if (remaining <= 0) break;
    const text = clipUtf8(row.text, remaining);
    if (!text) continue;
    selected.push({ ...row, text });
    remaining -= Buffer.byteLength(text, 'utf8');
  }
  return selected.reverse().map((row) => ({
    id: row.id,
    authorId: row.author_id,
    createdAt: Math.floor(row.created_at.getTime() / 1_000),
    text: row.text,
  }));
}

/** Claim at most one job per physical host with a short database transaction. */
export async function claimInstitutionalMemoryJob(
  database: SqlDatabase,
  authenticatedAgentId: string,
  config: InstitutionalMemoryShadowConfig,
): Promise<InstitutionalMemoryShadowJob | undefined> {
  if (!config.enabled) return undefined;
  return database.transaction(async (db) => {
    const machine = (
      await db.query<{ machine_id: string | null }>(
        `SELECT machine_id FROM agents WHERE agent_id=$1`,
        [authenticatedAgentId],
      )
    ).rows[0];
    if (!machine) throw new Error('agent not found');
    // A machine report is the proof that sibling agents share a physical
    // host. Until it arrives, do not use an agent-shaped fallback that could
    // run more than one background model session on the same host.
    if (!machine.machine_id) return undefined;
    const hostKey = machine.machine_id;
    // The busy-check and claim are one critical section per physical host.
    // Job row locks alone would let sibling agents claim different rows.
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `institutional-memory-host:${hostKey}`,
    ]);
    const busy = await db.query(
      `SELECT 1 FROM institutional_memory_jobs
       WHERE status='claimed' AND lease_expires_at>now()
         AND lease_owner_machine_id=$1 LIMIT 1`,
      [hostKey],
    );
    if (busy.rowCount) return undefined;

    const leaseToken = randomUUID();
    const leaseMs = Math.max(
      30_000,
      Math.min(config.leaseMs ?? DEFAULT_INSTITUTIONAL_MEMORY_LEASE_MS, 30 * 60_000),
    );
    const claimed = (
      await db.query<ClaimedRow>(
        `WITH candidate AS (
           SELECT job.id
           FROM institutional_memory_jobs job
           JOIN rooms room ON room.id=job.source_room_id
           JOIN messages source ON source.id=job.source_message_id AND source.deleted_at IS NULL
           JOIN memberships worker ON worker.room_id=job.source_room_id
             AND worker.identity_id=$1 AND worker.removed_at IS NULL
           JOIN memberships requester ON requester.room_id=job.source_room_id
             AND requester.identity_id=job.requester_identity_id AND requester.removed_at IS NULL
           WHERE job.mode='shadow'
             AND (
               (job.status IN ('pending','retry') AND job.next_attempt_at<=now()) OR
               (job.status='claimed' AND job.lease_expires_at<=now())
             )
             AND job.attempts<job.max_attempts
           ORDER BY job.created_at,job.id
           FOR UPDATE OF job SKIP LOCKED
           LIMIT 1
         )
         UPDATE institutional_memory_jobs job
         SET status='claimed',lease_owner_agent_id=$1,lease_owner_machine_id=$2,
             lease_token=$3,lease_expires_at=now()+$4*interval '1 millisecond',
             claimed_at=now(),attempts=attempts+1,error=NULL,updated_at=now()
         FROM candidate,rooms room
         WHERE job.id=candidate.id AND room.id=job.source_room_id
         RETURNING job.id,job.lease_token,job.lease_expires_at,job.workspace_id,
                   job.source_room_id,job.source_message_id,job.requester_identity_id,
                   room.direct_participants,job.created_at`,
        [authenticatedAgentId, hostKey, leaseToken, leaseMs],
      )
    ).rows[0];
    if (!claimed) return undefined;
    const messages = await db.query<{
      id: string;
      author_id: string;
      created_at: Date;
      text: string;
    }>(
      `SELECT id,author_id,created_at,text FROM (
         SELECT id,author_id,created_at,text
         FROM messages
         WHERE room_id=$1 AND deleted_at IS NULL AND presentation='message'
           AND created_at<=$2 AND length(trim(text))>0
         ORDER BY created_at DESC,id DESC LIMIT $3
       ) recent ORDER BY created_at,id`,
      [claimed.source_room_id, claimed.created_at, INSTITUTIONAL_MEMORY_CONTEXT_MESSAGE_LIMIT],
    );
    return {
      id: claimed.id,
      leaseToken: claimed.lease_token,
      leaseExpiresAt: Math.floor(claimed.lease_expires_at.getTime() / 1_000),
      workspaceId: claimed.workspace_id,
      sourceRoomId: claimed.source_room_id,
      sourceMessageId: claimed.source_message_id,
      requesterIdentityId: claimed.requester_identity_id,
      directMessage: Array.isArray(claimed.direct_participants),
      messages: boundedMessages(messages.rows),
    };
  });
}

export async function heartbeatInstitutionalMemoryJob(
  database: SqlDatabase,
  authenticatedAgentId: string,
  input: { jobId: string; leaseToken: string },
  config: InstitutionalMemoryShadowConfig,
): Promise<void> {
  if (!config.enabled) throw new Error('institutional memory shadow is disabled');
  const leaseMs = Math.max(
    30_000,
    Math.min(config.leaseMs ?? DEFAULT_INSTITUTIONAL_MEMORY_LEASE_MS, 30 * 60_000),
  );
  const updated = await database.query(
    `UPDATE institutional_memory_jobs
     SET lease_expires_at=now()+$4*interval '1 millisecond',updated_at=now()
     WHERE id=$1 AND status='claimed' AND lease_owner_agent_id=$2
       AND lease_token=$3 AND lease_expires_at>now()`,
    [input.jobId, authenticatedAgentId, input.leaseToken, leaseMs],
  );
  if (!updated.rowCount) throw new Error('institutional memory job lease conflict');
}

function boundedUsage(value: InstitutionalMemoryJobUsage): InstitutionalMemoryJobUsage {
  const integer = (candidate: unknown, label: string, optional = false): number | undefined => {
    if (optional && candidate === undefined) return undefined;
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) < 0 ||
      (candidate as number) > 1_000_000_000
    ) {
      throw new Error(`institutional memory ${label} is invalid`);
    }
    return candidate as number;
  };
  const text = (candidate: unknown, label: string, maximum: number): string => {
    if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > maximum) {
      throw new Error(`institutional memory ${label} is invalid`);
    }
    return candidate.trim();
  };
  return {
    inputBytes: integer(value.inputBytes, 'input bytes')!,
    outputBytes: integer(value.outputBytes, 'output bytes')!,
    ...(value.inputTokens === undefined
      ? {}
      : { inputTokens: integer(value.inputTokens, 'input tokens', true) }),
    ...(value.outputTokens === undefined
      ? {}
      : { outputTokens: integer(value.outputTokens, 'output tokens', true) }),
    ...(value.estimatedCostUsdMicros === undefined
      ? {}
      : {
          estimatedCostUsdMicros: integer(value.estimatedCostUsdMicros, 'estimated cost', true),
        }),
    model: text(value.model, 'model', INSTITUTIONAL_MEMORY_MODEL_MAX_LENGTH),
    extractorVersion: text(
      value.extractorVersion,
      'extractor version',
      INSTITUTIONAL_MEMORY_EXTRACTOR_VERSION_MAX_LENGTH,
    ),
  };
}

const PROHIBITED_SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/,
  /\b(?:password|token|secret|api[_ -]?key)\s*[:=]\s*\S{8,}/i,
] as const;

function assertNoProhibitedSecret(
  proposal: ReturnType<typeof parseInstitutionalMemoryProposal>,
): void {
  const text = `${proposal.canonicalKey}\n${proposal.body}\n${proposal.classification.rationale}`;
  if (PROHIBITED_SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error('institutional memory proposal contains prohibited credential material');
  }
}

type CompletionRow = {
  id: string;
  status: string;
  lease_owner_agent_id: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  lease_current: boolean;
  workspace_id: string;
  source_room_id: string;
  source_message_id: string;
  source_request_id: string | null;
  requester_identity_id: string;
  direct_participants: unknown;
  proposal_hash: string | null;
};

/** Store a validated shadow verdict. It never creates an active memory item. */
export async function completeInstitutionalMemoryJob(
  database: SqlDatabase,
  authenticatedAgentId: string,
  input: CompleteInstitutionalMemoryJobInput,
  config: InstitutionalMemoryShadowConfig,
): Promise<void> {
  if (!config.enabled) throw new Error('institutional memory shadow is disabled');
  const proposal =
    input.proposal === null ? null : parseInstitutionalMemoryProposal(input.proposal);
  if (proposal) assertNoProhibitedSecret(proposal);
  const usage = boundedUsage(input.usage);
  const proposalJson = proposal === null ? 'null' : JSON.stringify(proposal);
  const proposalHash = createHash('sha256').update(proposalJson).digest('hex');
  await database.transaction(async (db) => {
    const job = (
      await db.query<CompletionRow>(
        `SELECT job.id,job.status,job.lease_owner_agent_id,job.lease_token,job.lease_expires_at,
                (job.lease_expires_at>now()) lease_current,
                job.workspace_id,job.source_room_id,job.source_message_id,job.source_request_id,
                job.requester_identity_id,job.proposal_hash,room.direct_participants
         FROM institutional_memory_jobs job
         JOIN rooms room ON room.id=job.source_room_id
         WHERE job.id=$1 FOR UPDATE OF job`,
        [input.jobId],
      )
    ).rows[0];
    if (!job) throw new Error('institutional memory job not found');
    if (job.status === 'completed') {
      if (job.proposal_hash === proposalHash) return;
      throw new Error('institutional memory job completion conflict');
    }
    if (
      job.status !== 'claimed' ||
      job.lease_owner_agent_id !== authenticatedAgentId ||
      job.lease_token !== input.leaseToken ||
      !job.lease_expires_at ||
      !job.lease_current
    ) {
      throw new Error('institutional memory job lease conflict');
    }

    if (proposal) {
      if (proposal.source.roomId !== job.source_room_id) {
        throw new Error('institutional memory proposal source room conflict');
      }
      if (!proposal.source.messageIds.includes(job.source_message_id)) {
        throw new Error('institutional memory proposal must cite its trigger message');
      }
      const validSources = await db.query<{ id: string }>(
        `SELECT id FROM messages
         WHERE room_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL
           AND presentation='message'`,
        [job.source_room_id, proposal.source.messageIds],
      );
      if (validSources.rowCount !== proposal.source.messageIds.length) {
        throw new Error('institutional memory proposal cites an unavailable source');
      }
      if (proposal.memoryKind === 'workspace_fact' && Array.isArray(job.direct_participants)) {
        throw new Error('direct-message facts cannot enter shared workspace memory');
      }
      if (
        proposal.memoryKind === 'human_profile_fact' &&
        proposal.subjectIdentityId !== job.requester_identity_id
      ) {
        throw new Error('institutional memory profile subject must be the requester');
      }
      const current = (
        await db.query<{ id: string; version: number }>(
          `SELECT id,version FROM institutional_memory_items
           WHERE workspace_id=$1 AND kind=$2
             AND subject_identity_id IS NOT DISTINCT FROM $3
             AND canonical_key=$4 AND audience_kind=$5 AND state='active'
           FOR UPDATE`,
          [
            job.workspace_id,
            proposal.memoryKind,
            proposal.subjectIdentityId ?? null,
            proposal.canonicalKey,
            proposal.audience,
          ],
        )
      ).rows[0];
      if (
        (current &&
          (proposal.cas.baseVersion !== current.version ||
            proposal.cas.supersedesItemId !== current.id)) ||
        (!current &&
          (proposal.cas.baseVersion !== null || proposal.cas.supersedesItemId !== undefined))
      ) {
        throw new Error('institutional memory proposal CAS conflict');
      }
    }

    await db.query(
      `UPDATE institutional_memory_jobs
       SET status='completed',proposal=$2::jsonb,proposal_hash=$3,extractor_version=$4,model=$5,
           input_bytes=$6,output_bytes=$7,input_tokens=$8,output_tokens=$9,
           estimated_cost_usd_micros=$10,completed_at=now(),updated_at=now(),error=NULL
       WHERE id=$1`,
      [
        job.id,
        proposalJson,
        proposalHash,
        usage.extractorVersion,
        usage.model,
        usage.inputBytes,
        usage.outputBytes,
        usage.inputTokens ?? null,
        usage.outputTokens ?? null,
        usage.estimatedCostUsdMicros ?? null,
      ],
    );
    const serveId = randomUUID();
    await db.query(
      `INSERT INTO institutional_context_serves
       (id,workspace_id,room_id,request_id,requester_identity_id,mode,served,shadow_job_id,
        candidate_count,total_bytes,estimated_tokens)
       VALUES($1,$2,$3,$4,$5,'shadow',false,$6,$7,0,0)`,
      [
        serveId,
        job.workspace_id,
        job.source_room_id,
        job.source_request_id,
        job.requester_identity_id,
        job.id,
        proposal ? 1 : 0,
      ],
    );
    if (proposal?.candidateType === 'correction_candidate') {
      await db.query(
        `INSERT INTO institutional_memory_correction_events
         (id,workspace_id,requester_identity_id,job_id,source_room_id,source_message_id,
          canonical_key,body,memory_kind,classifier_version,confidence)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          randomUUID(),
          job.workspace_id,
          job.requester_identity_id,
          job.id,
          job.source_room_id,
          job.source_message_id,
          proposal.canonicalKey,
          proposal.body,
          proposal.memoryKind,
          usage.extractorVersion,
          proposal.confidence,
        ],
      );
    } else if (proposal) {
      await db.query(
        `INSERT INTO institutional_memory_fact_events
         (id,workspace_id,job_id,source_room_id,source_message_id,canonical_key,body,
          classifier_version,confidence)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          randomUUID(),
          job.workspace_id,
          job.id,
          job.source_room_id,
          job.source_message_id,
          proposal.canonicalKey,
          proposal.body,
          usage.extractorVersion,
          proposal.confidence,
        ],
      );
    }
    await db.query(
      `INSERT INTO institutional_memory_outcomes
       (id,workspace_id,serve_id,job_id,room_id,request_id,kind,success,detail)
       VALUES($1,$2,$3,$4,$5,$6,'shadow_extracted',$7,$8::jsonb)`,
      [
        randomUUID(),
        job.workspace_id,
        serveId,
        job.id,
        job.source_room_id,
        job.source_request_id,
        true,
        JSON.stringify({ candidateType: proposal?.candidateType ?? null }),
      ],
    );
  });
}

export async function failInstitutionalMemoryJob(
  database: SqlDatabase,
  authenticatedAgentId: string,
  input: FailInstitutionalMemoryJobInput,
  config: InstitutionalMemoryShadowConfig,
): Promise<void> {
  if (!config.enabled) throw new Error('institutional memory shadow is disabled');
  if (
    typeof input.error !== 'string' ||
    !input.error.trim() ||
    input.error.length > INSTITUTIONAL_MEMORY_JOB_ERROR_MAX_LENGTH
  ) {
    throw new Error('institutional memory job error is invalid');
  }
  const updated = await database.query(
    `UPDATE institutional_memory_jobs
     SET status=CASE WHEN $4 AND attempts<max_attempts THEN 'retry' ELSE 'dead' END,
         next_attempt_at=CASE WHEN $4 AND attempts<max_attempts
           THEN now()+LEAST(3600,30*power(2,GREATEST(0,attempts-1))) * interval '1 second'
           ELSE next_attempt_at END,
         error=$5,lease_token=NULL,lease_expires_at=NULL,lease_owner_agent_id=NULL,
         lease_owner_machine_id=NULL,updated_at=now()
     WHERE id=$1 AND status='claimed' AND lease_owner_agent_id=$2
       AND lease_token=$3 AND lease_expires_at>now()`,
    [input.jobId, authenticatedAgentId, input.leaseToken, input.retryable, input.error.trim()],
  );
  if (!updated.rowCount) throw new Error('institutional memory job lease conflict');
}
