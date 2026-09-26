import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import {
  claimInstitutionalMemoryJob,
  completeInstitutionalMemoryJob,
} from './institutional-memory-shadow.js';
import {
  AVAILABILITY_OBSERVATION_MAX_MS,
  CURATOR_CANDIDATE_WINDOW,
  INSTITUTIONAL_CURATOR_CANDIDATE_MAX,
  INSTITUTIONAL_CONTEXT_TOKEN_TARGET,
  INSTITUTIONAL_CURATOR_CONTEXT_MAX_BYTES,
  INSTITUTIONAL_REPEAT_WINDOW_DAYS,
  applyInstitutionalCuratorProposal,
  institutionalObjectiveDashboard,
  recordWorkspaceHostAvailability,
  runInstitutionalCuratorCycle,
} from './institutional-curator.js';
import { WORKSPACE_SKILL_ACTIVE_BYTES_MAX } from './institutional-skills.js';
import { PgliteDatabase } from './test-support.js';
import type { QueryResult, SqlDatabase } from './database.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000301';
const ROOM = '20000000-0000-4000-8000-000000000301';
const HUMAN = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const MESSAGE = 'curator-source-message';
const TARGET = '30000000-0000-4000-8000-000000000301';
const DUPLICATE = '30000000-0000-4000-8000-000000000302';
const STALE = '30000000-0000-4000-8000-000000000303';
const ARCHIVED = '30000000-0000-4000-8000-000000000304';
const PROFILE = '30000000-0000-4000-8000-000000000305';
const SKILL = '40000000-0000-4000-8000-000000000301';
const DUPLICATE_SKILL = '40000000-0000-4000-8000-000000000302';
const SKILL_JOB = '50000000-0000-4000-8000-000000000301';
const DUPLICATE_SKILL_JOB = '50000000-0000-4000-8000-000000000302';
const CURATOR_JOB = '50000000-0000-4000-8000-000000000303';
const NOW = new Date('2026-09-28T12:00:00Z');
const liveConfig = {
  enabled: true,
  live: true,
  dailyJobLimit: 50,
  leaseMs: 60_000,
} as const;

let database: PgliteDatabase;

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES($1,'human','Human'),($2,'agent','Bee')`,
    [HUMAN, AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Curator proof')`, [WORKSPACE]);
  await database.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'host-1')`, [
    AGENT,
    HUMAN,
  ]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Shared')`, [
    ROOM,
    WORKSPACE,
  ]);
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
       ($1,$4,$2,'owner'),($1,$4,$3,'member')`,
    [WORKSPACE, HUMAN, AGENT, ROOM],
  );
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES
       ($1,$2,$3,'Release migrations write the schema marker last.')`,
    [MESSAGE, ROOM, HUMAN],
  );
  await database.query(
    `INSERT INTO institutional_memory_workspace_rollouts
       (workspace_id,stage,auto_advance,stale_after_days,archive_after_days,
        retention_days,availability_observed_at)
     VALUES($1,'pilot',true,30,60,120,$2)`,
    [WORKSPACE, NOW],
  );
  await database.query(
    `INSERT INTO institutional_memory_items
       (id,workspace_id,kind,subject_identity_id,canonical_key,body,state,source_room_id,
        source_message_id,audience_kind,confidence,version,created_by_command_id,updated_at)
     VALUES
       ($1,$6,'workspace_fact',NULL,'release-marker','Write the release marker last.','active',$7,$8,'workspace',0.95,1,'seed-target',$9),
       ($2,$6,'workspace_fact',NULL,'schema-marker','The schema marker is written last.','active',$7,$8,'workspace',0.90,1,'seed-duplicate',$9-interval '40 days'),
       ($3,$6,'workspace_fact',NULL,'old-active','An old unused fact.','stale',$7,$8,'workspace',0.80,1,'seed-stale',$9-interval '90 days'),
       ($4,$6,'workspace_fact',NULL,'expired','Expired retained text.','archived',$7,$8,'workspace',0.70,1,'seed-archived',$9-interval '150 days'),
       ($5,$6,'human_profile_fact',$10,'human-style','Use compact updates.','active',$7,$8,'human_profile',0.99,1,'seed-profile',$9)`,
    [TARGET, DUPLICATE, STALE, ARCHIVED, PROFILE, WORKSPACE, ROOM, MESSAGE, NOW, HUMAN],
  );
  await database.query(
    `INSERT INTO institutional_memory_item_sources(item_id,message_id)
     SELECT id,$2 FROM institutional_memory_items WHERE workspace_id=$1`,
    [WORKSPACE, MESSAGE],
  );
});

afterEach(async () => {
  await database.close();
});

