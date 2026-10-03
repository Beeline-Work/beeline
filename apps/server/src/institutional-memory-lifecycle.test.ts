import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { claimAgentCommand, createAgentCommand } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { runInstitutionalCuratorCycle } from './institutional-curator.js';

// The agent-side memory lifecycle: the answering agent searches, saves,
// updates, deletes, and reports what it used. Only an agent's own Workspace
// fact expires, and only save, update, or a used report resets its age.

const WORKSPACE = '10000000-0000-4000-8000-00000000f001';
const ROOM = '20000000-0000-4000-8000-00000000f001';
const DM = '20000000-0000-4000-8000-00000000f002';
const HUMAN = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const MESSAGE = 'd'.repeat(64);
const DM_MESSAGE = 'e'.repeat(64);
const config = { enabled: true, live: true } as const;

let database: PgliteDatabase;
let turnCount = 0;
let openTurn: { agentId: string; roomId: string; requestId: string; generationId: string } | undefined;

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  turnCount = 0;
  openTurn = undefined;
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES ($1,'human','Human'),($2,'agent','Bee')`,
    [HUMAN, AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Memory')`, [WORKSPACE]);
  await database.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'host-1')`, [
    AGENT,
    HUMAN,
  ]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Shared')`, [
    ROOM,
    WORKSPACE,
  ]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name,direct_participants)
       VALUES($1,$2,'DM',jsonb_build_array($3::text,$4::text))`,
    [DM, WORKSPACE, HUMAN, AGENT],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
       ($1,$4,$2,'owner'),($1,$4,$3,'member'),($1,$5,$2,'owner'),($1,$5,$3,'member')`,
    [WORKSPACE, HUMAN, AGENT, ROOM, DM],
  );
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES
       ($1,$2,$3,'The staging deploy now runs from the release branch.'),
       ($4,$5,$3,'Please remember I review pull requests in the morning.')`,
    [MESSAGE, ROOM, HUMAN, DM_MESSAGE, DM],
  );
  await database.query(
    `INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage,availability_observed_at)
     VALUES($1,'live',now()) ON CONFLICT(workspace_id) DO UPDATE SET stage='live',
       availability_observed_at=now()`,
    [WORKSPACE],
  );
});

afterEach(async () => {
  await database.close();
});

function daemon(): DaemonService {
  return new DaemonService(
    database,
    new LiveHub(),
    undefined,
    undefined,
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    config,
  );
}

/**
 * One claimed agent turn answering a fresh request from the human. Returns its
 * daemon-call authority; `sources` cites that request, as every write must.
 */
async function turn(roomId = ROOM, text = 'Please keep memory current.') {
  // One agent answers one turn at a time: finish the previous one first.
  if (openTurn) {
    await daemon().execute('postAgentTurnReceipt', { ...openTurn, status: 'complete' }, AGENT);
  }
  turnCount += 1;
  const requestId = `turn-${turnCount}`;
  const generationId = `${requestId}-generation`;
  const sourceMessageId = `request-${turnCount}`;
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`,
    [sourceMessageId, roomId, HUMAN, text],
  );
  const command = await createAgentCommand(database, {
    roomId,
    agentId: AGENT,
    sourceMessageId,
    reason: 'human_tag',
    turnRequestId: requestId,
  });
  await claimAgentCommand(database, roomId, AGENT, command!.id, generationId);
  openTurn = { agentId: AGENT, roomId, requestId, generationId };
  return { authority: openTurn, sources: [sourceMessageId] };
}

let currentSources: string[] = [];
/** Open a turn and remember its sources for the call being built. */
async function current() {
  const { authority, sources } = await turn();
  currentSources = sources;
  return authority;
}

