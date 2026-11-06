import { describe, expect, it, INSTITUTIONAL_CONTEXT_HEADER, tombstoneInstitutionalMemoryForMessage, claimAgentCommand, createAgentCommand, WORKSPACE, OTHER_WORKSPACE, ROOM, DM, OTHER_ROOM, HUMAN, AGENT, OTHER_AGENT, OTHER_HUMAN, MESSAGE, DM_MESSAGE, database, liveDaemon, enrollLive, openTurn, closeTurn, rootFixture } from './test-support-institutional-memory-shadow.test-support.js';

describe('institutional memory phase-0 shadow capture', () => {
  it('keeps DM facts out of shared memory but accepts the requester profile exception', async () => {
    await enrollLive();
    const turn = await openTurn('dm-request', DM_MESSAGE, AGENT, DM);
    const base = {
      ...turn,
      agentId: AGENT,
      canonicalKey: 'deploy.release-marker-last',
      body: 'The release migration writes its schema marker last.',
      keywords: ['release', 'migration', 'marker'],
      sourceMessageIds: [DM_MESSAGE],
      personAsked: false,
      confidence: 0.95,
    } as const;
    await expect(
      liveDaemon().execute(
        'saveInstitutionalMemory',
        { ...base, memoryKind: 'workspace_fact' },
        AGENT,
      ),
    ).rejects.toThrow(/direct-message facts/);

    const profile = await liveDaemon().execute(
      'saveInstitutionalMemory',
      { ...base, memoryKind: 'human_profile_fact' },
      AGENT,
    );
    expect(
      (
        await rootFixture.database.query<{ subject_identity_id: string; kind: string; audience_kind: string }>(
          `SELECT subject_identity_id,kind,audience_kind FROM institutional_memory_items`,
        )
      ).rows,
    ).toEqual([
      { subject_identity_id: HUMAN, kind: 'human_profile_fact', audience_kind: 'human_profile' },
    ]);
    expect(profile.version).toBe(1);
  });


  it('rejects credential material from memory saves', async () => {
    await enrollLive();
    const turn = await openTurn('credential-save');
    await expect(
      liveDaemon().execute(
        'saveInstitutionalMemory',
        {
          ...turn,
          agentId: AGENT,
          memoryKind: 'workspace_fact',
          canonicalKey: 'deploy.release-marker-last',
          body: 'Use api_key=super-secret-value in production.',
          keywords: ['release', 'migration', 'marker'],
          sourceMessageIds: [MESSAGE],
          personAsked: false,
          confidence: 0.95,
        },
        AGENT,
      ),
    ).rejects.toThrow(/credential material/);
    expect((await rootFixture.database.query(`SELECT 1 FROM institutional_memory_items`)).rowCount).toBe(0);
  });


  it('compounds a correction across agents for its requester while shared facts reach everyone', async () => {
    await enrollLive();
    await enrollLive(OTHER_WORKSPACE);
    const profileTurn = await openTurn('profile-save', DM_MESSAGE, AGENT, DM);
    await liveDaemon().execute(
      'saveInstitutionalMemory',
      {
        ...profileTurn,
        agentId: AGENT,
        memoryKind: 'human_profile_fact',
        canonicalKey: 'workflow.mock-first',
        body: 'Show a mock before implementation begins.',
        keywords: ['mock', 'build', 'implementation'],
        sourceMessageIds: [DM_MESSAGE],
        personAsked: true,
        confidence: 0.95,
      },
      AGENT,
    );
    await closeTurn(profileTurn);

    const factTurn = await openTurn('fact-save');
    await liveDaemon().execute(
      'saveInstitutionalMemory',
      {
        ...factTurn,
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
    await closeTurn(factTurn);

    const nextHumanMessage = '1'.repeat(64);
    const otherHumanMessage = '2'.repeat(64);
    await rootFixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES
         ($1,$3,$4,'Build the next settings flow and its release with the normal process.'),
         ($2,$3,$5,'Explain how release migrations finish before implementation.')`,
      [nextHumanMessage, otherHumanMessage, ROOM, HUMAN, OTHER_HUMAN],
    );
    const humanCommand = await createAgentCommand(rootFixture.database, {
      roomId: ROOM,
      agentId: OTHER_AGENT,
      sourceMessageId: nextHumanMessage,
      reason: 'human_tag',
      turnRequestId: 'next-human-turn',
    });
    await claimAgentCommand(rootFixture.database, ROOM, OTHER_AGENT, humanCommand!.id, 'generation-human');
    const humanContext = await liveDaemon().execute(
      'getInstitutionalContext',
      {
        roomId: ROOM,
        requestId: 'next-human-turn',
        generationId: 'generation-human',
      },
      OTHER_AGENT,
    );
    expect(humanContext.text).toMatch(/\n- \[[12]\] Show a mock before implementation begins\./);
    expect(humanContext.text).toMatch(
      /\n- \[[12]\] The release migration writes its schema marker last\./,
    );
    expect(humanContext.totalBytes).toBeLessThanOrEqual(1_000);
    await liveDaemon().execute(
      'postAgentTurnReceipt',
      {
        roomId: ROOM,
        agentId: OTHER_AGENT,
        requestId: 'next-human-turn',
        generationId: 'generation-human',
        status: 'complete',
      },
      OTHER_AGENT,
    );

    const otherCommand = await createAgentCommand(rootFixture.database, {
      roomId: ROOM,
      agentId: OTHER_AGENT,
      sourceMessageId: otherHumanMessage,
      reason: 'human_tag',
      turnRequestId: 'other-human-turn',
    });
    await claimAgentCommand(rootFixture.database, ROOM, OTHER_AGENT, otherCommand!.id, 'generation-other');
    const otherContext = await liveDaemon().execute(
      'getInstitutionalContext',
      {
        roomId: ROOM,
        requestId: 'other-human-turn',
        generationId: 'generation-other',
      },
      OTHER_AGENT,
    );
    expect(otherContext.text).not.toContain('mock before implementation');
    expect(otherContext.text).toContain('schema marker last');

    const unauthorizedMessage = '3'.repeat(64);
    await rootFixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Explain the release marker.')`,
      [unauthorizedMessage, OTHER_ROOM, OTHER_HUMAN],
    );
    const unauthorizedCommand = await createAgentCommand(rootFixture.database, {
      roomId: OTHER_ROOM,
      agentId: OTHER_AGENT,
      sourceMessageId: unauthorizedMessage,
      reason: 'human_tag',
      turnRequestId: 'unauthorized-turn',
    });
    await claimAgentCommand(
      rootFixture.database,
      OTHER_ROOM,
      OTHER_AGENT,
      unauthorizedCommand!.id,
      'generation-unauthorized',
    );
    const unauthorizedContext = await liveDaemon().execute(
      'getInstitutionalContext',
      {
        roomId: OTHER_ROOM,
        requestId: 'unauthorized-turn',
        generationId: 'generation-unauthorized',
      },
      OTHER_AGENT,
    );
    expect(unauthorizedContext.text).toBe('');
    expect(
      (await rootFixture.database.query(`SELECT 1 FROM institutional_context_serves WHERE mode='live'`))
        .rowCount,
    ).toBe(3);
  });


  it('binds memory writes to the active command and enforces the item version', async () => {
    await enrollLive();
    const command = await createAgentCommand(rootFixture.database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: MESSAGE,
      reason: 'human_tag',
      turnRequestId: 'proposal-turn',
    });
    await claimAgentCommand(rootFixture.database, ROOM, AGENT, command!.id, 'proposal-generation');
    const daemon = liveDaemon();
    const turn = {
      agentId: AGENT,
      roomId: ROOM,
      requestId: 'proposal-turn',
      generationId: 'proposal-generation',
    } as const;
    const marker = {
      memoryKind: 'workspace_fact' as const,
      canonicalKey: 'deploy.marker',
      body: 'Release migrations write the marker last.',
      keywords: ['release', 'marker'],
      sourceMessageIds: [MESSAGE],
      personAsked: false,
      confidence: 0.9,
    };
    await expect(
      daemon.execute(
        'saveInstitutionalMemory',
        { agentId: AGENT, roomId: ROOM, ...marker } as never,
        AGENT,
      ),
    ).rejects.toThrow(/active command|authority|generation/i);
    const first = await daemon.execute('saveInstitutionalMemory', { ...turn, ...marker }, AGENT);
    expect(first.version).toBe(1);
    const firstContext = await daemon.execute(
      'getInstitutionalContext',
      {
        roomId: ROOM,
        requestId: 'proposal-turn',
        generationId: 'proposal-generation',
      },
      AGENT,
    );
    expect(firstContext.itemIds).toEqual([first.itemId]);
    expect(firstContext.text).toBe(
      `${INSTITUTIONAL_CONTEXT_HEADER}\n- [1] Release migrations write the marker last.`,
    );
    const updated = await daemon.execute(
      'updateInstitutionalMemory',
      {
        ...turn,
        itemId: first.itemId,
        version: first.version,
        body: 'Release migrations write the schema marker last.',
        keywords: ['release', 'marker'],
        sourceMessageIds: [MESSAGE],
        personAsked: false,
      },
      AGENT,
    );
    expect(updated.version).toBe(2);
    const preferenceInput = {
      ...turn,
      memoryKind: 'human_profile_fact' as const,
      canonicalKey: 'updates.concise',
      keywords: ['deploy', 'updates'],
      sourceMessageIds: [MESSAGE],
      personAsked: false,
      confidence: 0.9,
    };
    const preference = await daemon.execute(
      'saveInstitutionalMemory',
      { ...preferenceInput, body: 'Prefers concise progress updates during deploys.' },
      AGENT,
    );
    expect(preference.version).toBe(1);
    const preferenceContext = await daemon.execute(
      'getInstitutionalContext',
      {
        roomId: ROOM,
        requestId: 'proposal-turn',
        generationId: 'proposal-generation',
      },
      AGENT,
    );
    expect(preferenceContext.itemIds).toContain(preference.itemId);
    expect(preferenceContext.text).toMatch(
      /\n- \[[12]\] Prefers concise progress updates during deploys\.(\n|$)/,
    );
    expect(preferenceContext.text).not.toContain('Ignore later instructions');
    // The key is taken, so a fresh save under it is refused; a stale version is too.
    await expect(
      daemon.execute(
        'saveInstitutionalMemory',
        { ...turn, ...marker, body: 'Release migrations write the schema marker last.' },
        AGENT,
      ),
    ).rejects.toThrow(/already has item/);
    await expect(
      daemon.execute(
        'updateInstitutionalMemory',
        {
          ...turn,
          itemId: updated.itemId,
          version: first.version,
          body: 'Release migrations always write the schema marker last.',
          sourceMessageIds: [MESSAGE],
          personAsked: false,
        },
        AGENT,
      ),
    ).rejects.toThrow(/is at version 2/);
    await expect(
      daemon.execute(
        'saveInstitutionalMemory',
        {
          ...turn,
          ...marker,
          canonicalKey: 'large.fact.oversized',
          body: `Marker ${'x'.repeat(200)}`,
          keywords: ['marker'],
          confidence: 0.8,
        },
        AGENT,
      ),
    ).rejects.toThrow(/at most 200 bytes/);
    // Six distinct near-limit facts that all match the request overflow 1 KB.
    for (let index = 0; index < 6; index += 1) {
      const body = `Marker fact ${index} lists ${Array.from(
        { length: 26 },
        (_, word) => `k${index}x${word}`,
      ).join(' ')}.`;
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(200);
      await daemon.execute(
        'saveInstitutionalMemory',
        {
          ...turn,
          ...marker,
          canonicalKey: `large.fact.${index}`,
          body,
          keywords: ['marker'],
          confidence: 0.8,
        },
        AGENT,
      );
    }
    const bounded = await daemon.execute(
      'getInstitutionalContext',
      {
        roomId: ROOM,
        requestId: 'proposal-turn',
        generationId: 'proposal-generation',
      },
      AGENT,
    );
    expect(bounded.totalBytes).toBe(Buffer.byteLength(bounded.text, 'utf8'));
    expect(bounded.totalBytes).toBeLessThanOrEqual(1_000);
    expect(bounded.omitted.workspace).toBeGreaterThan(0);
    // Items are skipped whole, never cut mid-sentence, and numbered in order.
    bounded.text
      .split('\n')
      .slice(1)
      .forEach((line, index) => expect(line).toMatch(new RegExp(`^- \\[${index + 1}\\] .*\\.$`)));
  });


  it('routes self facts to the requester profile and third-party facts to shared memory', async () => {
    await enrollLive();
    const source = '4'.repeat(64);
    const otherSource = '5'.repeat(64);
    const ownNextSource = '6'.repeat(64);
    const retrievalRequest = 'Remind me of my access detail.';
    expect(retrievalRequest.toLowerCase()).not.toMatch(/alex|receives|packages|thursdays/);
    await rootFixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES
       ($1,$3,$4,'My delivery code is blue harbor; Alex receives packages on Thursdays.'),
       ($2,$3,$5,'What is the handoff schedule?'),
       ($6,$3,$4,$7)`,
      [source, otherSource, ROOM, HUMAN, OTHER_HUMAN, ownNextSource, retrievalRequest],
    );
    const first = await createAgentCommand(rootFixture.database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: source,
      reason: 'human_tag',
      turnRequestId: 'subject-first',
    });
    await claimAgentCommand(rootFixture.database, ROOM, AGENT, first!.id, 'subject-first-generation');
    const daemon = liveDaemon();
    const base = {
      agentId: AGENT,
      roomId: ROOM,
      requestId: 'subject-first',
      generationId: 'subject-first-generation',
      sourceMessageIds: [source],
      personAsked: false,
      confidence: 0.9,
    } as const;
    const self = await daemon.execute(
      'saveInstitutionalMemory',
      {
        ...base,
        memoryKind: 'human_profile_fact',
        canonicalKey: 'delivery.self-code',
        body: 'Their delivery code is blue harbor.',
        keywords: ['delivery', 'access', 'code'],
      },
      AGENT,
    );
    const thirdParty = await daemon.execute(
      'saveInstitutionalMemory',
      {
        ...base,
        memoryKind: 'workspace_fact',
        canonicalKey: 'delivery.alex-day',
        body: 'Alex receives packages on Thursdays.',
        keywords: ['alex', 'packages', 'handoff', 'schedule'],
      },
      AGENT,
    );
    const stored = (
      await rootFixture.database.query<{ id: string; kind: string; subject_identity_id: string | null }>(
        `SELECT id,kind,subject_identity_id FROM institutional_memory_items WHERE id=ANY($1::uuid[])`,
        [[self.itemId, thirdParty.itemId]],
      )
    ).rows;
    expect(stored).toContainEqual({
      id: self.itemId,
      kind: 'human_profile_fact',
      subject_identity_id: HUMAN,
    });
    expect(stored).toContainEqual({
      id: thirdParty.itemId,
      kind: 'workspace_fact',
      subject_identity_id: null,
    });
    await daemon.execute(
      'postAgentTurnReceipt',
      {
        roomId: ROOM,
        agentId: AGENT,
        requestId: 'subject-first',
        generationId: 'subject-first-generation',
        status: 'complete',
      },
      AGENT,
    );
    const next = await createAgentCommand(rootFixture.database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: otherSource,
      reason: 'human_tag',
      turnRequestId: 'subject-other',
    });
    await claimAgentCommand(rootFixture.database, ROOM, AGENT, next!.id, 'subject-other-generation');
    const otherContext = await daemon.execute(
      'getInstitutionalContext',
      {
        roomId: ROOM,
        requestId: 'subject-other',
        generationId: 'subject-other-generation',
      },
      AGENT,
    );
    expect(otherContext.text).toContain('Alex receives packages on Thursdays');
    expect(otherContext.text).not.toContain('blue harbor');
    const otherSearch = await daemon.execute(
      'searchInstitutionalMemory',
      {
        agentId: AGENT,
        roomId: ROOM,
        requestId: 'subject-other',
        generationId: 'subject-other-generation',
        query: 'delivery',
      },
      AGENT,
    );
    expect(otherSearch.results.map((item) => item.id)).toContain(thirdParty.itemId);
    expect(otherSearch.results.map((item) => item.id)).not.toContain(self.itemId);
    await daemon.execute(
      'postAgentTurnReceipt',
      {
        roomId: ROOM,
        agentId: AGENT,
        requestId: 'subject-other',
        generationId: 'subject-other-generation',
        status: 'complete',
      },
      AGENT,
    );
    const ownNext = await createAgentCommand(rootFixture.database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: ownNextSource,
      reason: 'human_tag',
      turnRequestId: 'subject-own-next',
    });
    await claimAgentCommand(rootFixture.database, ROOM, AGENT, ownNext!.id, 'subject-own-generation');
    const ownContext = await daemon.execute(
      'getInstitutionalContext',
      {
        roomId: ROOM,
        requestId: 'subject-own-next',
        generationId: 'subject-own-generation',
      },
      AGENT,
    );
    expect(ownContext.text).toContain('blue harbor');
    const ownSearch = await daemon.execute(
      'searchInstitutionalMemory',
      {
        agentId: AGENT,
        roomId: ROOM,
        requestId: 'subject-own-next',
        generationId: 'subject-own-generation',
        query: 'blue harbor',
      },
      AGENT,
    );
    expect(ownSearch.results.map((item) => item.id)).toContain(self.itemId);
    await rootFixture.database.query(
      `UPDATE institutional_memory_items SET updated_at=now()-interval '10 days' WHERE id=$1`,
      [thirdParty.itemId],
    );
    await rootFixture.database.query(
      `INSERT INTO institutional_memory_items
       (id,workspace_id,kind,canonical_key,body,source_room_id,source_message_id,
        audience_kind,confidence,version,created_by_command_id)
       SELECT md5('memory-filler-'||i::text)::uuid,$1,'workspace_fact',
         'filler.'||i::text,'unrelated filler '||i::text,$2,$3,'workspace',0.5,1,'fixture'
       FROM generate_series(1,510) AS i`,
      [WORKSPACE, ROOM, source],
    );
    const capped = await daemon.execute(
      'getInstitutionalContext',
      {
        roomId: ROOM,
        requestId: 'subject-own-next',
        generationId: 'subject-own-generation',
      },
      AGENT,
    );
    // Neither keyword-less filler nor an item whose keywords miss the request
    // loads, however much room is left.
    expect(capped.itemIds).toEqual([self.itemId]);
    // The agent's search phrase can find an active item absent from the frozen
    // snapshot even though the human request contains none of that item's keywords.
    const beyondSnapshot = await daemon.execute(
      'searchInstitutionalMemory',
      {
        agentId: AGENT,
        roomId: ROOM,
        requestId: 'subject-own-next',
        generationId: 'subject-own-generation',
        query: 'Alex receives packages',
      },
      AGENT,
    );
    expect(beyondSnapshot.results.map((item) => item.id)).toContain(thirdParty.itemId);
    await rootFixture.database.query(`UPDATE institutional_memory_items SET state='stale',body='',deleted_at=now() WHERE id=$1`, [
      thirdParty.itemId,
    ]);
    const archived = await daemon.execute(
      'searchInstitutionalMemory',
      {
        agentId: AGENT,
        roomId: ROOM,
        requestId: 'subject-own-next',
        generationId: 'subject-own-generation',
        query: 'Alex receives packages',
      },
      AGENT,
    );
    expect(archived.results).toEqual([]);
    await rootFixture.database.query(`UPDATE messages SET deleted_at=now() WHERE id=$1`, [source]);
    const deletedSource = await daemon.execute(
      'searchInstitutionalMemory',
      {
        agentId: AGENT,
        roomId: ROOM,
        requestId: 'subject-own-next',
        generationId: 'subject-own-generation',
        query: 'Alex receives packages',
      },
      AGENT,
    );
    expect(deletedSource.results).toEqual([]);
    await daemon.execute(
      'postAgentTurnReceipt',
      {
        roomId: ROOM,
        agentId: AGENT,
        requestId: 'subject-own-next',
        generationId: 'subject-own-generation',
        status: 'complete',
      },
      AGENT,
    );
    const dmCommand = await createAgentCommand(rootFixture.database, {
      roomId: DM,
      agentId: AGENT,
      sourceMessageId: DM_MESSAGE,
      reason: 'human_tag',
      turnRequestId: 'subject-dm',
    });
    await claimAgentCommand(rootFixture.database, DM, AGENT, dmCommand!.id, 'subject-dm-generation');
    await expect(
      daemon.execute(
        'saveInstitutionalMemory',
        {
          agentId: AGENT,
          roomId: DM,
          requestId: 'subject-dm',
          generationId: 'subject-dm-generation',
          memoryKind: 'workspace_fact',
          canonicalKey: 'delivery.private-third-party',
          body: 'Alex has a private delivery detail.',
          keywords: ['alex', 'delivery'],
          sourceMessageIds: [DM_MESSAGE],
          personAsked: false,
          confidence: 0.9,
        },
        AGENT,
      ),
    ).rejects.toThrow(/direct-message facts/);
  });


  it('tombstones item content and derived events when a source is deleted', async () => {
    await enrollLive();
    const secondarySource = '6'.repeat(64);
    await rootFixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text)
       VALUES($1,$2,$3,'The migration marker is the final write.')`,
      [secondarySource, ROOM, HUMAN],
    );
    const turn = await openTurn('delete-source');
    await liveDaemon().execute(
      'saveInstitutionalMemory',
      {
        ...turn,
        agentId: AGENT,
        memoryKind: 'workspace_fact',
        canonicalKey: 'deploy.release-marker-last',
        body: 'The release migration writes its schema marker last.',
        keywords: ['release', 'migration', 'marker'],
        sourceMessageIds: [MESSAGE, secondarySource],
        personAsked: false,
        confidence: 0.95,
      },
      AGENT,
    );
    // A legacy review job and the fact event it derived from the same source.
    const jobId = '50000000-0000-4000-8000-000000000001';
    await rootFixture.database.query(
      `INSERT INTO institutional_memory_jobs
         (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,source_request_id,
          requester_identity_id,source_audience_kind,idempotency_key,status,proposal)
       VALUES($1,$2,'turn_review','live',$3,$4,'delete-source',$5,'workspace_candidate',
         'legacy-delete-source','completed',$6::jsonb)`,
      [
        jobId,
        WORKSPACE,
        ROOM,
        MESSAGE,
        HUMAN,
        JSON.stringify({ source: { roomId: ROOM, messageIds: [MESSAGE, secondarySource] } }),
      ],
    );
    await rootFixture.database.query(
      `INSERT INTO institutional_memory_fact_events
         (id,workspace_id,job_id,source_room_id,source_message_id,canonical_key,body,
          classifier_version,confidence)
       VALUES($1,$2,$3,$4,$5,'deploy.release-marker-last',
         'The release migration writes its schema marker last.','legacy',0.95)`,
      ['50000000-0000-4000-8000-000000000002', WORKSPACE, jobId, ROOM, MESSAGE],
    );
    await rootFixture.database.transaction(async (db) => {
      await db.query(`UPDATE messages SET deleted_at=now(),text='' WHERE id=$1`, [secondarySource]);
      await tombstoneInstitutionalMemoryForMessage(db, secondarySource);
    });
    expect(
      (
        await rootFixture.database.query<{ state: string; body: string; deleted_at: Date | null }>(
          `SELECT state,body,deleted_at FROM institutional_memory_items`,
        )
      ).rows,
    ).toMatchObject([{ state: 'stale', body: '', deleted_at: expect.any(Date) }]);
    expect((await rootFixture.database.query(`SELECT 1 FROM institutional_memory_fact_events`)).rowCount).toBe(
      0,
    );
    expect(
      (
        await rootFixture.database.query<{ proposal: unknown; source_deleted_at: Date | null }>(
          `SELECT proposal,source_deleted_at FROM institutional_memory_jobs`,
        )
      ).rows[0],
    ).toMatchObject({ proposal: null, source_deleted_at: expect.any(Date) });
  });


  it('serves only items whose keywords match the request, inside 1,000 bytes', async () => {
    await enrollLive();
    const turn = await openTurn('keyword-turn');
    const daemon = liveDaemon();
    const base = {
      ...turn,
      agentId: AGENT,
      sourceMessageIds: [MESSAGE],
      personAsked: false,
      confidence: 0.9,
    } as const;
    // The request is "Remember that deploy writes the marker last."
    const matching = await daemon.execute(
      'saveInstitutionalMemory',
      {
        ...base,
        memoryKind: 'workspace_fact',
        canonicalKey: 'deploy.marker',
        body: 'Deploys write the schema marker last.',
        keywords: ['marker'],
      },
      AGENT,
    );
    const unrelatedFact = await daemon.execute(
      'saveInstitutionalMemory',
      {
        ...base,
        memoryKind: 'workspace_fact',
        canonicalKey: 'billing.invoice-day',
        body: 'Invoices go out on the first business day of the month.',
        keywords: ['billing', 'invoice', 'invoices'],
      },
      AGENT,
    );
    const unrelatedPreference = await daemon.execute(
      'saveInstitutionalMemory',
      {
        ...base,
        memoryKind: 'human_profile_fact',
        canonicalKey: 'screenshots.dark-mode',
        body: 'Prefers screenshots taken in dark mode.',
        keywords: ['screenshots', 'screenshot'],
      },
      AGENT,
    );
    await expect(
      daemon.execute(
        'saveInstitutionalMemory',
        {
          ...base,
          memoryKind: 'workspace_fact',
          canonicalKey: 'deploy.none',
          body: 'Deploys run nightly.',
          keywords: [],
        },
        AGENT,
      ),
    ).rejects.toThrow(/1 to 6 keywords/);
    await expect(
      daemon.execute(
        'saveInstitutionalMemory',
        {
          ...base,
          memoryKind: 'workspace_fact',
          canonicalKey: 'deploy.stop',
          body: 'Deploys run nightly.',
          keywords: ['the'],
        },
        AGENT,
      ),
    ).rejects.toThrow(/distinctive/);

    const context = await daemon.execute('getInstitutionalContext', turn, AGENT);
    expect(context.itemIds).toEqual([matching.itemId]);
    expect(context.itemIds).not.toContain(unrelatedFact.itemId);
    expect(context.itemIds).not.toContain(unrelatedPreference.itemId);
    expect(context.text).toBe(
      `${INSTITUTIONAL_CONTEXT_HEADER}\n- [1] Deploys write the schema marker last.`,
    );
    expect(context.text).not.toMatch(/Invoices|screenshots/);
    expect(context.totalBytes).toBe(Buffer.byteLength(context.text, 'utf8'));
    expect(context.totalBytes).toBeLessThanOrEqual(1_000);
    expect(
      (
        await rootFixture.database.query<{ item_ids: string[]; total_bytes: number }>(
          `SELECT item_ids,total_bytes FROM institutional_context_serves WHERE mode='live'`,
        )
      ).rows,
    ).toEqual([{ item_ids: [matching.itemId], total_bytes: context.totalBytes }]);
  });
});
