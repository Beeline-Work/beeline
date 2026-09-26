import { randomUUID } from 'node:crypto';
import {
  parseInstitutionalCuratorProposal,
  type InstitutionalCuratorProposal,
  type InstitutionalMemoryJobUsage,
} from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';
import type { InstitutionalMemoryShadowConfig } from './institutional-memory-shadow.js';
import {
  applyWorkspaceSkillProposal,
  assertRestrictedWorkspaceSkillSafe,
} from './institutional-skills.js';

export const DEFAULT_CURATOR_WEEKLY_JOB_LIMIT = 20;
export const INSTITUTIONAL_CURATOR_CONTEXT_MAX_BYTES = 64 * 1_024;
export const INSTITUTIONAL_CURATOR_CANDIDATE_MAX = 50;
/** The per-turn institutional context budget the rollout gate holds p95 to. */
export const INSTITUTIONAL_CONTEXT_TOKEN_TARGET = 2_000;

const PROHIBITED_CURATOR_SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/,
  /\b(?:password|token|secret|api[_ -]?key)\s*[:=]\s*\S{8,}/i,
] as const;

type CuratorCandidate = {
  id: string;
  targetType: 'memory_item' | 'workspace_skill';
  version: number;
  state: 'active' | 'stale';
  key: string;
  text: string;
  repository?: string;
  path?: string;
  sourceRoomId: string;
  sourceMessageId: string;
  requesterIdentityId: string;
};

type CuratorPartition = {
  workspaceId: string;
  key: string;
  audience: 'workspace_candidate' | 'human_private';
  candidates: CuratorCandidate[];
};

function boundedCuratorCandidates(candidates: readonly CuratorCandidate[]): CuratorCandidate[] {
  const bounded: CuratorCandidate[] = [];
  let bytes = 0;
  for (const candidate of candidates.slice(0, INSTITUTIONAL_CURATOR_CANDIDATE_MAX)) {
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8') + 1;
    // Reserve one KiB for the partition/cycle wrapper surrounding the array.
    if (bytes + candidateBytes > INSTITUTIONAL_CURATOR_CONTEXT_MAX_BYTES - 1_024) break;
    bounded.push(candidate);
    bytes += candidateBytes;
  }
  return bounded;
}

export interface InstitutionalObjectiveDashboard {
  readonly workspaceId: string;
  readonly contextServes: number;
  readonly completedJobs: number;
  readonly completedTurns: number;
  readonly successfulTurns: number;
  readonly p95ContextBytes: number;
  readonly p95ContextTokens: number;
  readonly skillCandidatesServed: number;
  readonly skillsLoaded: number;
  readonly searches: number;
  readonly deadJobs: number;
  readonly shadowReady: boolean;
  readonly rolloutReady: boolean;
}

