import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import {
  INSTITUTIONAL_SKILL_ANCHOR_RECHECK_MS,
  refreshWorkspaceSkillAnchors,
  type InstitutionalSkillAnchorSource,
} from './institutional-skill-anchors.js';
import { PgliteDatabase } from './test-support.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000301';
const ROOM = '20000000-0000-4000-8000-000000000301';
const CORNER = '20000000-0000-4000-8000-000000000302';
const REQUESTER = 'a'.repeat(64);
const AUTHOR = 'b'.repeat(64);
const ROOT = 'anchor-root-message';
const REVIEW_MESSAGE = 'anchor-review-message';
const JOB = '30000000-0000-4000-8000-000000000301';
const SKILL = '40000000-0000-4000-8000-000000000301';
const RELEASE_COMMIT = 'e'.repeat(40);
const OTHER_COMMIT = 'f'.repeat(40);

let database: PgliteDatabase;

const RELEASE_PATH = 'apps/server/src/release.ts';

/** The `<path>@<ref>` digest key the stand-in GitHub answers from. */
function at(path: string, ref: string): string {
  return `${path}@${ref}`;
}

/**
 * A GitHub stand-in: `fileBlobSha` answers from a table of path@ref digests, and
 * any ref named in `broken` throws the way a dead token or a rate limit does.
 */
function anchorSource(input: {
  digests: Record<string, string>;
  broken?: string[];
  defaultBranch?: string;
}): InstitutionalSkillAnchorSource {
  return {
    resolveRoomRepository: async () => ({
      token: 'installation-token',
      repository: 'Beeline-Work/beeline',
      defaultBranch: input.defaultBranch ?? 'main',
    }),
    fileBlobSha: async (request) => {
      const key = `${request.path}@${request.ref}`;
      if (input.broken?.includes(key)) throw new Error('GitHub file lookup failed: HTTP 403');
      return input.digests[key];
    },
  };
}

async function seedSkill(input: { path: string | null }): Promise<void> {
  await database.query(
    `INSERT INTO workspace_skills
     (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
      repository,target_commit,path)
     VALUES($1,$2,'safe-release-migrations','Keep release migrations safe','active',1,1,$3,
            'Beeline-Work/beeline',$4,$5)`,
    [SKILL, WORKSPACE, CORNER, RELEASE_COMMIT, input.path],
  );
  await database.query(
    `INSERT INTO workspace_skill_versions
     (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,repository,
      target_commit,path,extractor_version,model)
     VALUES($1,1,'# Safe release migrations',$6,$2,ARRAY[$3],
            'Beeline-Work/beeline',$4,$5,'extractor-1','host-model')`,
    [SKILL, JOB, REVIEW_MESSAGE, RELEASE_COMMIT, input.path, 'a'.repeat(64)],
  );
}

async function skillState(): Promise<{
  state: string;
  code_content_hash: string | null;
  anchor_stale_reason: string | null;
  anchor_checked_at: Date | null;
}> {
  const row = (
    await database.query<{
      state: string;
      code_content_hash: string | null;
      anchor_stale_reason: string | null;
      anchor_checked_at: Date | null;
    }>(
      `SELECT state,code_content_hash,anchor_stale_reason,anchor_checked_at
       FROM workspace_skills WHERE id=$1`,
      [SKILL],
    )
  ).rows[0]!;
  return row;
}

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES
       ($1,'human','Requester'),($2,'agent','Implementer')`,
    [REQUESTER, AUTHOR],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Anchors')`, [WORKSPACE]);
  await database.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'host-1')`, [
    AUTHOR,
    REQUESTER,
  ]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_resolution)
     VALUES($1,$2,'Anchor parent','Beeline-Work/beeline','repository')`,
    [ROOM, WORKSPACE],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_resolution,parent_id)
     VALUES($1,$2,'Anchor corner','Beeline-Work/beeline','repository',$3)`,
    [CORNER, WORKSPACE, ROOM],
  );
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at) VALUES
       ($1,$2,$3,'Please keep release migrations safe','message',now()-interval '2 minutes'),
       ($4,$5,$6,'Migrations land outside a transaction.','message',now()-interval '1 minute')`,
    [ROOT, ROOM, REQUESTER, REVIEW_MESSAGE, CORNER, AUTHOR],
  );
  await database.query(
    `INSERT INTO institutional_memory_jobs
     (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,requester_identity_id,
      source_audience_kind,idempotency_key,status,proposal_hash,extractor_version,model)
     VALUES($1,$2,'merge_review','live',$3,$4,$5,'workspace_candidate','anchor-job','completed',
            repeat('b',64),'extractor-1','host-model')`,
    [JOB, WORKSPACE, CORNER, REVIEW_MESSAGE, REQUESTER],
  );
});

afterEach(async () => {
  await database.close();
});

