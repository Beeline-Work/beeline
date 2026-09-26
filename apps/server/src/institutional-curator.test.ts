import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import {
  claimInstitutionalMemoryJob,
  completeInstitutionalMemoryJob,
} from './institutional-memory-shadow.js';
import {
  AVAILABILITY_OBSERVATION_MAX_MS,
  INSTITUTIONAL_CONTEXT_TOKEN_TARGET,
  INSTITUTIONAL_CURATOR_CONTEXT_MAX_BYTES,
  applyInstitutionalCuratorProposal,
  institutionalObjectiveDashboard,
  recordWorkspaceHostAvailability,
  runInstitutionalCuratorCycle,
} from './institutional-curator.js';
import { PgliteDatabase } from './test-support.js';

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
  dailyTokenLimit: 100_000,
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
       (workspace_id,stage,auto_advance,curator_enabled,stale_after_days,archive_after_days,
        retention_days,availability_observed_at)
     VALUES($1,'pilot',true,true,30,60,120,$2)`,
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

  it('counts anchor-superseded procedures as the cycle stale-skill metric', async () => {
    // Two archived items pass retention, so a metric that counted their
    // tombstones instead of anchor mismatches would report 2, not 1.
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
        repository,target_commit,path,code_content_hash,updated_at)
       VALUES
        ($1,$3,'older-anchor','Older anchored procedure',1,1,$4,'Beeline-Work/beeline',$5,
         'apps/server/src/database.ts',$6,$8::timestamptz-interval '1 day'),
        ($2,$3,'newer-anchor','Newer anchored procedure',1,1,$4,'Beeline-Work/beeline',$5,
         'apps/server/src/database.ts',$7,$8::timestamptz)`,
      [
        SKILL,
        DUPLICATE_SKILL,
        WORKSPACE,
        ROOM,
        'f'.repeat(40),
        'a'.repeat(64),
        'b'.repeat(64),
        NOW,
      ],
    );

    await runInstitutionalCuratorCycle(database, liveConfig, NOW);

    // The archived item past retention is tombstoned but is not a stale skill.
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
        await database.query<{ state: string }>(`SELECT state FROM workspace_skills WHERE id=$1`, [
          DUPLICATE_SKILL,
        ])
      ).rows[0]?.state,
    ).toBe('active');
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
    // Every profile partition was curated recently; the shared one never was.
    await database.query(
      `UPDATE institutional_memory_items SET curated_at=$2
       WHERE workspace_id=$1 AND kind='human_profile_fact'`,
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