function utcWeekKey(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

export async function institutionalObjectiveDashboard(
  database: SqlDatabase,
  workspaceId: string,
): Promise<InstitutionalObjectiveDashboard> {
  const row = (
    await database.query<{
      context_serves: string;
      completed_jobs: string;
      completed_turns: string;
      successful_turns: string;
      p95_context_bytes: string;
      p95_context_tokens: string;
      skill_candidates_served: string;
      skills_loaded: string;
      searches: string;
      dead_jobs: string;
    }>(
      `SELECT
         (SELECT count(*) FROM institutional_context_serves
          WHERE workspace_id=$1 AND mode='live' AND served) context_serves,
         (SELECT count(*) FROM institutional_memory_outcomes
          WHERE workspace_id=$1 AND kind='turn_completed') completed_turns,
         (SELECT count(*) FROM institutional_memory_jobs
          WHERE workspace_id=$1 AND status='completed') completed_jobs,
         (SELECT count(*) FROM institutional_memory_outcomes
          WHERE workspace_id=$1 AND kind='turn_completed' AND success) successful_turns,
         COALESCE((SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY total_bytes)
          FROM institutional_context_serves WHERE workspace_id=$1 AND mode='live'),0) p95_context_bytes,
         COALESCE((SELECT percentile_disc(0.95) WITHIN GROUP (
            ORDER BY COALESCE(actual_input_tokens,estimated_tokens))
          FROM institutional_context_serves WHERE workspace_id=$1 AND mode='live'),0) p95_context_tokens,
         COALESCE((SELECT sum(cardinality(skill_candidates))
          FROM institutional_context_serves WHERE workspace_id=$1 AND mode='live'),0) skill_candidates_served,
         (SELECT count(*) FROM workspace_skill_uses WHERE workspace_id=$1) skills_loaded,
         (SELECT count(*) FROM institutional_history_searches WHERE workspace_id=$1) searches,
         (SELECT count(*) FROM institutional_memory_jobs
          WHERE workspace_id=$1 AND status='dead'
            AND updated_at>=now()-interval '24 hours') dead_jobs`,
      [workspaceId],
    )
  ).rows[0];
  const contextServes = Number(row?.context_serves ?? 0);
  const completedJobs = Number(row?.completed_jobs ?? 0);
  const completedTurns = Number(row?.completed_turns ?? 0);
  const successfulTurns = Number(row?.successful_turns ?? 0);
  const p95ContextBytes = Number(row?.p95_context_bytes ?? 0);
  const p95ContextTokens = Number(row?.p95_context_tokens ?? 0);
  const deadJobs = Number(row?.dead_jobs ?? 0);
  return {
    workspaceId,
    contextServes,
    completedJobs,
    completedTurns,
    successfulTurns,
    p95ContextBytes,
    p95ContextTokens,
    skillCandidatesServed: Number(row?.skill_candidates_served ?? 0),
    skillsLoaded: Number(row?.skills_loaded ?? 0),
    searches: Number(row?.searches ?? 0),
    deadJobs,
    shadowReady: completedJobs >= 20 && deadJobs === 0,
    rolloutReady:
      completedTurns >= 20 &&
      successfulTurns / Math.max(1, completedTurns) >= 0.9 &&
      p95ContextTokens <= INSTITUTIONAL_CONTEXT_TOKEN_TARGET &&
      deadJobs === 0,
  };
}

async function deterministicLifecycle(
  database: SqlDatabase,
  workspaceId: string,
  now: Date,
  staleAfterDays: number,
  archiveAfterDays: number,
  retentionDays: number,
): Promise<{
  staleItems: number;
  archivedItems: number;
  staleSkills: number;
  archivedSkills: number;
}> {
  const staleItems = await database.query(
    `UPDATE institutional_memory_items item SET state='stale',updated_at=$2
     WHERE item.workspace_id=$1 AND item.state='active' AND item.deleted_at IS NULL
       AND item.updated_at<$2::timestamptz-$3*interval '1 day'
       AND (item.last_served_at IS NULL OR item.last_served_at<$2::timestamptz-$3*interval '1 day')`,
    [workspaceId, now, staleAfterDays],
  );
  const archivedItems = await database.query(
    `UPDATE institutional_memory_items item SET state='archived',updated_at=$2
     WHERE item.workspace_id=$1 AND item.state='stale' AND item.deleted_at IS NULL
       AND item.updated_at<$2::timestamptz-$3*interval '1 day'
       AND (item.last_served_at IS NULL OR item.last_served_at<$2::timestamptz-$3*interval '1 day')`,
    [workspaceId, now, archiveAfterDays],
  );
  await database.query(
    `UPDATE institutional_memory_items item
     SET body='',deleted_at=$2,updated_at=$2
     WHERE item.workspace_id=$1 AND item.state='archived' AND item.deleted_at IS NULL
       AND item.updated_at<$2::timestamptz-$3*interval '1 day'`,
    [workspaceId, now, retentionDays],
  );

  // A newer checked content hash for the same code surface supersedes the old
  // anchor. This pass is the only owner of that rule.
  const anchorStaleSkills = await database.query(
    `UPDATE workspace_skills older SET state='stale',updated_at=$2
     WHERE older.workspace_id=$1 AND older.state='active' AND older.path IS NOT NULL
       AND older.code_content_hash IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM workspace_skills newer
         WHERE newer.workspace_id=older.workspace_id AND newer.id<>older.id
           AND newer.state='active' AND newer.repository=older.repository
           AND newer.path=older.path AND newer.code_content_hash IS NOT NULL
           AND newer.code_content_hash<>older.code_content_hash
           AND newer.updated_at>older.updated_at
       )`,
    [workspaceId, now],
  );
  const staleSkills = await database.query(
    `UPDATE workspace_skills skill SET state='stale',updated_at=$2
     WHERE skill.workspace_id=$1 AND skill.state='active'
       AND skill.updated_at<$2::timestamptz-$3*interval '1 day'
       AND (skill.last_served_at IS NULL OR skill.last_served_at<$2::timestamptz-$3*interval '1 day')
       AND NOT EXISTS (
         SELECT 1 FROM workspace_skill_uses use
         WHERE use.skill_id=skill.id AND use.created_at>=$2::timestamptz-$3*interval '1 day'
       )`,
    [workspaceId, now, staleAfterDays],
  );
  const archivedSkills = await database.query(
    `UPDATE workspace_skills skill SET state='archived',updated_at=$2
     WHERE skill.workspace_id=$1 AND skill.state='stale'
       AND skill.updated_at<$2::timestamptz-$3*interval '1 day'
       AND (skill.last_served_at IS NULL OR skill.last_served_at<$2::timestamptz-$3*interval '1 day')
       AND NOT EXISTS (
         SELECT 1 FROM workspace_skill_uses use
         WHERE use.skill_id=skill.id AND use.created_at>=$2::timestamptz-$3*interval '1 day'
       )`,
    [workspaceId, now, archiveAfterDays],
  );
  await database.query(
    `DELETE FROM workspace_skills skill
     WHERE skill.workspace_id=$1 AND skill.state='archived'
       AND skill.updated_at<$2::timestamptz-$3*interval '1 day'`,
    [workspaceId, now, retentionDays],
  );
  return {
    staleItems: staleItems.rowCount,
    archivedItems: archivedItems.rowCount,
    staleSkills: anchorStaleSkills.rowCount + staleSkills.rowCount,
    archivedSkills: archivedSkills.rowCount,
  };
}

async function curatorPartitions(
  database: SqlDatabase,
  workspaceId: string,
): Promise<CuratorPartition[]> {
  const memory = await database.query<{
    id: string;
    kind: 'workspace_fact' | 'human_profile_fact';
    subject_identity_id: string | null;
    canonical_key: string;
    body: string;
    version: number;
    state: 'active' | 'stale';
    source_room_id: string;
    source_message_id: string;
    requester_identity_id: string;
    repository: string | null;
    path: string | null;
  }>(
    `SELECT item.id,item.kind,item.subject_identity_id,item.canonical_key,item.body,item.version,
            item.state,item.source_room_id,item.source_message_id,source.author_id requester_identity_id,
            item.repository,item.path
     FROM institutional_memory_items item
     JOIN messages source ON source.id=item.source_message_id AND source.deleted_at IS NULL
     JOIN identities requester ON requester.id=source.author_id AND requester.kind='human'
     WHERE item.workspace_id=$1 AND item.state IN ('active','stale') AND item.deleted_at IS NULL
     ORDER BY item.kind,item.subject_identity_id,item.source_room_id,
              item.curated_at ASC NULLS FIRST,item.updated_at DESC,item.id
     LIMIT 1000`,
    [workspaceId],
  );
  const skills = await database.query<{
    id: string;
    slug: string;
    description: string;
    current_version: number;
    state: 'active' | 'stale';
    source_room_id: string;
    source_message_id: string;
    requester_identity_id: string;
    repository: string;
    path: string | null;
  }>(
    `SELECT skill.id,skill.slug,skill.description,skill.current_version,skill.state,
            skill.source_room_id,job.source_message_id,job.requester_identity_id,
            skill.repository,skill.path
     FROM workspace_skills skill
     JOIN workspace_skill_versions version
       ON version.skill_id=skill.id AND version.version=skill.current_version
     JOIN institutional_memory_jobs job ON job.id=version.source_job_id
     JOIN messages source ON source.id=job.source_message_id AND source.deleted_at IS NULL
     WHERE skill.workspace_id=$1 AND skill.state IN ('active','stale')
       AND version.source_deleted_at IS NULL
     ORDER BY skill.source_room_id,skill.curated_at ASC NULLS FIRST,skill.updated_at DESC,skill.id
     LIMIT 1000`,
    [workspaceId],
  );
  const groups = new Map<string, CuratorPartition>();
  for (const item of memory.rows) {
    const key =
      item.kind === 'workspace_fact'
        ? 'workspace-facts'
        : `human-profile:${item.subject_identity_id}:${item.source_room_id}`;
    const partition = groups.get(key) ?? {
      workspaceId,
      key,
      audience: item.kind === 'workspace_fact' ? 'workspace_candidate' : 'human_private',
      candidates: [],
    };
    partition.candidates.push({
      id: item.id,
      targetType: 'memory_item',
      version: item.version,
      state: item.state,
      key: item.canonical_key,
      text: item.body,
      ...(item.repository ? { repository: item.repository } : {}),
      ...(item.path ? { path: item.path } : {}),
      sourceRoomId: item.source_room_id,
      sourceMessageId: item.source_message_id,
      requesterIdentityId: item.requester_identity_id,
    });
    groups.set(key, partition);
  }
  for (const skill of skills.rows) {
    const key = `workspace-skills:${skill.source_room_id}`;
    const partition = groups.get(key) ?? {
      workspaceId,
      key,
      audience: 'workspace_candidate',
      candidates: [],
    };
    partition.candidates.push({
      id: skill.id,
      targetType: 'workspace_skill',
      version: skill.current_version,
      state: skill.state,
      key: skill.slug,
      text: skill.description,
      repository: skill.repository,
      ...(skill.path ? { path: skill.path } : {}),
      sourceRoomId: skill.source_room_id,
      sourceMessageId: skill.source_message_id,
      requesterIdentityId: skill.requester_identity_id,
    });
    groups.set(key, partition);
  }
  return [...groups.values()].map((partition) => ({
    ...partition,
    candidates: boundedCuratorCandidates(partition.candidates),
  }));
}

/** One idempotent weekly pass: deterministic aging first, then host-side consolidation jobs. */
export async function runInstitutionalCuratorCycle(
  database: SqlDatabase,
  config: InstitutionalMemoryShadowConfig,
  now = new Date(),
): Promise<number> {
  if (!config.enabled) return 0;
  const rollouts = await database.query<{
    workspace_id: string;
    stage: 'shadow' | 'pilot' | 'live';
    auto_advance: boolean;
    stale_after_days: number;
    archive_after_days: number;
    retention_days: number;
  }>(
    `SELECT workspace_id,stage,auto_advance,stale_after_days,archive_after_days,retention_days
     FROM institutional_memory_workspace_rollouts
     WHERE curator_enabled AND stage IN ('shadow','pilot','live')
     ORDER BY cohort,workspace_id`,
  );
  const week = utcWeekKey(now);
  let queued = 0;
  for (const rollout of rollouts.rows) {
    const cycleKey = `weekly:${week}`;
    let workspaceQueued: number;
    try {
      workspaceQueued = await database.transaction(async (db) => {
        await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `institutional-memory:${rollout.workspace_id}`,
        ]);
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO institutional_curator_cycles(id,workspace_id,cycle_key)
         VALUES($1,$2,$3) ON CONFLICT(workspace_id,cycle_key) DO NOTHING RETURNING id`,
          [randomUUID(), rollout.workspace_id, cycleKey],
        );
        if (!inserted.rowCount) return 0;
        const lifecycle =
          !config.live || rollout.stage === 'shadow'
            ? { staleItems: 0, archivedItems: 0, staleSkills: 0, archivedSkills: 0 }
            : await deterministicLifecycle(
                db,
                rollout.workspace_id,
                now,
                rollout.stale_after_days,
                rollout.archive_after_days,
                rollout.retention_days,
              );
        const partitions = await curatorPartitions(db, rollout.workspace_id);
        const jobsToday = Number(
          (
            await db.query<{ count: string }>(
              `SELECT count(*)::text count FROM institutional_memory_jobs
             WHERE workspace_id=$1 AND created_at>=date_trunc('day',$2::timestamptz)`,
              [rollout.workspace_id, now],
            )
          ).rows[0]?.count ?? 0,
        );
        const remainingDailyJobs = Math.max(0, (config.dailyJobLimit ?? 50) - jobsToday);
        let cycleQueued = 0;
        for (const partition of partitions.slice(
          0,
          Math.min(DEFAULT_CURATOR_WEEKLY_JOB_LIMIT, remainingDailyJobs),
        )) {
          const source = partition.candidates[0];
          if (!source) continue;
          const result = await db.query(
            `INSERT INTO institutional_memory_jobs
           (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
            requester_identity_id,source_audience_kind,idempotency_key,context)
           VALUES($1,$2,'curator',$3,$4,$5,$6,$7,$8,$9::jsonb)
           ON CONFLICT(idempotency_key) DO NOTHING`,
            [
              randomUUID(),
              rollout.workspace_id,
              rollout.stage === 'shadow' ? 'shadow' : config.live ? 'live' : 'shadow',
              source.sourceRoomId,
              source.sourceMessageId,
              source.requesterIdentityId,
              partition.audience,
              `curator:${rollout.workspace_id}:${partition.key}:${week}`,
              JSON.stringify({
                partition: partition.key,
                cycleKey,
                candidates: partition.candidates,
              }),
            ],
          );
          cycleQueued += result.rowCount;
        }
        const dashboard = await institutionalObjectiveDashboard(db, rollout.workspace_id);
        const advanceShadow = rollout.stage === 'shadow' && dashboard.shadowReady;
        const advancePilot = rollout.stage === 'pilot' && dashboard.rolloutReady;
        if (rollout.auto_advance && (advanceShadow || advancePilot)) {
          await db.query(
            `UPDATE institutional_memory_workspace_rollouts
           SET stage=CASE stage WHEN 'shadow' THEN 'pilot' WHEN 'pilot' THEN 'live' ELSE stage END,
               updated_at=$2
           WHERE workspace_id=$1`,
            [rollout.workspace_id, now],
          );
        }
        await db.query(
          `UPDATE institutional_curator_cycles
         SET queued_jobs=$3,stale_items=$4,archived_items=$5,stale_skills=$6,
             archived_skills=$7,completed_at=$2
         WHERE workspace_id=$1 AND cycle_key=$8`,
          [
            rollout.workspace_id,
            now,
            cycleQueued,
            lifecycle.staleItems,
            lifecycle.archivedItems,
            lifecycle.staleSkills,
            lifecycle.archivedSkills,
            cycleKey,
          ],
        );
        return cycleQueued;
      });
    } catch (error) {
      console.error(
        `[server] institutional curator Workspace cycle failed (${rollout.workspace_id}):`,
        error,
      );
      continue;
    }
    queued += workspaceQueued;
  }
  return queued;
}

function contextCandidates(context: Record<string, unknown> | null): Map<string, CuratorCandidate> {
  const values = context?.candidates;
  if (!Array.isArray(values)) throw new Error('institutional curator context is invalid');
  return new Map(
    values
      .filter(
        (value): value is CuratorCandidate =>
          Boolean(value) &&
          typeof value === 'object' &&
          typeof (value as CuratorCandidate).id === 'string' &&
          ((value as CuratorCandidate).targetType === 'memory_item' ||
            (value as CuratorCandidate).targetType === 'workspace_skill'),
      )
      .map((value) => [value.id, value]),
  );
}

export async function applyInstitutionalCuratorProposal(
  database: SqlDatabase,
  input: {
    workspaceId: string;
    jobId: string;
    sourceMessageId: string;
    context: Record<string, unknown> | null;
    proposal: InstitutionalCuratorProposal;
    usage: InstitutionalMemoryJobUsage;
  },
): Promise<{ consolidatedItems: number; consolidatedSkills: number }> {
  const parsed = parseInstitutionalCuratorProposal(input.proposal);
  if (parsed.partition !== input.context?.partition) {
    throw new Error('institutional curator partition conflict');
  }
  const candidates = contextCandidates(input.context);
  let consolidatedItems = 0;
  let consolidatedSkills = 0;
  for (const action of parsed.actions) {
    const target = candidates.get(action.targetId);
    const duplicates = action.duplicateIds.map((id) => candidates.get(id));
    if (
      !target ||
      target.targetType !== action.targetType ||
      duplicates.some((candidate) => !candidate || candidate.targetType !== action.targetType)
    ) {
      throw new Error('institutional curator action escapes its audience partition');
    }
    const allIds = [action.targetId, ...action.duplicateIds];
    if (new Set(allIds).size !== allIds.length) {
      throw new Error('institutional curator duplicate targets are invalid');
    }
    if (action.targetType === 'memory_item') {
      const rows = await database.query<{
        id: string;
        kind: 'workspace_fact' | 'human_profile_fact';
        subject_identity_id: string | null;
        canonical_key: string;
        version: number;
        state: 'active' | 'stale';
        source_room_id: string;
        source_message_id: string;
        source_corner_id: string | null;
        audience_kind: 'workspace' | 'human_profile';
        confidence: number;
        repository: string | null;
        target_commit: string | null;
        path: string | null;
        content_hash: string | null;
      }>(
        `SELECT id,kind,subject_identity_id,canonical_key,version,state,source_room_id,
                source_message_id,source_corner_id,audience_kind,confidence,repository,
                target_commit,path,content_hash
         FROM institutional_memory_items
         WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL
         FOR UPDATE`,
        [input.workspaceId, allIds],
      );
      if (rows.rowCount !== allIds.length) {
        throw new Error('institutional curator memory target is unavailable');
      }
      const current = rows.rows.find((row) => row.id === action.targetId)!;
      if (current.version !== action.baseVersion) {
        throw new Error('institutional curator memory CAS conflict');
      }
      if (action.action === 'archive' && current.state !== 'stale') {
        throw new Error('institutional curator memory must become stale before archive');
      }
      if (action.action === 'consolidate') {
        if (PROHIBITED_CURATOR_SECRET_PATTERNS.some((pattern) => pattern.test(action.body!))) {
          throw new Error('institutional curator memory contains prohibited credential material');
        }
        if (
          rows.rows.some(
            (row) =>
              row.kind !== current.kind ||
              row.subject_identity_id !== current.subject_identity_id ||
              row.audience_kind !== current.audience_kind,
          )
        ) {
          throw new Error('institutional curator cannot merge audience partitions');
        }
        await database.query(
          `UPDATE institutional_memory_items SET state='stale',curated_at=now(),updated_at=now()
           WHERE id=ANY($1::uuid[])`,
          [allIds],
        );
        const nextId = randomUUID();
        await database.query(
          `INSERT INTO institutional_memory_items
           (id,workspace_id,kind,subject_identity_id,canonical_key,body,state,source_room_id,
            source_message_id,source_corner_id,audience_kind,confidence,version,supersedes_id,
            created_by_job_id,repository,target_commit,path,content_hash,curated_at)
           VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now())`,
          [
            nextId,
            input.workspaceId,
            current.kind,
            current.subject_identity_id,
            current.canonical_key,
            action.body,
            current.source_room_id,
            current.source_message_id,
            current.source_corner_id,
            current.audience_kind,
            current.confidence,
            current.version + 1,
            current.id,
            input.jobId,
            current.repository,
            current.target_commit,
            current.path,
            current.content_hash,
          ],
        );
        await database.query(
          `INSERT INTO institutional_memory_item_sources(item_id,message_id)
           SELECT $1,message_id FROM institutional_memory_item_sources
           WHERE item_id=ANY($2::uuid[]) ON CONFLICT DO NOTHING`,
          [nextId, allIds],
        );
        consolidatedItems += 1;
      } else {
        await database.query(
          `UPDATE institutional_memory_items SET state=$2,curated_at=now(),updated_at=now()
           WHERE id=$1`,
          [
            current.id,
            action.action === 'retain'
              ? current.state
              : action.action === 'stale'
                ? 'stale'
                : 'archived',
          ],
        );
      }
    } else {
      const rows = await database.query<{
        id: string;
        slug: string;
        description: string;
        current_version: number;
        source_room_id: string;
        repository: string;
        target_commit: string;
        path: string | null;
        code_content_hash: string | null;
        state: 'active' | 'stale';
        source_message_ids: string[];
      }>(
        `SELECT skill.id,skill.slug,skill.description,skill.current_version,skill.source_room_id,
                skill.repository,skill.target_commit,skill.path,skill.code_content_hash,skill.state,
                version.source_message_ids
         FROM workspace_skills skill
         JOIN workspace_skill_versions version
           ON version.skill_id=skill.id AND version.version=skill.current_version
         WHERE skill.workspace_id=$1 AND skill.id=ANY($2::uuid[])
           AND skill.state IN ('active','stale') AND version.source_deleted_at IS NULL
         FOR UPDATE OF skill`,
        [input.workspaceId, allIds],
      );
      if (rows.rowCount !== allIds.length) {
        throw new Error('institutional curator skill target is unavailable');
      }
      const current = rows.rows.find((row) => row.id === action.targetId)!;
      if (current.current_version !== action.baseVersion) {
        throw new Error('institutional curator skill CAS conflict');
      }
      if (action.action === 'archive' && current.state !== 'stale') {
        throw new Error('institutional curator skill must become stale before archive');
      }
      if (action.action === 'consolidate') {
        if (rows.rows.some((row) => row.source_room_id !== current.source_room_id)) {
          throw new Error('institutional curator cannot merge skill audience partitions');
        }
        const restricted = {
          proposalVersion: 1 as const,
          skill: {
            slug: current.slug,
            description: action.description!,
            markdown: action.markdown!,
            baseVersion: current.current_version,
            anchor: {
              repository: current.repository,
              targetCommit: current.target_commit,
              ...(current.path ? { path: current.path } : {}),
              ...(current.code_content_hash ? { contentHash: current.code_content_hash } : {}),
            },
          },
          findings: [],
        };
        assertRestrictedWorkspaceSkillSafe(restricted);
        await applyWorkspaceSkillProposal(database, {
          workspaceId: input.workspaceId,
          sourceRoomId: current.source_room_id,
          sourceMessageIds: [
            ...new Set([
              input.sourceMessageId,
              ...rows.rows.flatMap((row) => row.source_message_ids),
            ]),
          ],
          sourceJobId: input.jobId,
          usage: input.usage,
          proposal: restricted.skill,
        });
        await database.query(
          `UPDATE workspace_skills SET state='stale',curated_at=now(),updated_at=now()
           WHERE id=ANY($1::uuid[])`,
          [action.duplicateIds],
        );
        consolidatedSkills += 1;
      } else {
        await database.query(
          `UPDATE workspace_skills SET state=$2,curated_at=now(),updated_at=now() WHERE id=$1`,
          [
            current.id,
            action.action === 'retain'
              ? current.state
              : action.action === 'stale'
                ? 'stale'
                : 'archived',
          ],
        );
      }
    }
  }
  const cycleKey = input.context?.cycleKey;
  if (typeof cycleKey === 'string') {
    await database.query(
      `UPDATE institutional_curator_cycles
       SET consolidated_items=consolidated_items+$3,
           consolidated_skills=consolidated_skills+$4
       WHERE workspace_id=$1 AND cycle_key=$2`,
      [input.workspaceId, cycleKey, consolidatedItems, consolidatedSkills],
    );
  }
  return { consolidatedItems, consolidatedSkills };
}