async function save(
  overrides: Partial<{
    canonicalKey: string;
    body: string;
    keywords: string[];
    personAsked: boolean;
    memoryKind: 'workspace_fact' | 'human_profile_fact';
  }> = {},
  roomId = ROOM,
) {
  const { authority, sources } = await turn(roomId);
  return daemon().execute(
    'saveInstitutionalMemory',
    {
      ...authority,
      memoryKind: 'workspace_fact',
      canonicalKey: 'deploy.staging-branch',
      body: 'Staging deploys run from the release branch.',
      keywords: ['staging', 'deploy', 'release'],
      sourceMessageIds: sources,
      personAsked: false,
      confidence: 0.9,
      ...overrides,
    },
    AGENT,
  );
}

async function itemRow(id: string) {
  return (
    await database.query<{
      state: string;
      body: string;
      version: number;
      explicit_save: boolean;
      deleted_at: Date | null;
      last_used_at: Date | null;
    }>(
      `SELECT state,body,version,explicit_save,deleted_at,last_used_at
       FROM institutional_memory_items WHERE id=$1`,
      [id],
    )
  ).rows[0]!;
}

/** Move every age anchor of one item `days` into the past. */
async function age(id: string, days: number): Promise<void> {
  await database.query(
    `UPDATE institutional_memory_items
     SET updated_at=updated_at-$2*interval '1 day',
         created_at=created_at-$2*interval '1 day',
         last_used_at=last_used_at-$2*interval '1 day'
     WHERE id=$1`,
    [id, days],
  );
}

describe('Reproduction R1: no hidden memory review', () => {
  it('a completed turn queues no review job and no host can claim one', async () => {
    await save();
    // Finishing the saving turn is the path that used to queue a turn_review job.
    await turn();
    await daemon().execute('postAgentTurnReceipt', { ...openTurn!, status: 'complete' }, AGENT);
    openTurn = undefined;
    const jobs = (await database.query(`SELECT trigger_kind FROM institutional_memory_jobs`)).rows;
    console.log('R1 queued jobs after turn:', JSON.stringify(jobs));
    expect(jobs).toEqual([]);
    await expect(
      daemon().execute('claimInstitutionalMemoryJob' as never, { agentId: AGENT } as never, AGENT),
    ).rejects.toThrow();
  });
});

