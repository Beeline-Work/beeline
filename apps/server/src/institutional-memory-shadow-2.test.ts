import { describe, expect, it, migrateData, claimAgentCommand, createAgentCommand, WORKSPACE, ROOM, OTHER_ROOM, HUMAN, AGENT, OTHER_AGENT, OTHER_HUMAN, MESSAGE, database, liveDaemon, enrollLive, openTurn, closeTurn, rootFixture } from './test-support-institutional-memory-shadow.test-support.js';

describe('institutional memory phase-0 shadow capture', () => {

  it('saves and updates facts under distinct keys even when most words overlap', async () => {
    await enrollLive();
    const turn = await openTurn('duplicate-turn');
    const daemon = liveDaemon();
    const base = {
      ...turn,
      agentId: AGENT,
      memoryKind: 'workspace_fact',
      sourceMessageIds: [MESSAGE],
      personAsked: false,
      confidence: 0.9,
    } as const;
    const original = await daemon.execute(
      'saveInstitutionalMemory',
      {
        ...base,
        canonicalKey: 'deploy.marker',
        body: 'Release migrations write the schema marker last.',
        keywords: ['release', 'marker'],
      },
      AGENT,
    );
    const duplicate = {
      ...base,
      canonicalKey: 'deploy.marker-order',
      body: 'Release migrations write the schema marker first.',
      keywords: ['marker'],
    };
    await expect(daemon.execute('saveInstitutionalMemory', duplicate, AGENT))
      .resolves.toMatchObject({ version: 1 });
    expect((await rootFixture.database.query(
      `SELECT body FROM institutional_memory_items WHERE canonical_key='deploy.marker-order'`,
    )).rows).toEqual([{ body: duplicate.body }]);

    // A different fact that only shares a keyword is not a duplicate.
    await expect(
      daemon.execute(
        'saveInstitutionalMemory',
        {
          ...base,
          canonicalKey: 'deploy.marker-location',
          body: 'Marker files live under the ops directory.',
          keywords: ['marker'],
        },
        AGENT,
      ),
    ).resolves.toMatchObject({ version: 1 });
    // Exact item/version updates still work.
    await expect(
      daemon.execute(
        'updateInstitutionalMemory',
        {
          ...turn,
          agentId: AGENT,
          itemId: original.itemId,
          version: original.version,
          body: duplicate.body,
          keywords: ['release', 'marker'],
          sourceMessageIds: [MESSAGE],
          personAsked: false,
        },
        AGENT,
      ),
    ).resolves.toMatchObject({ version: 2 });
  });


  it('turns an old standing preference into an ordinary explicit fact that loads when relevant', async () => {
    await enrollLive();
    const text = 'Answer in short bullet points and skip the recap.';
    const current = '30000000-0000-4000-8000-0000000005a1';
    const previous = '30000000-0000-4000-8000-0000000005a2';
    const taken = '30000000-0000-4000-8000-0000000005a3';
    const otherStanding = '30000000-0000-4000-8000-0000000005a4';
    await rootFixture.database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Other') ON CONFLICT DO NOTHING`,
      [OTHER_HUMAN],
    );
    const insert = (
      id: string,
      subject: string,
      key: string,
      body: string,
      state: string,
      version: number,
      supersedes: string | null,
      keywords: string[],
    ) =>
      rootFixture.database.query(
        `INSERT INTO institutional_memory_items
           (id,workspace_id,kind,subject_identity_id,canonical_key,body,state,source_room_id,
            source_message_id,audience_kind,confidence,version,supersedes_id,keywords,deleted_at)
         VALUES($1,$2,'human_profile_fact',$3,$4,$5,$6,$7,$8,'human_profile',1,$9,$10,$11::text[],
           CASE WHEN $5='' THEN now() END)`,
        [id, WORKSPACE, subject, key, body, state, ROOM, MESSAGE, version, supersedes, keywords],
      );
    await insert(previous, HUMAN, 'standing', '', 'stale', 1, null, []);
    await insert(current, HUMAN, 'standing', text, 'active', 2, previous, []);
    // Another person already has an item under the new key, so theirs is suffixed.
    await insert(taken, OTHER_HUMAN, 'standing-preference', 'Prefers email.', 'active', 1, null, [
      'email',
    ]);
    await insert(otherStanding, OTHER_HUMAN, 'standing', 'Use metric units.', 'active', 1, null, []);

    await migrateData(rootFixture.database);
    await migrateData(rootFixture.database);

    const rows = (
      await rootFixture.database.query<{
        id: string;
        canonical_key: string;
        explicit_save: boolean;
        keywords: string[];
        state: string;
      }>(
        `SELECT id,canonical_key,explicit_save,keywords,state FROM institutional_memory_items
         WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [[current, previous, taken, otherStanding]],
      )
    ).rows;
    expect(rows).toEqual([
      {
        id: current,
        canonical_key: 'standing-preference',
        explicit_save: true,
        keywords: ['answer', 'short', 'bullet', 'points', 'skip', 'recap'],
        state: 'active',
      },
      {
        id: previous,
        canonical_key: 'standing-preference',
        explicit_save: true,
        keywords: [],
        state: 'stale',
      },
      {
        id: taken,
        canonical_key: 'standing-preference',
        explicit_save: false,
        keywords: ['email'],
        state: 'active',
      },
      {
        id: otherStanding,
        canonical_key: `standing-preference-${otherStanding.slice(0, 8)}`,
        explicit_save: true,
        keywords: ['metric', 'units'],
        state: 'active',
      },
    ]);

    // A request that touches it loads it like any other profile fact.
    const bulletMessage = '7'.repeat(64);
    await rootFixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Give me the bullet points.')`,
      [bulletMessage, ROOM, HUMAN],
    );
    const daemon = liveDaemon();
    const bulletTurn = await openTurn('standing-bullet', bulletMessage);
    const loaded = await daemon.execute('getInstitutionalContext', bulletTurn, AGENT);
    expect(loaded.itemIds).toEqual([current]);
    expect(loaded.text).toContain(text);
    expect(loaded).not.toHaveProperty('standingPreference');
    await closeTurn(bulletTurn);

    // One that does not, does not.
    const unrelated = await openTurn('standing-unrelated');
    const skipped = await daemon.execute('getInstitutionalContext', unrelated, AGENT);
    expect(skipped.itemIds).not.toContain(current);
    expect(skipped.text).not.toContain(text);

    // The old key cannot come back.
    const save = {
      ...unrelated,
      agentId: AGENT,
      memoryKind: 'human_profile_fact',
      canonicalKey: 'reply.style',
      body: 'Answer in one paragraph.',
      keywords: ['paragraph'],
      sourceMessageIds: [MESSAGE],
      personAsked: true,
      confidence: 1,
    } as const;
    await expect(
      daemon.execute('saveInstitutionalMemory', { ...save, canonicalKey: 'standing' }, AGENT),
    ).rejects.toThrow(/retired/);
  });


  it('keeps a standing version chain under one key when the plain key is taken', async () => {
    await enrollLive();
    const taken = '30000000-0000-4000-8000-0000000005b1';
    const first = 'a1000000-0000-4000-8000-0000000005b2';
    const second = 'b2000000-0000-4000-8000-0000000005b3';
    await rootFixture.database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Other') ON CONFLICT DO NOTHING`,
      [OTHER_HUMAN],
    );
    const vector = `[${Array.from({ length: 1024 }, () => '0.01').join(',')}]`;
    const insert = (
      id: string,
      key: string,
      body: string,
      state: string,
      version: number,
      supersedes: string | null,
    ) =>
      rootFixture.database.query(
        `INSERT INTO institutional_memory_items
           (id,workspace_id,kind,subject_identity_id,canonical_key,body,state,source_room_id,
            source_message_id,audience_kind,confidence,version,supersedes_id,keywords,
            embedding,embedding_model,embedded_at)
         VALUES($1,$2,'human_profile_fact',$3,$4,$5,$6,$7,$8,'human_profile',1,$9,$10,'{}',
           $11::vector,'voyageai/voyage-4-lite',now())`,
        [id, WORKSPACE, OTHER_HUMAN, key, body, state, ROOM, MESSAGE, version, supersedes, vector],
      );
    // The person already has an item under the plain key, and their standing
    // preference has two versions with a current embedding.
    await insert(taken, 'standing-preference', 'Prefers email.', 'active', 1, null);
    await insert(first, 'standing', 'Use imperial units.', 'stale', 1, null);
    await insert(second, 'standing', 'Use metric units.', 'active', 2, first);

    await migrateData(rootFixture.database);
    await migrateData(rootFixture.database);

    const rows = (
      await rootFixture.database.query<{
        id: string;
        canonical_key: string;
        supersedes_id: string | null;
        embedded: boolean;
        embedding_model: string | null;
      }>(
        `SELECT id,canonical_key,supersedes_id,embedding IS NOT NULL AS embedded,embedding_model
         FROM institutional_memory_items WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [[taken, first, second]],
      )
    ).rows;
    const chainKey = `standing-preference-${first.slice(0, 8)}`;
    expect(rows).toEqual([
      {
        id: taken,
        canonical_key: 'standing-preference',
        supersedes_id: null,
        embedded: true,
        embedding_model: 'voyageai/voyage-4-lite',
      },
      {
        id: first,
        canonical_key: chainKey,
        supersedes_id: null,
        embedded: false,
        embedding_model: null,
      },
      {
        id: second,
        canonical_key: chainKey,
        supersedes_id: first,
        embedded: false,
        embedding_model: null,
      },
    ]);
  });
});
describe('institutional memory authority for agent-started turns', () => {
  it('serves the per-turn snapshot for a turn started by a schedule or event wake, whose root message is agent-authored', async () => {
    await enrollLive();
    const humanTurn = await openTurn('human-write-turn');
    await liveDaemon().execute(
      'saveInstitutionalMemory',
      {
        ...humanTurn,
        agentId: AGENT,
        memoryKind: 'workspace_fact',
        canonicalKey: 'deploy.release-marker-last',
        body: 'The release migration writes its schema marker last.',
        keywords: ['release', 'migration', 'marker'],
        sourceMessageIds: [MESSAGE],
        personAsked: false,
        confidence: 0.95,
      },
      AGENT,
    );

    // A schedule, event, or workflow-handoff wake is authored by an agent,
    // not a human; the snapshot must still serve for that turn.
    const scheduleRoot = 'schedule-wake-root';
    await rootFixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'daily triage sweep: check the release migration marker')`,
      [scheduleRoot, ROOM, OTHER_AGENT],
    );
    const scheduleTurn = await openTurn('schedule-turn', scheduleRoot);
    const context = await liveDaemon().execute('getInstitutionalContext', scheduleTurn, AGENT);
    expect(context.text).toContain('schema marker last');
  });


  it('refuses the per-turn snapshot when the root message\'s Room is in another Workspace than the calling Room', async () => {
    await enrollLive();
    const crossRoot = 'cross-workspace-root';
    await rootFixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'unrelated other-workspace message')`,
      [crossRoot, OTHER_ROOM, OTHER_HUMAN],
    );
    const command = await createAgentCommand(rootFixture.database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: crossRoot,
      reason: 'test',
      turnRequestId: 'cross-workspace-turn',
    });
    await claimAgentCommand(rootFixture.database, ROOM, AGENT, command!.id, 'cross-workspace-generation');
    await expect(
      liveDaemon().execute(
        'getInstitutionalContext',
        { roomId: ROOM, requestId: 'cross-workspace-turn', generationId: 'cross-workspace-generation' },
        AGENT,
      ),
    ).rejects.toThrow(/requester authority is unavailable/);
  });
});