describe('weekly institutional curator', () => {
  async function seedConsolidatableSkills(fillerBytes: number): Promise<void> {
    const secondMessage = 'curator-second-source';
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Second source')`,
      [secondMessage, ROOM, HUMAN],
    );
    await database.query(
      `INSERT INTO institutional_memory_jobs
       (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
        requester_identity_id,source_audience_kind,idempotency_key)
       VALUES
        ($1,$4,'merge_review','live',$5,$6,$7,'workspace_candidate','skill-source-1'),
        ($2,$4,'merge_review','live',$5,$8,$7,'workspace_candidate','skill-source-2'),
        ($3,$4,'curator','live',$5,$6,$7,'workspace_candidate','skill-curator')`,
      [SKILL_JOB, DUPLICATE_SKILL_JOB, CURATOR_JOB, WORKSPACE, ROOM, MESSAGE, HUMAN, secondMessage],
    );
    await database.query(
      `INSERT INTO workspace_skills
       (id,workspace_id,slug,description,current_version,revision,source_room_id,
        repository,target_commit)
       VALUES
        ($1,$3,'release-safety','Release safely',1,1,$4,'Beeline-Work/beeline',$5),
        ($2,$3,'safe-releases','Safely release',1,1,$4,'Beeline-Work/beeline',$5)`,
      [SKILL, DUPLICATE_SKILL, WORKSPACE, ROOM, 'f'.repeat(40)],
    );
    await database.query(
      `INSERT INTO workspace_skill_versions
       (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
        repository,target_commit,extractor_version,model)
       VALUES
        ($1,1,repeat('x',$9::integer),$5,$3,ARRAY[$7]::text[],'Beeline-Work/beeline',$6,
         'test','test'),
        ($2,1,repeat('y',$9::integer),$5,$4,ARRAY[$8]::text[],'Beeline-Work/beeline',$6,
         'test','test')`,
      [
        SKILL,
        DUPLICATE_SKILL,
        SKILL_JOB,
        DUPLICATE_SKILL_JOB,
        'a'.repeat(64),
        'f'.repeat(40),
        MESSAGE,
        secondMessage,
        fillerBytes,
      ],
    );
  }

  function consolidateProposal(markdown: string) {
    return {
      workspaceId: WORKSPACE,
      jobId: CURATOR_JOB,
      sourceMessageId: MESSAGE,
      context: {
        partition: `workspace-skills:${ROOM}`,
        candidates: [
          {
            id: SKILL,
            targetType: 'workspace_skill' as const,
            version: 1,
            state: 'active' as const,
            key: 'release-safety',
            text: 'Release safely',
            sourceRoomId: ROOM,
            sourceMessageId: MESSAGE,
            requesterIdentityId: HUMAN,
          },
          {
            id: DUPLICATE_SKILL,
            targetType: 'workspace_skill' as const,
            version: 1,
            state: 'active' as const,
            key: 'safe-releases',
            text: 'Safely release',
            sourceRoomId: ROOM,
            sourceMessageId: 'curator-second-source',
            requesterIdentityId: HUMAN,
          },
        ],
      },
      proposal: {
        proposalVersion: 1 as const,
        partition: `workspace-skills:${ROOM}`,
        actions: [
          {
            action: 'consolidate' as const,
            targetType: 'workspace_skill' as const,
            targetId: SKILL,
            baseVersion: 1,
            duplicateIds: [DUPLICATE_SKILL],
            description: 'Release safely and consistently',
            markdown,
            rationale: 'These procedures have the same reusable purpose.',
          },
        ],
      },
      usage: { inputBytes: 10, outputBytes: 10, model: 'test', extractorVersion: 'test' },
    };
  }

  it('consolidates at the byte cap, counting the duplicates it retires as freed', async () => {
    // A Workspace filled exactly to the cap holds two 16 KiB duplicates. The
    // merged 24 KiB procedure is bigger than either one, so it only fits if the
    // duplicates it retires stop counting — which is the whole point.
    const duplicateBytes = 16 * 1024;
    const fillerBytes = 32 * 1024;
    const merged = 'm'.repeat(24 * 1024);
    const fillerRows = (WORKSPACE_SKILL_ACTIVE_BYTES_MAX - duplicateBytes * 2) / fillerBytes;
    expect(Number.isInteger(fillerRows)).toBe(true);
    await seedConsolidatableSkills(duplicateBytes);
    await database.query(
      `INSERT INTO workspace_skills
         (id,workspace_id,slug,description,current_version,revision,source_room_id,
          repository,target_commit)
       SELECT gen_random_uuid(),$1,'filler-'||series,'Filler',1,1,$2,'Beeline-Work/beeline',$3
       FROM generate_series(1,$4::integer) series`,
      [WORKSPACE, ROOM, 'f'.repeat(40), fillerRows],
    );
    await database.query(
      `INSERT INTO workspace_skill_versions
         (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
          repository,target_commit,extractor_version,model)
       SELECT id,1,repeat('f',$5::integer),$2,$3,ARRAY[$4]::text[],'Beeline-Work/beeline',
              $6,'test','test'
       FROM workspace_skills WHERE workspace_id=$1 AND slug LIKE 'filler-%'`,
      [WORKSPACE, 'c'.repeat(64), SKILL_JOB, MESSAGE, fillerBytes, 'f'.repeat(40)],
    );

    await expect(
      database.transaction((db) =>
        applyInstitutionalCuratorProposal(db, consolidateProposal(merged)),
      ),
    ).resolves.toMatchObject({ consolidatedSkills: 1 });
    expect(
      (
        await database.query<{ state: string }>(`SELECT state FROM workspace_skills WHERE id=$1`, [
          DUPLICATE_SKILL,
        ])
      ).rows[0]?.state,
    ).toBe('stale');
  });

  it('takes the per-slug advisory lock before locking the skill row', async () => {
    await seedConsolidatableSkills(64);
    const statements: string[] = [];
    const recorded = (inner: SqlDatabase): SqlDatabase => ({
      query: <Row extends Record<string, unknown>>(sql: string, values?: unknown[]) => {
        statements.push(sql);
        return inner.query(sql, values) as Promise<QueryResult<Row>>;
      },
      transaction: (work) => inner.transaction((db) => work(recorded(db))),
    });

    await database.transaction((db) =>
      applyInstitutionalCuratorProposal(recorded(db), consolidateProposal('Merged guidance.')),
    );

    // applyWorkspaceSkillProposal locks advisory-then-row, so the curator must
    // not take the row lock first: that ordering deadlocks against a merge.
    const advisory = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
    const rowLock = statements.findIndex((sql) => sql.includes('FOR UPDATE OF skill'));
    expect(advisory).toBeGreaterThanOrEqual(0);
    expect(rowLock).toBeGreaterThanOrEqual(0);
    expect(advisory).toBeLessThan(rowLock);
  });

  it('consolidates skill duplicates without losing either source', async () => {
    const secondMessage = 'curator-second-source';
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Second source')`,
      [secondMessage, ROOM, HUMAN],
    );
    await database.query(
      `INSERT INTO institutional_memory_jobs
       (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
        requester_identity_id,source_audience_kind,idempotency_key)
       VALUES
        ($1,$4,'merge_review','live',$5,$6,$7,'workspace_candidate','skill-source-1'),
        ($2,$4,'merge_review','live',$5,$8,$7,'workspace_candidate','skill-source-2'),
        ($3,$4,'curator','live',$5,$6,$7,'workspace_candidate','skill-curator')`,
      [SKILL_JOB, DUPLICATE_SKILL_JOB, CURATOR_JOB, WORKSPACE, ROOM, MESSAGE, HUMAN, secondMessage],
    );
    await database.query(
      `INSERT INTO workspace_skills
       (id,workspace_id,slug,description,current_version,revision,source_room_id,
        repository,target_commit)
       VALUES
        ($1,$3,'release-safety','Release safely',1,1,$4,'Beeline-Work/beeline',$5),
        ($2,$3,'safe-releases','Safely release',1,1,$4,'Beeline-Work/beeline',$5)`,
      [SKILL, DUPLICATE_SKILL, WORKSPACE, ROOM, 'f'.repeat(40)],
    );
    await database.query(
      `INSERT INTO workspace_skill_versions
       (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
        repository,target_commit,extractor_version,model)
       VALUES
        ($1,1,'Release safely.',$5,$3,ARRAY[$7]::text[],'Beeline-Work/beeline',$6,'test','test'),
        ($2,1,'Safely release.',$5,$4,ARRAY[$8]::text[],'Beeline-Work/beeline',$6,'test','test')`,
      [
        SKILL,
        DUPLICATE_SKILL,
        SKILL_JOB,
        DUPLICATE_SKILL_JOB,
        'a'.repeat(64),
        'f'.repeat(40),
        MESSAGE,
        secondMessage,
      ],
    );
    await database.transaction((db) =>
      applyInstitutionalCuratorProposal(db, {
        workspaceId: WORKSPACE,
        jobId: CURATOR_JOB,
        sourceMessageId: MESSAGE,
        context: {
          partition: `workspace-skills:${ROOM}`,
          candidates: [
            {
              id: SKILL,
              targetType: 'workspace_skill',
              version: 1,
              state: 'active',
              key: 'release-safety',
              text: 'Release safely',
              sourceRoomId: ROOM,
              sourceMessageId: MESSAGE,
              requesterIdentityId: HUMAN,
            },
            {
              id: DUPLICATE_SKILL,
              targetType: 'workspace_skill',
              version: 1,
              state: 'active',
              key: 'safe-releases',
              text: 'Safely release',
              sourceRoomId: ROOM,
              sourceMessageId: secondMessage,
              requesterIdentityId: HUMAN,
            },
          ],
        },
        proposal: {
          proposalVersion: 1,
          partition: `workspace-skills:${ROOM}`,
          actions: [
            {
              action: 'consolidate',
              targetType: 'workspace_skill',
              targetId: SKILL,
              baseVersion: 1,
              duplicateIds: [DUPLICATE_SKILL],
              description: 'Release safely and consistently',
              markdown: 'Use the release safety checklist.',
              rationale: 'These procedures have the same reusable purpose.',
            },
          ],
        },
        usage: { inputBytes: 10, outputBytes: 10, model: 'test', extractorVersion: 'test' },
      }),
    );
    expect(
      (
        await database.query<{ current_version: number }>(
          `SELECT current_version FROM workspace_skills WHERE id=$1`,
          [SKILL],
        )
      ).rows[0]?.current_version,
    ).toBe(2);
    expect(
      (
        await database.query<{ source_message_ids: string[] }>(
          `SELECT source_message_ids FROM workspace_skill_versions
           WHERE skill_id=$1 AND version=2`,
          [SKILL],
        )
      ).rows[0]?.source_message_ids.sort(),
    ).toEqual([MESSAGE, secondMessage].sort());
    expect(
      (
        await database.query<{ state: string }>(`SELECT state FROM workspace_skills WHERE id=$1`, [
          DUPLICATE_SKILL,
        ])
      ).rows[0]?.state,
    ).toBe('stale');
    // The surviving target counts as curated, so its partition stops re-winning
    // a job slot every cycle.
    expect(
      (
        await database.query<{ curated_at: Date | null }>(
          `SELECT curated_at FROM workspace_skills WHERE id=$1`,
          [SKILL],
        )
      ).rows[0]?.curated_at,
    ).toBeInstanceOf(Date);
  });

  it('advances a shadow cohort only after enough host-reviewed evidence', async () => {
    await database.query(
      `UPDATE institutional_memory_workspace_rollouts SET stage='shadow' WHERE workspace_id=$1`,
      [WORKSPACE],
    );
    for (let index = 0; index < 20; index += 1) {
      await database.query(
        `INSERT INTO institutional_memory_jobs
         (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
          requester_identity_id,source_audience_kind,idempotency_key,status,completed_at)
         VALUES($1,$2,'turn_review','shadow',$3,$4,$5,'workspace_candidate',$6,'completed',$7)`,
        [randomUUID(), WORKSPACE, ROOM, MESSAGE, HUMAN, `shadow-proof:${index}`, NOW],
      );
    }
    await database.query(
      `INSERT INTO institutional_memory_jobs
       (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
        requester_identity_id,source_audience_kind,idempotency_key,status,updated_at)
       VALUES($1,$2,'turn_review','shadow',$3,$4,$5,'workspace_candidate','old-dead','dead',
              now()-interval '3 days')`,
      [randomUUID(), WORKSPACE, ROOM, MESSAGE, HUMAN],
    );
    expect(await institutionalObjectiveDashboard(database, WORKSPACE)).toMatchObject({
      completedJobs: 20,
      deadJobs: 0,
      shadowReady: true,
      rolloutReady: false,
    });
    await database.query(
      `INSERT INTO institutional_memory_jobs
       (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
        requester_identity_id,source_audience_kind,idempotency_key,status,updated_at)
       VALUES($1,$2,'turn_review','shadow',$3,$4,$5,'workspace_candidate','fresh-dead','dead',now())`,
      [randomUUID(), WORKSPACE, ROOM, MESSAGE, HUMAN],
    );
    expect(await institutionalObjectiveDashboard(database, WORKSPACE)).toMatchObject({
      deadJobs: 1,
      shadowReady: false,
    });
    await database.query(
      `DELETE FROM institutional_memory_jobs WHERE idempotency_key='fresh-dead'`,
    );
    await runInstitutionalCuratorCycle(database, liveConfig, NOW);
    expect(
      (
        await database.query<{ state: string }>(
          `SELECT state FROM institutional_memory_items WHERE id=$1`,
          [DUPLICATE],
        )
      ).rows[0]?.state,
    ).toBe('active');
    expect(
      (
        await database.query<{ stage: string }>(
          `SELECT stage FROM institutional_memory_workspace_rollouts WHERE workspace_id=$1`,
          [WORKSPACE],
        )
      ).rows[0]?.stage,
    ).toBe('pilot');
  });

  it('counts time-based staling as the cycle stale-skill metric', async () => {
    // Two archived items pass retention, so a metric that counted their
    // tombstones instead of staled skills would report 2, not 1.
    await database.query(
      `INSERT INTO institutional_memory_items
       (id,workspace_id,kind,canonical_key,body,state,source_room_id,source_message_id,
        audience_kind,confidence,version,created_by_command_id,updated_at)
       VALUES($1,$2,'workspace_fact','second-expired','Another expired fact.','archived',$3,$4,
              'workspace',0.5,1,'seed-archived-2',$5::timestamptz-interval '150 days')`,
      ['30000000-0000-4000-8000-000000000306', WORKSPACE, ROOM, MESSAGE, NOW],
    );
    await database.query(
      `INSERT INTO workspace_skills
       (id,workspace_id,slug,description,current_version,revision,source_room_id,
        repository,target_commit,path,updated_at)
       VALUES($1,$2,'idle-anchor','An unserved anchored procedure',1,1,$3,
              'Beeline-Work/beeline',$4,'apps/server/src/database.ts',
              $5::timestamptz-interval '60 days')`,
      [SKILL, WORKSPACE, ROOM, 'f'.repeat(40), NOW],
    );

    await runInstitutionalCuratorCycle(database, liveConfig, NOW);

    expect(
      (
        await database.query<{ deleted_at: Date | null }>(
          `SELECT deleted_at FROM institutional_memory_items WHERE id=$1`,
          [ARCHIVED],
        )
      ).rows[0]?.deleted_at,
    ).toBeInstanceOf(Date);
    expect(
      (
        await database.query<{ state: string }>(`SELECT state FROM workspace_skills WHERE id=$1`, [
          SKILL,
        ])
      ).rows[0]?.state,
    ).toBe('stale');
    expect(
      (
        await database.query<{
          stale_skills: number;
          stale_items: number;
          archived_items: number;
        }>(
          `SELECT stale_skills,stale_items,archived_items FROM institutional_curator_cycles
           WHERE workspace_id=$1`,
          [WORKSPACE],
        )
      ).rows[0],
    ).toMatchObject({ stale_skills: 1, stale_items: 1, archived_items: 1 });
  });

  it('holds a pilot cohort while the per-turn token budget is exceeded', async () => {
    for (let index = 0; index < 20; index += 1) {
      const serveId = randomUUID();
      await database.query(
        `INSERT INTO institutional_context_serves
         (id,workspace_id,room_id,request_id,requester_identity_id,snapshot_revision,
          mode,served,total_bytes,estimated_tokens,actual_input_tokens)
         VALUES($1,$2,$3,$4,$5,1,'live',true,7900,1975,$6)`,
        [
          serveId,
          WORKSPACE,
          ROOM,
          `token-proof:${index}`,
          HUMAN,
          INSTITUTIONAL_CONTEXT_TOKEN_TARGET * 3,
        ],
      );
      await database.query(
        `INSERT INTO institutional_memory_outcomes
         (id,workspace_id,serve_id,room_id,request_id,kind,success)
         VALUES($1,$2,$3,$4,$5,'turn_completed',true)`,
        [randomUUID(), WORKSPACE, serveId, ROOM, `token-proof:${index}`],
      );
    }
    expect(await institutionalObjectiveDashboard(database, WORKSPACE)).toMatchObject({
      completedTurns: 20,
      successfulTurns: 20,
      p95ContextTokens: INSTITUTIONAL_CONTEXT_TOKEN_TARGET * 3,
      rolloutReady: false,
    });

    await database.query(`UPDATE institutional_context_serves SET actual_input_tokens=900`);
    expect(await institutionalObjectiveDashboard(database, WORKSPACE)).toMatchObject({
      p95ContextTokens: 900,
      rolloutReady: true,
    });
  });

  it('does not age memory or procedures while no helper host was available', async () => {
    const offlineStart = new Date(NOW.getTime() - 40 * 86_400_000);
    await database.query(
      `INSERT INTO workspace_skills
       (id,workspace_id,slug,description,current_version,revision,source_room_id,
        repository,target_commit,updated_at)
       VALUES($1,$2,'idle-procedure','An unused procedure',1,1,$3,'Beeline-Work/beeline',$4,$5)`,
      [SKILL, WORKSPACE, ROOM, 'f'.repeat(40), offlineStart],
    );

    // Two samples with no online helper host record the whole span as a gap.
    expect(await recordWorkspaceHostAvailability(database, WORKSPACE, offlineStart)).toBe(false);
    expect(await recordWorkspaceHostAvailability(database, WORKSPACE, NOW)).toBe(false);
    expect(
      (
        await database.query<{ started_at: Date; ended_at: Date }>(
          `SELECT started_at,ended_at FROM institutional_host_availability_gaps
           WHERE workspace_id=$1`,
          [WORKSPACE],
        )
      ).rows,
    ).toEqual([{ started_at: offlineStart, ended_at: NOW }]);

    await runInstitutionalCuratorCycle(database, liveConfig, NOW);
    const stateOf = async (table: 'institutional_memory_items' | 'workspace_skills', id: string) =>
      (await database.query<{ state: string }>(`SELECT state FROM ${table} WHERE id=$1`, [id]))
        .rows[0]?.state;
    // DUPLICATE was last touched 40 calendar days ago but 0 available days ago.
    expect(await stateOf('institutional_memory_items', DUPLICATE)).toBe('active');
    expect(await stateOf('workspace_skills', SKILL)).toBe('active');

    // The host comes back. Samples at the real cadence credit their spans with
    // no new gap row, which is what lets aging resume.
    await database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
       VALUES($1,$2,'presence','presence',$3::jsonb,$4)`,
      [ROOM, AGENT, JSON.stringify({ status: 'online', observedAt: NOW.getTime() }), NOW],
    );
    let observed = NOW;
    for (let sample = 0; sample < 3; sample += 1) {
      observed = new Date(observed.getTime() + AVAILABILITY_OBSERVATION_MAX_MS);
      await database.query(
        `UPDATE live_outputs SET updated_at=$2 WHERE agent_id=$1 AND kind='presence'`,
        [AGENT, observed],
      );
      expect(await recordWorkspaceHostAvailability(database, WORKSPACE, observed)).toBe(true);
    }
    const gapRows = async () =>
      (
        await database.query(
          `SELECT 1 FROM institutional_host_availability_gaps WHERE workspace_id=$1`,
          [WORKSPACE],
        )
      ).rowCount;
    expect(await gapRows()).toBe(1);

    // 31 credited days is that same loop repeated: the cursor advanced and no
    // gap was ever recorded for the span.
    const resumed = new Date(NOW.getTime() + 31 * 86_400_000);
    await database.query(
      `UPDATE institutional_memory_workspace_rollouts SET availability_observed_at=$2
       WHERE workspace_id=$1`,
      [WORKSPACE, resumed],
    );
    await database.query(
      `UPDATE live_outputs SET updated_at=$2 WHERE agent_id=$1 AND kind='presence'`,
      [AGENT, resumed],
    );

    await runInstitutionalCuratorCycle(database, liveConfig, resumed);
    expect(await gapRows()).toBe(1);
    expect(await stateOf('institutional_memory_items', DUPLICATE)).toBe('stale');
    expect(await stateOf('workspace_skills', SKILL)).toBe('stale');
  });

  it('never credits unobserved time to the aging clock', async () => {
    const created = new Date(NOW.getTime() - 200 * 86_400_000);
    await database.query(`UPDATE workspaces SET created_at=$2 WHERE id=$1`, [WORKSPACE, created]);
    await database.query(
      `UPDATE institutional_memory_workspace_rollouts SET availability_observed_at=NULL
       WHERE workspace_id=$1`,
      [WORKSPACE],
    );
    await database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
       VALUES($1,$2,'presence','presence',$3::jsonb,$4)`,
      [ROOM, AGENT, JSON.stringify({ status: 'online', observedAt: NOW.getTime() }), NOW],
    );

    // A host is online at the first sample, but nothing watched the 200 days before it.
    expect(await recordWorkspaceHostAvailability(database, WORKSPACE, NOW)).toBe(true);
    expect(
      (
        await database.query<{ started_at: Date; ended_at: Date }>(
          `SELECT started_at,ended_at FROM institutional_host_availability_gaps
           WHERE workspace_id=$1`,
          [WORKSPACE],
        )
      ).rows,
    ).toEqual([{ started_at: created, ended_at: NOW }]);

    await runInstitutionalCuratorCycle(database, liveConfig, NOW);
    const itemState = async (id: string) =>
      (
        await database.query<{ state: string }>(
          `SELECT state FROM institutional_memory_items WHERE id=$1`,
          [id],
        )
      ).rows[0]?.state;
    expect(await itemState(DUPLICATE)).toBe('active');
    expect(await itemState(STALE)).toBe('stale');
  });

  it('refuses to consolidate onto a superseded memory item', async () => {
    await database.query(
      `INSERT INTO institutional_memory_jobs
       (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
        requester_identity_id,source_audience_kind,idempotency_key)
       VALUES($1,$2,'curator','live',$3,$4,$5,'workspace_candidate','supersede-proof')`,
      [CURATOR_JOB, WORKSPACE, ROOM, MESSAGE, HUMAN],
    );
    // A turn review supersedes TARGET: it goes stale at its SAME version while
    // a newer row takes its canonical key, so the CAS alone still passes.
    const successor = '30000000-0000-4000-8000-000000000331';
    await database.query(`UPDATE institutional_memory_items SET state='stale' WHERE id=$1`, [
      TARGET,
    ]);
    await database.query(
      `INSERT INTO institutional_memory_items
         (id,workspace_id,kind,subject_identity_id,canonical_key,body,state,source_room_id,
          source_message_id,audience_kind,confidence,version,supersedes_id,
          created_by_command_id,updated_at)
       VALUES($1,$2,'workspace_fact',NULL,'release-marker','Write the marker last, always.',
              'active',$3,$4,'workspace',0.97,2,$5,'supersede-command',$6)`,
      [successor, WORKSPACE, ROOM, MESSAGE, TARGET, NOW],
    );

    const candidate = (id: string, key: string, state: 'active' | 'stale') => ({
      id,
      targetType: 'memory_item' as const,
      version: 1,
      state,
      key,
      text: 'A release invariant.',
      sourceRoomId: ROOM,
      sourceMessageId: MESSAGE,
      requesterIdentityId: HUMAN,
    });

    await expect(
      database.transaction((db) =>
        applyInstitutionalCuratorProposal(db, {
          workspaceId: WORKSPACE,
          jobId: CURATOR_JOB,
          sourceMessageId: MESSAGE,
          context: {
            partition: 'workspace-facts',
            candidates: [
              candidate(TARGET, 'release-marker', 'stale'),
              candidate(DUPLICATE, 'schema-marker', 'active'),
            ],
          },
          proposal: {
            proposalVersion: 1,
            partition: 'workspace-facts',
            actions: [
              {
                action: 'consolidate',
                targetType: 'memory_item',
                targetId: TARGET,
                baseVersion: 1,
                duplicateIds: [DUPLICATE],
                body: 'Write the release marker last.',
                rationale: 'These two describe one release invariant.',
              },
            ],
          },
          usage: { inputBytes: 10, outputBytes: 10, model: 'test', extractorVersion: 'test' },
        }),
      ),
    ).rejects.toThrow(/superseded/);

    // Exactly one active row keeps the canonical key, and it is the successor.
    expect(
      (
        await database.query<{ id: string }>(
          `SELECT id FROM institutional_memory_items
           WHERE workspace_id=$1 AND canonical_key='release-marker' AND state='active'
             AND deleted_at IS NULL`,
          [WORKSPACE],
        )
      ).rows.map((row) => row.id),
    ).toEqual([successor]);
  });

  it('retains a procedure record and its use ledger past retention', async () => {
    await database.query(
      `INSERT INTO institutional_memory_jobs
       (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
        requester_identity_id,source_audience_kind,idempotency_key)
       VALUES($1,$2,'merge_review','live',$3,$4,$5,'workspace_candidate','retention-proof')`,
      [SKILL_JOB, WORKSPACE, ROOM, MESSAGE, HUMAN],
    );
    // Archived long enough ago that this cycle's retention pass reaches it.
    await database.query(
      `INSERT INTO workspace_skills
       (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
        repository,target_commit,updated_at)
       VALUES($1,$2,'expired-procedure','An expired procedure','archived',1,1,$3,
              'Beeline-Work/beeline',$4,$5::timestamptz-interval '400 days')`,
      [SKILL, WORKSPACE, ROOM, 'f'.repeat(40), NOW],
    );
    await database.query(
      `INSERT INTO workspace_skill_versions
       (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
        repository,target_commit,extractor_version,model)
       VALUES($1,1,'The expired body.',$2,$3,ARRAY[$4]::text[],'Beeline-Work/beeline',$5,
              'test','test')`,
      [SKILL, 'a'.repeat(64), SKILL_JOB, MESSAGE, 'f'.repeat(40)],
    );
    await database.query(
      `INSERT INTO workspace_skill_uses
       (id,workspace_id,skill_id,skill_version,room_id,requester_identity_id,agent_id)
       VALUES($1,$2,$3,1,$4,$5,$6)`,
      [randomUUID(), WORKSPACE, SKILL, ROOM, HUMAN, AGENT],
    );
    const loadedBefore = (await institutionalObjectiveDashboard(database, WORKSPACE)).skillsLoaded;
    expect(loadedBefore).toBe(1);

    await runInstitutionalCuratorCycle(database, liveConfig, NOW);

    // The body is gone, but the record, its provenance and the load stay.
    expect(
      (
        await database.query<{ markdown: string; source_deleted_at: Date | null }>(
          `SELECT markdown,source_deleted_at FROM workspace_skill_versions WHERE skill_id=$1`,
          [SKILL],
        )
      ).rows[0],
    ).toMatchObject({ markdown: '', source_deleted_at: expect.any(Date) });
    expect(
      (
        await database.query<{ source_job_id: string; source_message_ids: string[] }>(
          `SELECT source_job_id,source_message_ids FROM workspace_skill_versions WHERE skill_id=$1`,
          [SKILL],
        )
      ).rows[0],
    ).toMatchObject({ source_job_id: SKILL_JOB, source_message_ids: [MESSAGE] });
    expect((await institutionalObjectiveDashboard(database, WORKSPACE)).skillsLoaded).toBe(
      loadedBefore,
    );
  });

  it('records one contiguous gap when the cursor advance shares the write', async () => {
    const offline = new Date(NOW.getTime() - 20 * 86_400_000);
    expect(await recordWorkspaceHostAvailability(database, WORKSPACE, offline)).toBe(false);
    expect(await recordWorkspaceHostAvailability(database, WORKSPACE, NOW)).toBe(false);
    // The cursor moved with the gap, so the next sample extends rather than
    // inserting a second overlapping span whose seconds would be counted twice.
    expect(
      (
        await database.query<{ started_at: Date; ended_at: Date }>(
          `SELECT started_at,ended_at FROM institutional_host_availability_gaps
           WHERE workspace_id=$1`,
          [WORKSPACE],
        )
      ).rows,
    ).toEqual([{ started_at: offline, ended_at: NOW }]);
    expect(
      (
        await database.query<{ observed_at: Date }>(
          `SELECT availability_observed_at observed_at
           FROM institutional_memory_workspace_rollouts WHERE workspace_id=$1`,
          [WORKSPACE],
        )
      ).rows[0],
    ).toMatchObject({ observed_at: NOW });

    // A third still-offline sample extends that one span instead of opening a
    // second overlapping one, so its seconds are never subtracted twice.
    const later = new Date(NOW.getTime() + 86_400_000);
    expect(await recordWorkspaceHostAvailability(database, WORKSPACE, later)).toBe(false);
    expect(
      (
        await database.query<{ started_at: Date; ended_at: Date }>(
          `SELECT started_at,ended_at FROM institutional_host_availability_gaps
           WHERE workspace_id=$1`,
          [WORKSPACE],
        )
      ).rows,
    ).toEqual([{ started_at: offline, ended_at: later }]);
  });

  it('does not restart the archive clock when stale re-affirms a stale row', async () => {
    await database.query(
      `INSERT INTO institutional_memory_jobs
       (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
        requester_identity_id,source_audience_kind,idempotency_key)
       VALUES($1,$2,'curator','live',$3,$4,$5,'workspace_candidate','restale-proof')`,
      [CURATOR_JOB, WORKSPACE, ROOM, MESSAGE, HUMAN],
    );
    // STALE was already staled long enough ago to be archived this cycle.
    const before = (
      await database.query<{ updated_at: Date; state: string }>(
        `SELECT updated_at,state FROM institutional_memory_items WHERE id=$1`,
        [STALE],
      )
    ).rows[0];
    expect(before?.state).toBe('stale');

    await database.transaction((db) =>
      applyInstitutionalCuratorProposal(db, {
        workspaceId: WORKSPACE,
        jobId: CURATOR_JOB,
        sourceMessageId: MESSAGE,
        context: {
          partition: 'workspace-facts',
          candidates: [
            {
              id: STALE,
              targetType: 'memory_item',
              version: 1,
              state: 'stale',
              key: 'old-active',
              text: 'An old unused fact.',
              sourceRoomId: ROOM,
              sourceMessageId: MESSAGE,
              requesterIdentityId: HUMAN,
            },
          ],
        },
        proposal: {
          proposalVersion: 1,
          partition: 'workspace-facts',
          actions: [
            {
              action: 'stale',
              targetType: 'memory_item',
              targetId: STALE,
              baseVersion: 1,
              duplicateIds: [],
              rationale: 'Still out of date, still worth keeping for now.',
            },
          ],
        },
        usage: { inputBytes: 10, outputBytes: 10, model: 'test', extractorVersion: 'test' },
      }),
    );

    expect(
      (
        await database.query<{ updated_at: Date; curated_at: Date | null; state: string }>(
          `SELECT updated_at,curated_at,state FROM institutional_memory_items WHERE id=$1`,
          [STALE],
        )
      ).rows[0],
    ).toMatchObject({
      updated_at: before?.updated_at,
      curated_at: expect.any(Date),
      state: 'stale',
    });

    // The archive countdown never restarted, so this cycle still archives it.
    await runInstitutionalCuratorCycle(database, liveConfig, NOW);
    expect(
      (
        await database.query<{ state: string }>(
          `SELECT state FROM institutional_memory_items WHERE id=$1`,
          [STALE],
        )
      ).rows[0]?.state,
    ).toBe('archived');
  });

  it('records a curator retain without restarting the staleness clock', async () => {
    await database.query(
      `INSERT INTO institutional_memory_jobs
       (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
        requester_identity_id,source_audience_kind,idempotency_key)
       VALUES($1,$2,'curator','live',$3,$4,$5,'workspace_candidate','retain-proof')`,
      [CURATOR_JOB, WORKSPACE, ROOM, MESSAGE, HUMAN],
    );
    const before = (
      await database.query<{ updated_at: Date }>(
        `SELECT updated_at FROM institutional_memory_items WHERE id=$1`,
        [DUPLICATE],
      )
    ).rows[0]?.updated_at;

    await database.transaction((db) =>
      applyInstitutionalCuratorProposal(db, {
        workspaceId: WORKSPACE,
        jobId: CURATOR_JOB,
        sourceMessageId: MESSAGE,
        context: {
          partition: 'workspace-facts',
          candidates: [
            {
              id: DUPLICATE,
              targetType: 'memory_item',
              version: 1,
              state: 'active',
              key: 'schema-marker',
              text: 'The schema marker is written last.',
              sourceRoomId: ROOM,
              sourceMessageId: MESSAGE,
              requesterIdentityId: HUMAN,
            },
          ],
        },
        proposal: {
          proposalVersion: 1,
          partition: 'workspace-facts',
          actions: [
            {
              action: 'retain',
              targetType: 'memory_item',
              targetId: DUPLICATE,
              baseVersion: 1,
              duplicateIds: [],
              rationale: 'This release invariant still reads as current.',
            },
          ],
        },
        usage: { inputBytes: 10, outputBytes: 10, model: 'test', extractorVersion: 'test' },
      }),
    );

    expect(
      (
        await database.query<{ updated_at: Date; curated_at: Date | null; state: string }>(
          `SELECT updated_at,curated_at,state FROM institutional_memory_items WHERE id=$1`,
          [DUPLICATE],
        )
      ).rows[0],
    ).toMatchObject({ updated_at: before, curated_at: expect.any(Date), state: 'active' });

    // The deterministic pass still ages it: retain is curation, not a serve.
    await runInstitutionalCuratorCycle(database, liveConfig, NOW);
    expect(
      (
        await database.query<{ state: string }>(
          `SELECT state FROM institutional_memory_items WHERE id=$1`,
          [DUPLICATE],
        )
      ).rows[0]?.state,
    ).toBe('stale');
  });

  it('fills the candidate window by curation age, not by kind', async () => {
    // Enough recently-curated profile rows to exhaust the candidate window: an
    // ordering led by kind reads no workspace_fact row at all.
    await database.query(
      `INSERT INTO institutional_memory_items
         (id,workspace_id,kind,subject_identity_id,canonical_key,body,state,source_room_id,
          source_message_id,audience_kind,confidence,version,created_by_command_id,
          updated_at,curated_at)
       SELECT gen_random_uuid(),$1,'human_profile_fact',$2,'bulk-'||series,
              'A bulk preference.','active',$3,$4,'human_profile',0.5,1,'bulk-seed',$5,$5
       FROM generate_series(1,1000) series`,
      [WORKSPACE, HUMAN, ROOM, MESSAGE, NOW],
    );

    await runInstitutionalCuratorCycle(database, liveConfig, NOW);

    expect(
      (
        await database.query<{ context: { partition: string } }>(
          `SELECT context FROM institutional_memory_jobs WHERE trigger_kind='curator'`,
        )
      ).rows.map((job) => job.context.partition),
    ).toContain('workspace-facts');
  });

  it('never crowds one partition out of the window with another partition volume', async () => {
    // One partition holding far more than the window: per-partition capping is
    // what leaves room for every other partition, including the shared one.
    await database.query(
      `INSERT INTO institutional_memory_items
         (id,workspace_id,kind,subject_identity_id,canonical_key,body,state,source_room_id,
          source_message_id,audience_kind,confidence,version,created_by_command_id,updated_at)
       SELECT gen_random_uuid(),$1,'human_profile_fact',$2,'flood-'||series,
              'A flooding preference.','active',$3,$4,'human_profile',0.5,1,'flood-seed',$5
       FROM generate_series(1,$6::integer) series`,
      [WORKSPACE, HUMAN, ROOM, MESSAGE, NOW, CURATOR_CANDIDATE_WINDOW + 500],
    );

    await runInstitutionalCuratorCycle(database, liveConfig, NOW);

    const jobs = (
      await database.query<{ context: { partition: string; candidates: unknown[] } }>(
        `SELECT context FROM institutional_memory_jobs WHERE trigger_kind='curator'`,
      )
    ).rows;
    expect(jobs.map((job) => job.context.partition)).toContain('workspace-facts');
    expect(Math.max(...jobs.map((job) => job.context.candidates.length))).toBeLessThanOrEqual(
      INSTITUTIONAL_CURATOR_CANDIDATE_MAX,
    );
  });

  it('advances the rotation cursor for a partition the cycle only considered', async () => {
    await runInstitutionalCuratorCycle(database, liveConfig, NOW);
    // No host model answered, yet the shared partition must not re-win forever.
    expect(
      (
        await database.query<{ count: string }>(
          `SELECT count(*)::text count FROM institutional_memory_items
           WHERE workspace_id=$1 AND kind='workspace_fact' AND state IN ('active','stale')
             AND curated_at IS NULL`,
          [WORKSPACE],
        )
      ).rows[0]?.count,
    ).toBe('0');
    // Consideration is not a serve: the staleness clock is untouched.
    expect(
      (
        await database.query<{ updated_at: Date }>(
          `SELECT updated_at FROM institutional_memory_items WHERE id=$1`,
          [TARGET],
        )
      ).rows[0]?.updated_at,
    ).toEqual(NOW);
  });

  it('rotates the weekly job budget across partitions instead of a fixed prefix', async () => {
    // Profile partitions sort before workspace facts by kind, so a fixed prefix
    // of one job would starve the shared partition forever.
    const others = ['1'.repeat(64), '2'.repeat(64)];
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','One'),($2,'human','Two')`,
      others,
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,'member'),($1,NULL,$3,'member'),
         ($1,$4,$2,'member'),($1,$4,$3,'member')`,
      [WORKSPACE, others[0], others[1], ROOM],
    );
    await database.query(
      `INSERT INTO institutional_memory_items
         (id,workspace_id,kind,subject_identity_id,canonical_key,body,state,source_room_id,
          source_message_id,audience_kind,confidence,version,created_by_command_id,curated_at)
       VALUES
         ($1,$5,'human_profile_fact',$3,'one-style','Terse updates.','active',$6,$7,
          'human_profile',0.9,1,'seed-one',NULL),
         ($2,$5,'human_profile_fact',$4,'two-style','Long updates.','active',$6,$7,
          'human_profile',0.9,1,'seed-two',NULL)`,
      [
        '30000000-0000-4000-8000-000000000311',
        '30000000-0000-4000-8000-000000000312',
        others[0],
        others[1],
        WORKSPACE,
        ROOM,
        MESSAGE,
      ],
    );
    // Each profile partition ALSO receives a fresh, never-curated item this week,
    // the steady state of an active Workspace.
    await database.query(
      `INSERT INTO institutional_memory_items
         (id,workspace_id,kind,subject_identity_id,canonical_key,body,state,source_room_id,
          source_message_id,audience_kind,confidence,version,created_by_command_id,updated_at)
       VALUES
         ($1,$4,'human_profile_fact',$5,'one-fresh','Fresh one.','active',$7,$8,
          'human_profile',0.9,1,'fresh-one',$9),
         ($2,$4,'human_profile_fact',$6,'two-fresh','Fresh two.','active',$7,$8,
          'human_profile',0.9,1,'fresh-two',$9),
         ($3,$4,'human_profile_fact',$10,'human-fresh','Fresh human.','active',$7,$8,
          'human_profile',0.9,1,'fresh-human',$9)`,
      [
        '30000000-0000-4000-8000-000000000321',
        '30000000-0000-4000-8000-000000000322',
        '30000000-0000-4000-8000-000000000323',
        WORKSPACE,
        others[0],
        others[1],
        ROOM,
        MESSAGE,
        NOW,
        HUMAN,
      ],
    );
    // Every profile partition was curated THIS cycle; the shared one 40 days ago.
    await database.query(
      `UPDATE institutional_memory_items SET curated_at=$2
       WHERE workspace_id=$1 AND kind='human_profile_fact' AND curated_at IS NULL
         AND canonical_key NOT LIKE '%-fresh'`,
      [WORKSPACE, NOW],
    );
    await database.query(
      `UPDATE institutional_memory_items SET curated_at=$2::timestamptz-interval '40 days'
       WHERE workspace_id=$1 AND kind='workspace_fact'`,
      [WORKSPACE, NOW],
    );

    await expect(
      runInstitutionalCuratorCycle(database, { ...liveConfig, dailyJobLimit: 1 }, NOW),
    ).resolves.toBe(1);
    expect(
      (
        await database.query<{ context: { partition: string } }>(
          `SELECT context FROM institutional_memory_jobs WHERE trigger_kind='curator'`,
        )
      ).rows.map((job) => job.context.partition),
    ).toEqual(['workspace-facts']);
  });

  it('leaves the week unclaimed when the daily job budget is already spent', async () => {
    // The day's turn reviews have already spent the cap before the first tick
    // of this week lands.
    await database.query(
      `INSERT INTO institutional_memory_jobs
       (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
        requester_identity_id,source_audience_kind,idempotency_key,created_at)
       SELECT gen_random_uuid(),$1,'turn_review','live',$2,$3,$4,'workspace_candidate',
              'spent-'||series,$5
       FROM generate_series(1,$6::integer) series`,
      [WORKSPACE, ROOM, MESSAGE, HUMAN, NOW, 3],
    );

    await expect(
      runInstitutionalCuratorCycle(database, { ...liveConfig, dailyJobLimit: 3 }, NOW),
    ).resolves.toBe(0);
    // No cycle row, so the week is still available to a later tick.
    expect((await database.query(`SELECT 1 FROM institutional_curator_cycles`)).rowCount).toBe(0);

    // A later tick with budget does the week's work.
    await expect(
      runInstitutionalCuratorCycle(database, { ...liveConfig, dailyJobLimit: 50 }, NOW),
    ).resolves.toBeGreaterThan(0);
    expect(
      (
        await database.query<{ queued_jobs: number }>(
          `SELECT queued_jobs FROM institutional_curator_cycles WHERE workspace_id=$1`,
          [WORKSPACE],
        )
      ).rows[0]?.queued_jobs,
    ).toBeGreaterThan(0);
  });

  it('keeps weekly curator jobs inside the shared daily Workspace cap', async () => {
    await expect(
      runInstitutionalCuratorCycle(database, { ...liveConfig, dailyJobLimit: 1 }, NOW),
    ).resolves.toBe(1);
    expect(
      (
        await database.query<{ queued_jobs: number }>(
          `SELECT queued_jobs FROM institutional_curator_cycles WHERE workspace_id=$1`,
          [WORKSPACE],
        )
      ).rows[0]?.queued_jobs,
    ).toBe(1);
  });

  it('counts only a serve that happened after the item stopped being current', async () => {
    // STALE transitioned long ago, so serving it NOW is a genuine stale serve.
    // TARGET is active. DUPLICATE is served now and staled afterwards, which is
    // the curator working correctly, not a stale serve.
    const servedNow = randomUUID();
    await database.query(
      `INSERT INTO institutional_context_serves
       (id,workspace_id,room_id,request_id,requester_identity_id,snapshot_revision,
        mode,served,total_bytes,estimated_tokens,item_ids,created_at)
       VALUES($1,$2,$3,'stale-serve-proof',$4,1,'live',true,900,225,
              ARRAY[$5,$6,$7]::uuid[],$8)`,
      [servedNow, WORKSPACE, ROOM, HUMAN, TARGET, STALE, DUPLICATE, NOW],
    );

    const before = await institutionalObjectiveDashboard(database, WORKSPACE);
    expect(before).toMatchObject({
      servedItems: 3,
      staleServedItems: 1,
      staleServeRate: 1 / 3,
    });

    // Aging DUPLICATE after the serve must not turn that serve retroactively
    // stale: the rate is a measure of what we served, not of what has aged.
    await database.query(
      `UPDATE institutional_memory_items SET state='stale',updated_at=$2
       WHERE id=$1`,
      [DUPLICATE, new Date(NOW.getTime() + 86_400_000)],
    );
    expect(await institutionalObjectiveDashboard(database, WORKSPACE)).toMatchObject({
      servedItems: 3,
      staleServedItems: 1,
      staleServeRate: 1 / 3,
    });
  });

  it('counts repeats beyond the first in the correction and review ledgers', async () => {
    const job = (key: string) => {
      const id = randomUUID();
      return database
        .query(
          `INSERT INTO institutional_memory_jobs
           (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
            requester_identity_id,source_audience_kind,idempotency_key)
           VALUES($1,$2,'turn_review','live',$3,$4,$5,'workspace_candidate',$6)`,
          [id, WORKSPACE, ROOM, MESSAGE, HUMAN, key],
        )
        .then(() => id);
    };
    const other = '9'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Other')`, [
      other,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, other, ROOM],
    );
    // A shared fact corrected by two DIFFERENT people is one repeat: the fact is
    // served Workspace-wide, so the Workspace paid for the same lesson twice.
    // A profile fact only repeats for its own subject, and one unrelated key
    // and one unrelated path never count.
    const corrections: Array<{ who: string; kind: string; key: string }> = [
      { who: HUMAN, kind: 'workspace_fact', key: 'shared-key' },
      { who: other, kind: 'workspace_fact', key: 'shared-key' },
      { who: HUMAN, kind: 'human_profile_fact', key: 'repeated-key' },
      { who: HUMAN, kind: 'human_profile_fact', key: 'repeated-key' },
      { who: other, kind: 'human_profile_fact', key: 'repeated-key' },
      { who: HUMAN, kind: 'workspace_fact', key: 'other-key' },
    ];
    for (const [index, correction] of corrections.entries()) {
      const jobId = await job(`repeat-${index}`);
      await database.query(
        `INSERT INTO institutional_memory_correction_events
         (id,workspace_id,requester_identity_id,job_id,source_room_id,source_message_id,
          canonical_key,body,memory_kind,classifier_version,confidence)
         VALUES($1,$2,$3,$4,$5,$6,$7,'A correction.',$8,'v1',0.9)`,
        [
          randomUUID(),
          WORKSPACE,
          correction.who,
          jobId,
          ROOM,
          MESSAGE,
          correction.key,
          correction.kind,
        ],
      );
    }
    for (const [index, path] of [
      'apps/server/src/database.ts',
      'apps/server/src/database.ts',
      'apps/server/src/database.ts',
      null,
    ].entries()) {
      const jobId = await job(`finding-${index}`);
      await database.query(
        `INSERT INTO institutional_review_findings
         (id,workspace_id,job_id,source_corner_id,taxonomy,summary,severity,path,
          classifier_version,confidence)
         VALUES($1,$2,$3,$4,'database.release-order','Marker last.','warning',$5,'v1',0.9)`,
        [randomUUID(), WORKSPACE, jobId, ROOM, path],
      );
    }

    // Three more corrections of one key land in the PRIOR window, and two in
    // the window before that — old enough to belong to neither measurement.
    for (const [index, age] of [
      INSTITUTIONAL_REPEAT_WINDOW_DAYS + 2,
      INSTITUTIONAL_REPEAT_WINDOW_DAYS + 3,
      INSTITUTIONAL_REPEAT_WINDOW_DAYS + 4,
      INSTITUTIONAL_REPEAT_WINDOW_DAYS * 2 + 5,
      INSTITUTIONAL_REPEAT_WINDOW_DAYS * 2 + 6,
    ].entries()) {
      const jobId = await job(`aged-${index}`);
      await database.query(
        `INSERT INTO institutional_memory_correction_events
         (id,workspace_id,requester_identity_id,job_id,source_room_id,source_message_id,
          canonical_key,body,memory_kind,classifier_version,confidence,created_at)
         VALUES($1,$2,$3,$4,$5,$6,'aged-key','A correction.','workspace_fact','v1',0.9,
                now()-$7*interval '1 day')`,
        [randomUUID(), WORKSPACE, HUMAN, jobId, ROOM, MESSAGE, age],
      );
    }

    // shared-key: 2 events, 1 repeat. repeated-key for HUMAN: 2 events, 1
    // repeat. repeated-key for `other`: 1 event, no repeat. other-key: none.
    // The prior window holds 3 aged-key events (2 repeats); the pair before it
    // is outside both windows and contributes to neither, so the reduction the
    // criteria ask for is readable from one dashboard read.
    expect(await institutionalObjectiveDashboard(database, WORKSPACE)).toMatchObject({
      repeatWindowDays: INSTITUTIONAL_REPEAT_WINDOW_DAYS,
      repeatedCorrections: 2,
      priorRepeatedCorrections: 2,
      repeatedReviewFindings: 2,
      priorRepeatedReviewFindings: 0,
    });
  });

  it('advances a pilot cohort only after successful bounded live outcomes', async () => {
    for (let index = 0; index < 20; index += 1) {
      const serveId = randomUUID();
      await database.query(
        `INSERT INTO institutional_context_serves
         (id,workspace_id,room_id,request_id,requester_identity_id,snapshot_revision,
          mode,served,total_bytes,estimated_tokens)
         VALUES($1,$2,$3,$4,$5,1,'live',true,1200,300)`,
        [serveId, WORKSPACE, ROOM, `pilot-proof:${index}`, HUMAN],
      );
      await database.query(
        `INSERT INTO institutional_memory_outcomes
         (id,workspace_id,serve_id,room_id,request_id,kind,success)
         VALUES($1,$2,$3,$4,$5,'turn_completed',true)`,
        [randomUUID(), WORKSPACE, serveId, ROOM, `pilot-proof:${index}`],
      );
    }
    expect(await institutionalObjectiveDashboard(database, WORKSPACE)).toMatchObject({
      completedTurns: 20,
      successfulTurns: 20,
      p95ContextBytes: 1200,
      rolloutReady: true,
    });
    await runInstitutionalCuratorCycle(database, liveConfig, NOW);
    expect(
      (
        await database.query<{ stage: string }>(
          `SELECT stage FROM institutional_memory_workspace_rollouts WHERE workspace_id=$1`,
          [WORKSPACE],
        )
      ).rows[0]?.stage,
    ).toBe('live');
  });

  it('ages, retains, partitions, consolidates, and records one simulated cycle', async () => {
    await expect(runInstitutionalCuratorCycle(database, liveConfig, NOW)).resolves.toBe(2);
    await expect(runInstitutionalCuratorCycle(database, liveConfig, NOW)).resolves.toBe(0);

    expect(
      (
        await database.query<{ state: string }>(
          `SELECT state FROM institutional_memory_items WHERE id=$1`,
          [DUPLICATE],
        )
      ).rows[0]?.state,
    ).toBe('stale');
    expect(
      (
        await database.query<{ state: string }>(
          `SELECT state FROM institutional_memory_items WHERE id=$1`,
          [STALE],
        )
      ).rows[0]?.state,
    ).toBe('archived');
    expect(
      (
        await database.query<{ body: string; deleted_at: Date | null }>(
          `SELECT body,deleted_at FROM institutional_memory_items WHERE id=$1`,
          [ARCHIVED],
        )
      ).rows[0],
    ).toMatchObject({ body: '', deleted_at: expect.any(Date) });

    const partitions = (
      await database.query<{ id: string; context: { partition: string } }>(
        `SELECT id,context FROM institutional_memory_jobs WHERE trigger_kind='curator'`,
      )
    ).rows;
    expect(partitions.map((job) => job.context.partition).sort()).toEqual([
      `human-profile:${HUMAN}:${ROOM}`,
      'workspace-facts',
    ]);
    expect(
      Math.max(...partitions.map((job) => Buffer.byteLength(JSON.stringify(job.context), 'utf8'))),
    ).toBeLessThanOrEqual(INSTITUTIONAL_CURATOR_CONTEXT_MAX_BYTES);

    let workspaceJob: Awaited<ReturnType<typeof claimInstitutionalMemoryJob>> | undefined;
    for (let index = 0; index < 2; index += 1) {
      const claimed = await claimInstitutionalMemoryJob(database, AGENT, liveConfig);
      expect(claimed).toBeDefined();
      expect(claimed).toMatchObject({ messages: [], existingItems: [] });
      if (claimed?.context?.partition === 'workspace-facts') {
        workspaceJob = claimed;
        break;
      }
      await completeInstitutionalMemoryJob(
        database,
        AGENT,
        {
          agentId: AGENT,
          jobId: claimed!.id,
          leaseToken: claimed!.leaseToken,
          proposal: null,
          usage: {
            inputBytes: 10,
            outputBytes: 4,
            model: 'test',
            extractorVersion: 'curator-v1',
          },
        },
        liveConfig,
      );
    }
    expect(workspaceJob).toBeDefined();
    await completeInstitutionalMemoryJob(
      database,
      AGENT,
      {
        agentId: AGENT,
        jobId: workspaceJob!.id,
        leaseToken: workspaceJob!.leaseToken,
        proposal: {
          proposalVersion: 1,
          partition: 'workspace-facts',
          actions: [
            {
              action: 'consolidate',
              targetType: 'memory_item',
              targetId: TARGET,
              baseVersion: 1,
              duplicateIds: [DUPLICATE],
              body: 'Release migrations write the schema marker last.',
              rationale: 'The two active-history entries describe one release invariant.',
            },
          ],
        },
        usage: {
          inputBytes: 100,
          outputBytes: 80,
          inputTokens: 25,
          outputTokens: 20,
          model: 'test',
          extractorVersion: 'curator-v1',
        },
      },
      liveConfig,
    );
    const active = await database.query<{ body: string; version: number }>(
      `SELECT body,version FROM institutional_memory_items
       WHERE workspace_id=$1 AND canonical_key='release-marker' AND state='active'`,
      [WORKSPACE],
    );
    expect(active.rows).toEqual([
      { body: 'Release migrations write the schema marker last.', version: 2 },
    ]);
    expect(
      (
        await database.query<{ consolidated_items: number }>(
          `SELECT consolidated_items FROM institutional_curator_cycles WHERE workspace_id=$1`,
          [WORKSPACE],
        )
      ).rows[0]?.consolidated_items,
    ).toBe(1);
    expect(await institutionalObjectiveDashboard(database, WORKSPACE)).toMatchObject({
      workspaceId: WORKSPACE,
      rolloutReady: false,
    });
    expect(
      (
        await database.query<{ stage: string }>(
          `SELECT stage FROM institutional_memory_workspace_rollouts WHERE workspace_id=$1`,
          [WORKSPACE],
        )
      ).rows[0]?.stage,
    ).toBe('pilot');
  });
});