describe('agent memory tools at the server boundary', () => {
  it('saves an agent fact as expirable and a person-asked fact as a standing order', async () => {
    const own = await save();
    const kept = await save({
      canonicalKey: 'review.morning',
      body: 'Pull requests get reviewed in the morning.',
      keywords: ['morning', 'review'],
      personAsked: true,
    });
    expect(own.version).toBe(1);
    expect((await itemRow(own.itemId)).explicit_save).toBe(false);
    expect((await itemRow(kept.itemId)).explicit_save).toBe(true);
    const search = await daemon().execute(
      'searchInstitutionalMemory',
      { ...(await current()), query: 'morning review staging' },
      AGENT,
    );
    expect(
      Object.fromEntries(search.results.map((result) => [result.id, result.standingOrder])),
    ).toEqual({ [own.itemId]: false, [kept.itemId]: true });
  });

  it('refuses a second save under an existing key and names the item to update', async () => {
    const first = await save();
    await expect(save({ body: 'Staging deploys always run from release.' })).rejects.toThrow(
      `already has item ${first.itemId}`,
    );
  });

  it('updates in place at the current version, deleting the old text at once', async () => {
    const first = await save();
    const updated = await daemon().execute(
      'updateInstitutionalMemory',
      {
        ...(await current()),
        itemId: first.itemId,
        version: 1,
        body: 'Staging deploys run from the main branch.',
        sourceMessageIds: currentSources,
        personAsked: false,
      },
      AGENT,
    );
    expect(updated.version).toBe(2);
    expect(await itemRow(first.itemId)).toMatchObject({ state: 'stale', body: '' });
    expect((await itemRow(first.itemId)).deleted_at).not.toBeNull();
    expect(await itemRow(updated.itemId)).toMatchObject({
      state: 'active',
      body: 'Staging deploys run from the main branch.',
      version: 2,
      explicit_save: false,
    });
  });

  it('refuses update and delete at a stale version', async () => {
    const first = await save();
    await expect(
      daemon().execute(
        'updateInstitutionalMemory',
        {
          ...(await current()),
          itemId: first.itemId,
          version: 2,
          body: 'Staging deploys run from the main branch.',
          sourceMessageIds: currentSources,
          personAsked: false,
        },
        AGENT,
      ),
    ).rejects.toThrow('is at version 1');
    await expect(
      daemon().execute(
        'deleteInstitutionalMemory',
        {
          ...(await current()),
          itemId: first.itemId,
          version: 3,
          reason: 'obsolete',
          sourceMessageIds: currentSources,
          personAsked: false,
        },
        AGENT,
      ),
    ).rejects.toThrow('is at version 1');
    expect(await itemRow(first.itemId)).toMatchObject({ state: 'active', version: 1 });
  });

  it('requires item id, version, and source messages for update and delete', async () => {
    const first = await save();
    await expect(
      daemon().execute(
        'deleteInstitutionalMemory',
        {
          ...(await current()),
          itemId: first.itemId,
          version: 1,
          reason: 'obsolete',
          sourceMessageIds: [],
          personAsked: false,
        },
        AGENT,
      ),
    ).rejects.toThrow('source messages are invalid');
    await expect(
      daemon().execute(
        'deleteInstitutionalMemory',
        {
          ...(await current()),
          itemId: 'not-an-item',
          version: 1,
          reason: 'obsolete',
          sourceMessageIds: currentSources,
          personAsked: false,
        },
        AGENT,
      ),
    ).rejects.toThrow('item id is invalid');
  });

  it('deletes an agent fact, but a standing order only on a person instruction', async () => {
    const own = await save();
    const kept = await save({
      canonicalKey: 'review.morning',
      body: 'Pull requests get reviewed in the morning.',
      keywords: ['morning', 'review'],
      personAsked: true,
    });
    const remove = async (itemId: string, personAsked: boolean) =>
      daemon().execute(
        'deleteInstitutionalMemory',
        {
          ...(await current()),
          itemId,
          version: 1,
          reason: 'wrong',
          sourceMessageIds: currentSources,
          personAsked,
        },
        AGENT,
      );
    await remove(own.itemId, false);
    expect(await itemRow(own.itemId)).toMatchObject({ state: 'stale', body: '' });
    await expect(remove(kept.itemId, false)).rejects.toThrow('standing order');
    expect(await itemRow(kept.itemId)).toMatchObject({ state: 'active' });
    await remove(kept.itemId, true);
    expect(await itemRow(kept.itemId)).toMatchObject({ state: 'stale', body: '' });
  });

  it('updates a standing order only as a person correction, and it stays a standing order', async () => {
    const kept = await save({
      canonicalKey: 'review.morning',
      body: 'Pull requests get reviewed in the morning.',
      keywords: ['morning', 'review'],
      personAsked: true,
    });
    const update = async (personAsked: boolean) =>
      daemon().execute(
        'updateInstitutionalMemory',
        {
          ...(await current()),
          itemId: kept.itemId,
          version: 1,
          body: 'Pull requests get reviewed in the afternoon.',
          sourceMessageIds: currentSources,
          personAsked,
        },
        AGENT,
      );
    await expect(update(false)).rejects.toThrow('standing order');
    const corrected = await update(true);
    expect(await itemRow(corrected.itemId)).toMatchObject({
      state: 'active',
      version: 2,
      explicit_save: true,
    });
  });
});