describe('Workspace procedure code anchors', () => {
  it('records the anchored commit blob, then stales the procedure when the current code differs', async () => {
    await seedSkill({ path: 'apps/server/src/release.ts' });
    const source = anchorSource({
      digests: { [at(RELEASE_PATH, RELEASE_COMMIT)]: '1'.repeat(40) },
    });
    const baselined = await refreshWorkspaceSkillAnchors(database, WORKSPACE, source);
    expect(baselined).toMatchObject({ checked: 1, baselined: 1, staled: 0, failed: 0 });
    expect(await skillState()).toMatchObject({
      state: 'active',
      code_content_hash: '1'.repeat(40),
      anchor_stale_reason: null,
    });

    // The same blob still on the default branch is agreement, not staleness.
    const unchanged = await refreshWorkspaceSkillAnchors(
      database,
      WORKSPACE,
      anchorSource({
        digests: {
          [at(RELEASE_PATH, RELEASE_COMMIT)]: '1'.repeat(40),
          [at(RELEASE_PATH, 'main')]: '1'.repeat(40),
        },
      }),
      new Date(Date.now() + INSTITUTIONAL_SKILL_ANCHOR_RECHECK_MS + 1),
    );
    expect(unchanged).toMatchObject({ checked: 1, staled: 0, failed: 0 });
    expect((await skillState()).state).toBe('active');

    const moved = await refreshWorkspaceSkillAnchors(
      database,
      WORKSPACE,
      anchorSource({
        digests: {
          [at(RELEASE_PATH, RELEASE_COMMIT)]: '1'.repeat(40),
          [at(RELEASE_PATH, 'main')]: '2'.repeat(40),
        },
      }),
      new Date(Date.now() + 2 * INSTITUTIONAL_SKILL_ANCHOR_RECHECK_MS + 2),
    );
    expect(moved).toMatchObject({ checked: 1, staled: 1, failed: 0 });
    expect(await skillState()).toMatchObject({
      state: 'stale',
      anchor_stale_reason: 'the anchored file apps/server/src/release.ts changed on main',
    });
  });

  it('stales a procedure whose anchored file is gone from the current branch', async () => {
    await seedSkill({ path: 'apps/server/src/release.ts' });
    await database.query(
      `UPDATE workspace_skills SET code_content_hash=$2,anchor_checked_at=now()-interval '2 days'
       WHERE id=$1`,
      [SKILL, '1'.repeat(40)],
    );
    const result = await refreshWorkspaceSkillAnchors(
      database,
      WORKSPACE,
      anchorSource({
        digests: { [at(RELEASE_PATH, RELEASE_COMMIT)]: '1'.repeat(40) },
      }),
    );
    expect(result).toMatchObject({ checked: 1, staled: 1, failed: 0 });
    expect((await skillState()).anchor_stale_reason).toBe(
      'the anchored file apps/server/src/release.ts no longer exists on main',
    );
  });

  it('never stales an anchor whose own read failed, and never treats an unreadable repository as moved code', async () => {
    await seedSkill({ path: 'apps/server/src/release.ts' });
    await database.query(
      `UPDATE workspace_skills SET code_content_hash=$2,anchor_checked_at=now()-interval '2 days'
       WHERE id=$1`,
      [SKILL, '1'.repeat(40)],
    );
    const failed = await refreshWorkspaceSkillAnchors(
      database,
      WORKSPACE,
      anchorSource({ digests: {}, broken: [at(RELEASE_PATH, 'main')] }),
    );
    expect(failed).toMatchObject({ checked: 1, staled: 0, failed: 1 });
    const afterFailure = await skillState();
    expect(afterFailure.state).toBe('active');
    // The failed read leaves the row exactly as it was, so the next pass asks again.
    expect(afterFailure.anchor_checked_at!.getTime()).toBeLessThan(
      Date.now() - INSTITUTIONAL_SKILL_ANCHOR_RECHECK_MS / 2,
    );

    // Both the current branch and the anchored commit answer nothing: this
    // installation can no longer read the repository at all, which is a broken
    // read rather than evidence that the code moved.
    const unreadable = await refreshWorkspaceSkillAnchors(
      database,
      WORKSPACE,
      anchorSource({ digests: {} }),
      new Date(Date.now() + INSTITUTIONAL_SKILL_ANCHOR_RECHECK_MS),
    );
    expect(unreadable).toMatchObject({ checked: 1, staled: 0, failed: 1 });
    expect((await skillState()).state).toBe('active');
  });

  it('leaves an anchor it cannot corroborate squarely unverifiable', async () => {
    await seedSkill({ path: 'apps/server/src/release.ts' });
    const missing = await refreshWorkspaceSkillAnchors(
      database,
      WORKSPACE,
      anchorSource({ digests: {} }),
    );
    expect(missing).toMatchObject({ checked: 1, baselined: 0, unverifiable: 1, staled: 0 });
    expect(await skillState()).toMatchObject({ state: 'active', code_content_hash: null });

    // A repository-level anchor names no file: nothing to compare, nothing to contradict.
    await database.query(`UPDATE workspace_skills SET path=NULL WHERE id=$1`, [SKILL]);
    const noPath = await refreshWorkspaceSkillAnchors(
      database,
      WORKSPACE,
      anchorSource({ digests: {} }),
      new Date(Date.now() + 2 * INSTITUTIONAL_SKILL_ANCHOR_RECHECK_MS),
    );
    expect(noPath).toMatchObject({ checked: 1, unverifiable: 1, staled: 0 });
    expect((await skillState()).state).toBe('active');
  });

  it('skips a recently checked anchor, and does nothing at all without a GitHub source', async () => {
    await seedSkill({ path: 'apps/server/src/release.ts' });
    await database.query(`UPDATE workspace_skills SET anchor_checked_at=now() WHERE id=$1`, [
      SKILL,
    ]);
    const recent = await refreshWorkspaceSkillAnchors(
      database,
      WORKSPACE,
      anchorSource({
        digests: {
          [at(RELEASE_PATH, RELEASE_COMMIT)]: '1'.repeat(40),
          [at(RELEASE_PATH, 'main')]: '2'.repeat(40),
        },
      }),
    );
    expect(recent).toMatchObject({ checked: 0, staled: 0 });

    const unconfigured = await refreshWorkspaceSkillAnchors(database, WORKSPACE, undefined);
    expect(unconfigured).toMatchObject({ checked: 0 });
    expect((await skillState()).state).toBe('active');
  });
});