describe('memory expiry by kind and by real use', () => {
  async function curate(): Promise<void> {
    // A fresh cycle key each run: the weekly pass is idempotent per week.
    await database.query(`DELETE FROM institutional_curator_cycles`);
    await runInstitutionalCuratorCycle(database, config, new Date());
  }

  it('expires an unused agent Workspace fact and never a profile fact or standing order', async () => {
    const own = await save();
    const kept = await save({
      canonicalKey: 'review.morning',
      body: 'Pull requests get reviewed in the morning.',
      keywords: ['morning', 'review'],
      personAsked: true,
    });
    const profile = await save(
      {
        memoryKind: 'human_profile_fact',
        canonicalKey: 'review.habit',
        body: 'Reviews pull requests before noon.',
        keywords: ['noon', 'pulls'],
      },
      DM,
    );
    expect((await itemRow(profile.itemId)).explicit_save).toBe(false);
    for (const id of [own.itemId, kept.itemId, profile.itemId]) await age(id, 400);
    await curate();
    expect((await itemRow(own.itemId)).state).toBe('stale');
    expect((await itemRow(own.itemId)).body).toBe('');
    expect((await itemRow(kept.itemId)).state).toBe('active');
    expect((await itemRow(profile.itemId)).state).toBe('active');
  });

  it('a snapshot load or a search result does not reset age; a used report does', async () => {
    const loaded = await save();
    const used = await save({
      canonicalKey: 'deploy.release-window',
      body: 'Release windows open on Tuesdays.',
      keywords: ['tuesday', 'window'],
    });
    await age(loaded.itemId, 91);
    await age(used.itemId, 91);

    // Turn one: the snapshot loads the deploy fact, search returns both, and
    // the answer reports only the release window as used.
    const { authority } = await turn(ROOM, 'How does the staging deploy work?');
    const snapshot = await daemon().execute(
      'getInstitutionalContext',
      { roomId: ROOM, requestId: authority.requestId, generationId: authority.generationId },
      AGENT,
    );
    expect(snapshot.itemIds).toContain(loaded.itemId);
    expect(snapshot.text).toContain('- [1] ');
    const search = await daemon().execute(
      'searchInstitutionalMemory',
      { ...authority, query: 'staging deploy release tuesday window' },
      AGENT,
    );
    expect(search.results.map((result) => result.id).sort()).toEqual(
      [loaded.itemId, used.itemId].sort(),
    );
    expect((await itemRow(loaded.itemId)).last_used_at).toBeNull();
    const report = await daemon().execute(
      'reportInstitutionalMemoryUsed',
      { ...authority, itemIds: [used.itemId] },
      AGENT,
    );
    expect(report.refreshed).toBe(1);
    expect((await itemRow(used.itemId)).last_used_at).not.toBeNull();

    await curate();
    expect((await itemRow(loaded.itemId)).state).toBe('stale');
    expect((await itemRow(used.itemId)).state).toBe('active');
  });

  it('resolves a used report of snapshot line numbers to the items that turn was served', async () => {
    const fact = await save();
    await age(fact.itemId, 91);
    const { authority } = await turn(ROOM, 'How does the staging deploy work?');
    const snapshot = await daemon().execute(
      'getInstitutionalContext',
      { roomId: ROOM, requestId: authority.requestId, generationId: authority.generationId },
      AGENT,
    );
    expect(snapshot.itemIds).toEqual([fact.itemId]);
    expect(snapshot.text).toContain(`- [1] ${'Staging deploys run from the release branch.'}`);
    const report = await daemon().execute(
      'reportInstitutionalMemoryUsed',
      { ...authority, snapshotItems: [1, 7] },
      AGENT,
    );
    expect(report.refreshed).toBe(1);
    await curate();
    expect((await itemRow(fact.itemId)).state).toBe('active');
  });

  it('an update resets age as a new version', async () => {
    const first = await save();
    await age(first.itemId, 91);
    const updated = await daemon().execute(
      'updateInstitutionalMemory',
      {
        ...(await current()),
        itemId: first.itemId,
        version: 1,
        body: 'Staging deploys run from the main branch.',
        sourceMessageIds: currentSources,
        personAsked: false,
      },
      AGENT,
    );
    await curate();
    expect((await itemRow(updated.itemId)).state).toBe('active');
  });

  it('expires nothing inside the window', async () => {
    const own = await save();
    await age(own.itemId, 89);
    await curate();
    expect((await itemRow(own.itemId)).state).toBe('active');
  });
});
