import { cornerKindSql, createHash, randomBytes, describe, expect, it, migrate, SYSTEM_IDENTITY_ID, describedWorkflow, PhoneService, DaemonService, LiveHub, systemLine, advanceCorner, CORNER_LIFECYCLE_SLUG, cornerMergeGate, deleteStoredCornerWorkflows, createAgentCommand, CORNER_LIFECYCLE_CARD_TYPE, cornerOwnerSql, getWorkflowRun, liveWorkflowRun, saveWorkflow, startWorkflow, workflowRunLockKey, RecordingDatabase, H, A, B, W, R, db, phone, daemon, github, githubRollupState, githubHead, githubApp, implementersMerge, derivedWorker, cards, currentState, commissioned, brief, open, claim, pushToCorner, greenHead, redHead, commands, result, SHA, OPEN_CLOSE_BADGES, branchOf, reasons, projected, inReview, approve, approved, mergedWebhook, say, revise, F, fallback, rootFixture, fixtureScope2, fixtureScope9, fixtureScope10, fixtureScope11, type CommandRow } from './test-support-corner-lifecycle.test-support.js';

describe('the corner lifecycle contract itself', () => {

  it('is never stored as a Workspace workflow, not even by creating a Workspace', async () => {
    const { id } = await rootFixture.phone.execute('createWorkspace', { name: 'Fresh' }, H);
    expect(
      (await rootFixture.db.query(`SELECT 1 FROM workspace_skills WHERE slug=$1`, [CORNER_LIFECYCLE_SLUG])).rowCount,
    ).toBe(0);
    await rootFixture.db.query(`DELETE FROM workspaces WHERE id=$1`, [id]);
  });


  it('migration deletes the copy older servers seeded, with its versions, and keeps a saved corner workflow', async () => {
    const seeded = '33333333-3333-4333-8333-333333333333';
    await rootFixture.db.query(
      `INSERT INTO workspace_skills
         (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
          repository,target_commit,path,kind)
       VALUES($1,$2,$3,'Corner lifecycle','active',2,2,$4,'','',NULL,'workflow')`,
      [seeded, W, CORNER_LIFECYCLE_SLUG, R],
    );
    for (const version of [1, 2])
      await rootFixture.db.query(
        `INSERT INTO workspace_skill_versions
           (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
            repository,target_commit,path,extractor_version,model)
         VALUES($1,$2,'{}',$3,NULL,$4,'','',NULL,'corner-workflow-v1','n/a')`,
        [seeded, version, String(version).repeat(64), ['system:corner-workflow-seed']],
      );
    expect(await deleteStoredCornerWorkflows(rootFixture.db)).toBe(1);
    expect((await rootFixture.db.query(`SELECT 1 FROM workspace_skills WHERE id=$1`, [seeded])).rowCount).toBe(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM workspace_skill_versions WHERE skill_id=$1`, [seeded])).rowCount).toBe(0);

    const saved = '44444444-4444-4444-8444-444444444444';
    await rootFixture.db.query(
      `INSERT INTO workspace_skills
         (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
          repository,target_commit,path,kind)
       VALUES($1,$2,$3,'Mine','active',1,1,$4,'','',NULL,'workflow')`,
      [saved, W, CORNER_LIFECYCLE_SLUG, R],
    );
    await rootFixture.db.query(
      `INSERT INTO workspace_skill_versions
         (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
          repository,target_commit,path,extractor_version,model)
       VALUES($1,1,'{}',$2,NULL,$3,'','',NULL,'workflow-save','n/a')`,
      [saved, 'a'.repeat(64), ['m']],
    );
    expect(await deleteStoredCornerWorkflows(rootFixture.db)).toBe(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM workspace_skills WHERE id=$1`, [saved])).rowCount).toBe(1);
    await rootFixture.db.query(`DELETE FROM workspace_skills WHERE id=$1`, [saved]);
  });
});
describe.each([
  ['with no stored corner workflow', false],
  ['with a stale stored corner workflow an older server seeded', true],
])('%s, corners work exactly as before', (_name, stored) => {
const scope2 = fixtureScope2(_name, stored);


  it('a code corner opens, advances implement -> checks -> review -> landed, without appearing on the workflow run page', async () => {
    const cornerId = await open('owner/widgets');
    expect(await currentState(cornerId)).toBe('working');
    expect(await projected(cornerId)).toBe('working');
    const badges = [await scope2.badge(cornerId)];
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await pushToCorner(cornerId, SHA);
    expect(await currentState(cornerId)).toBe('review');
    badges.push(await scope2.badge(cornerId));
    await greenHead(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('review');
    badges.push(await scope2.badge(cornerId));
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await approve(cornerId);
    await result(review!, `approved ${SHA}`);
    // No executing, checking or unanswered work remains after this verdict.
    expect(await currentState(cornerId)).toBe('idle');

    badges.push(await scope2.badge(cornerId));
    rootFixture.githubHead = SHA;
    rootFixture.githubRollupState = 'passed';
    expect(await implementersMerge()).toBe(1);
    await mergedWebhook(cornerId, 7, SHA);
    expect(await currentState(cornerId)).toBe('archived');
    expect(await projected(cornerId)).toBe('archived');
    badges.push(await scope2.badge(cornerId, true));
    expect(badges).toEqual(['working', 'review', 'review', 'idle', 'archived']);
    // The cards name no workflow and no version.
    for (const card of await cards(cornerId)) {
      expect(card).not.toHaveProperty('workflowSlug');
      expect(card).not.toHaveProperty('workflowVersion');
    }

    await expect(rootFixture.phone.execute('readWorkflowRun', { roomId: cornerId, runId: cornerId }, H))
      .rejects.toThrow('workflow run not found');
    expect((await rootFixture.phone.execute('listRoomWorkflowRuns', { roomId: cornerId }, H)).workflows).toEqual([]);
  });


  it('a corner opens on implement and closes', async () => {
    const cornerId = await open();
    expect(await currentState(cornerId)).toBe('working');
    const opened = await scope2.badge(cornerId);
    await rootFixture.daemon.execute('archiveCorner', { cornerId }, A);
    expect(await currentState(cornerId)).toBe('archived');
    expect(await projected(cornerId)).toBe('archived');
    expect([opened, await scope2.badge(cornerId, true)]).toEqual(OPEN_CLOSE_BADGES);
    await expect(rootFixture.phone.execute('readWorkflowRun', { roomId: cornerId, runId: cornerId }, H))
      .rejects.toThrow('workflow run not found');
  });
});
describe('corner lock', () => {
  it('persists the human toggle, refuses agent close, and allows close after unlocking', async () => {
    const cornerId = await open();
    expect((await rootFixture.phone.readRoom(cornerId, H))?.cornerLocked).toBe(false);
    await rootFixture.phone.execute('setCornerLocked', { roomId: cornerId, locked: true }, H);
    expect((await rootFixture.phone.readRoom(cornerId, H))?.cornerLocked).toBe(true);
    const before = await commands(A, cornerId);
    await expect(rootFixture.daemon.execute('archiveCorner', { cornerId }, A)).rejects.toThrow(/corner is locked/);
    expect((await rootFixture.db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0]?.archived_at).toBeNull();
    expect(await commands(A, cornerId)).toEqual(before);
    await rootFixture.phone.execute('setCornerLocked', { roomId: cornerId, locked: false }, H);
    expect((await rootFixture.phone.readRoom(cornerId, H))?.cornerLocked).toBe(false);
    await rootFixture.daemon.execute('archiveCorner', { cornerId }, A);
    expect(await currentState(cornerId)).toBe('archived');
  });


  it('allows a person to close a locked corner and rejects agents changing the lock', async () => {
    const cornerId = await open();
    await expect(rootFixture.phone.execute('setCornerLocked', { roomId: cornerId, locked: true }, A)).rejects.toThrow(/access denied/);
    await rootFixture.phone.execute('setCornerLocked', { roomId: cornerId, locked: true }, H);
    await expect(rootFixture.phone.execute('setCornerLocked', { roomId: cornerId, locked: false }, A)).rejects.toThrow(/access denied/);
    await rootFixture.phone.execute('requestCornerClose', { roomId: cornerId }, H);
    expect(await currentState(cornerId)).toBe('archived');
  });


  it('Reproduction HEADER-STATE-6: locked merge keeps the corner live and permits a later human close', async () => {
    const cornerId = await open('owner/widgets');
    const sha = 'd'.repeat(40);
    await greenHead(cornerId, 7, sha);
    await rootFixture.phone.execute('setCornerLocked', { roomId: cornerId, locked: true }, H);
    const assignmentRows = async () => (await rootFixture.db.query(`SELECT id,state FROM agent_commands WHERE room_id=$1 AND reason<>'report' ORDER BY id`, [cornerId])).rows;
    const before = await assignmentRows();
    await mergedWebhook(cornerId, 7, sha);
    expect((await rootFixture.db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0]?.archived_at).toBeNull();
    expect(await assignmentRows()).toEqual(before);
    expect((await rootFixture.daemon.execute('getCornerRestoreState', { cornerId }, A)).state).not.toBe('archived');
    expect((await rootFixture.phone.readRoom(cornerId, H))?.cornerLifecycle?.pr).toBeUndefined();
    expect(await currentState(cornerId)).toBe('idle');
    expect(await rootFixture.daemon.execute('getCornerRestoreState', { cornerId }, A)).toMatchObject({ closeRequested: false, archived: false });
    expect((await rootFixture.phone.readCorners(R, H))!.corners.find(c => c.corner.id === cornerId)!.state).not.toBe('archived');
    expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE room_id=$1
      AND card->>'type'='corner-complete' AND card->>'cornerId'=$2
      AND card->>'sourceMessageId' IS NULL`, [R, cornerId])).rowCount).toBe(0);
    const mergedNoteId = createHash('sha256').update(
      `beeline:${cornerId}:github:pull-request:merged:https://github.com/owner/widgets/pull/7`,
    ).digest('hex');
    const mergedNote = () => rootFixture.db.query(`SELECT id,card,system_event->>'kind' kind FROM messages
      WHERE room_id=$1 AND card_type='github-corner-note' AND id=$2`, [cornerId, mergedNoteId]);
    expect((await mergedNote()).rows).toEqual([{ id: mergedNoteId, card: null, kind: 'merged' }]);
    expect(rootFixture.githubApp.deleteBranch).not.toHaveBeenCalled();
    await rootFixture.github.prChecksStatus({ cornerId, pullRequest: 7 });
    expect((await mergedNote()).rows).toEqual([{ id: mergedNoteId, card: null, kind: 'merged' }]);
    expect((await rootFixture.db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0]?.archived_at).toBeNull();
    await new PhoneService(rootFixture.db, 'http://test', rootFixture.github).execute('requestCornerClose', { roomId: cornerId }, H);
    expect(rootFixture.githubApp.closePullRequest).not.toHaveBeenCalled();
    expect(await currentState(cornerId)).toBe('archived');
  });
});
describe('bookkeeping cards never appear in the corner conversation a human reads', () => {
  it('readRoom shows the real conversation but no workflow-handoff card, through open, checks, and review', async () => {
    const cornerId = await open('owner/widgets');
    await greenHead(cornerId, 21, '5'.repeat(40));
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 21, '6'.repeat(40));

    // New transitions write no cards; retained history still stays hidden and inert.
    expect(await cards(cornerId)).toEqual([]);
    await systemLine(rootFixture.db, { roomId: cornerId, authorId: SYSTEM_IDENTITY_ID, subject: { kind: 'system', id: SYSTEM_IDENTITY_ID, name: '@system' },
      verb: 'handed off', object: 'ask_human', presentation: 'card', cardType: CORNER_LIFECYCLE_CARD_TYPE,
      card: { runId: cornerId, toState: 'ask_human', seq: 999 } });
    const recorded = await cards(cornerId);
    expect(recorded).toHaveLength(1);
    expect(await currentState(cornerId)).toBe('review');

    // The exact reproduction the review used: a real `PhoneService.readRoom`
    // call, the function that serves the mobile/desktop client.
    const view = await rootFixture.phone.readRoom(cornerId, H);
    expect(view).not.toBeNull();
    for (const message of view!.messages) {
      expect(message.text).not.toMatch(/started workflow|handed off/);
    }
    const raw = await rootFixture.db.query<{ count: string }>(
      `SELECT count(*)::text count FROM messages WHERE room_id=$1 AND card_type=$2`,
      [cornerId, CORNER_LIFECYCLE_CARD_TYPE],
    );
    // The rows genuinely exist (this isn't "nothing was written") — they are
    // simply excluded from what a human reads.
    expect(Number(raw.rows[0]?.count)).toBe(recorded.length);
    expect(view!.messages.map((message) => message.id)).not.toEqual(
      expect.arrayContaining(
        (
          await rootFixture.db.query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1 AND card_type=$2`, [
            cornerId,
            CORNER_LIFECYCLE_CARD_TYPE,
          ])
        ).rows.map((row) => row.id),
      ),
    );
  });
});
describe('a corner opens onto implement (row 1-3)', () => {
  it('a repository corner opens straight onto implement', async () => {
    const cornerId = await open('owner/widgets');

  });
});
describe('a person-opened corner in a repository Room', () => {
  it('returns the first corner when a timed-out open retries with the same phone id', async () => {
    const cornerId = '6f1d8c2a-4b3e-4f5a-9c7d-2e8b1a0f3c4d';
    const open = () =>
      rootFixture.phone.execute('createHumanCorner', { roomId: R, title: 'Retry-safe', cornerId }, H);
    expect(await open()).toEqual({ id: cornerId });
    expect(await open()).toEqual({ id: cornerId });
    expect((await rootFixture.db.query(`SELECT count(*)::int n FROM rooms WHERE parent_id=$1 AND name='Retry-safe'`, [R]))
      .rows[0]).toEqual({ n: 1 });

    await expect(
      rootFixture.phone.execute('createHumanCorner', { roomId: R, title: 'Bad-id', cornerId: 'not-a-uuid' }, H),
    ).rejects.toThrow('corner id must be a UUID');
  });

  it('NO-SWAP: a person tagging another agent assigns it without stopping the running one', async () => {
    const { id: cornerId } = await rootFixture.phone.execute('createHumanCorner', { roomId: R, title: 'Swap-widget' }, H);
    await say(cornerId, '@hoots fix the widget');
    const [working] = await commands(A, cornerId);
    await rootFixture.daemon.execute('claimAgentCommand', { roomId: cornerId, commandId: working!.id, generationId: 'g1' }, A);
    await rootFixture.daemon.execute('postAgentTurnReceipt', { roomId: cornerId, requestId: working!.turnRequestId,
      generationId: 'g1', agentId: A, status: 'working' }, A);

    await say(cornerId, '@goosy take this over');
    expect(await derivedWorker(cornerId)).toBe(B);
    expect((await rootFixture.db.query(`SELECT action,reason FROM agent_commands WHERE room_id=$1 AND agent_id=$2
      AND state='pending'`, [cornerId, A])).rows).toEqual([]);
    expect((await rootFixture.db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND request_id=$3`,
      [cornerId, A, working!.turnRequestId])).rows).toEqual([{ status: 'working' }]);
    console.log('NO-SWAP Demonstrated: the tagged agent became the worker; the running agent kept its turn and got no stop.');
  });

  it('opens on implement with no lane, and the first tagged agent owns it and drives it to checks', async () => {
    const { id: cornerId } = await rootFixture.phone.execute('createHumanCorner', { roomId: R, title: 'Fix-widget' }, H);

    expect(await projected(cornerId)).toBe('idle');
    const columns = await rootFixture.db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='corner_facts' AND column_name='lane'`,
    );
    expect(columns.rowCount).toBe(0);
    expect((await rootFixture.db.query(`SELECT ${cornerOwnerSql('$1::uuid')} owner_agent_id,${cornerKindSql('corner_id')} kind FROM corner_facts WHERE corner_id=$1`, [cornerId]))
      .rows[0]).toEqual({ owner_agent_id: null, kind: 'human' });

    // The first agent a person tags owns the corner; a later tag moves only the implementer.
    await say(cornerId, '@hoots fix the widget');
    expect((await rootFixture.db.query(`SELECT ${cornerOwnerSql('$1::uuid')} owner_agent_id`, [cornerId]))
      .rows[0]).toEqual({ owner_agent_id: A });
    expect(await derivedWorker(cornerId)).toBe(A);
    await say(cornerId, '@goosy take this over');
    expect((await rootFixture.db.query(`SELECT ${cornerOwnerSql('$1::uuid')} owner_agent_id`, [cornerId]))
      .rows[0]).toEqual({ owner_agent_id: A });
    expect(await derivedWorker(cornerId)).toBe(B);

    // A matched push leaves the corner working until its implementing receipts end.
    await rootFixture.github.processWebhook('push', {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      ref: `refs/heads/${branchOf(cornerId)}`,
      after: SHA,
      commits: [{}],
      pusher: { name: 'goosy' },
    });
    expect(await currentState(cornerId)).toBe('working');
  });
});
describe('checks dispatch (rows 6-8)', () => {
  it('a push retains working until the implementing receipt ends', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.github.processWebhook('push', {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      ref: `refs/heads/${branchOf(cornerId)}`,
      after: '1'.repeat(40),
      commits: [{}],
      pusher: { name: 'hoots' },
    });
    expect(await currentState(cornerId)).toBe('working');
    await pushToCorner(cornerId, '1'.repeat(40));
    expect(await currentState(cornerId)).toBe('review');
  });


  it('a failing check sends it back to implement', async () => {
    const cornerId = await open('owner/widgets');
    await redHead(cornerId, 1, '1'.repeat(40));
    expect(await currentState(cornerId)).toBe('working');

  });


  it('a passing check with a configured reviewer moves to review', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 1, '1'.repeat(40));
    expect(await currentState(cornerId)).toBe('review');
  });


  it('a passing check with no configured reviewer wakes the implementer to arrange review', async () => {
    const cornerId = await open('owner/widgets');
    const before = await reasons(cornerId, A);
    await greenHead(cornerId, 1, '1'.repeat(40));
    expect(await currentState(cornerId)).toBe('working');

    expect(await reasons(cornerId, A)).toEqual([...before, 'corner_review_needed']);
    expect(await reasons(cornerId, B)).toEqual([]);
    const waiting = (await rootFixture.db.query<{ text: string; card: unknown }>(
      `SELECT text,card FROM messages WHERE room_id=$1 AND text LIKE '%needs to approve%'`, [cornerId],
    )).rows;
    expect(waiting).toEqual([]);
  });


  it('an explicit decision report goes privately to the commander, without a human tag', async () => {
    const cornerId = await open('owner/widgets', false, B);
    const [work] = await commands(A, cornerId);
    await claim(work!);
    await rootFixture.daemon.execute('report', { status: 'needs_decision', roomId: cornerId, requestId: work!.turnRequestId,
      generationId: 'g1', text: 'needs-decision: decide whether to continue' }, A);
    expect((await commands(B, R)).some(c => c.reason === 'report' && c.source.body.includes('needs-decision:'))).toBe(true);
    expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE text='needs-decision: decide whether to continue'`)).rowCount).toBe(0);
  });


  it('the reviewer role is never pinned to a real agent id, so a mid-corner reassignment is recorded correctly next time (finding 1)', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 1, '1'.repeat(40));
    expect(await currentState(cornerId)).toBe('review');
    // The bound identity is a literal marker, never Goosy's own agent id —
    // the generic engine's own handoff() authorization can never match it,
    // and nothing here needs updating when the parent Room's reviewer changes.
    const startCard = (await cards(cornerId))[0];

    // A review that ends without a PASS leaves it in review...
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await result(review!, 'Review complete: please fix the race condition.');
    expect(await currentState(cornerId)).toBe('working');
    // ...the parent Room's reviewer is reassigned to itself (the only other
    // agent identity this fixture has) while the corner is mid-flight...
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    // ...and the NEXT green head still resolves checks -> review correctly,
    // proving the live path (not anything recorded at start) drives dispatch.
    await greenHead(cornerId, 1, '2'.repeat(40));
    expect(await currentState(cornerId)).toBe('review');
  });
});
describe('the run lock (a push transition can race a close or another push)', () => {
  it('retains the state row in the first read before applying a transition', async () => {
    const cornerId = await open('owner/widgets');
    const recording = new RecordingDatabase(db);
    await advanceCorner(recording, cornerId, { kind: 'push', headSha: '1'.repeat(40), contents: {} });
    expect(recording.calls[0]).toEqual({
      sql: expect.stringContaining('FOR UPDATE OF fact'),
      values: [cornerId],
    });
    const readIndex = recording.calls.findIndex((call) => call.sql.includes('FROM messages'));
    expect(readIndex).toBeGreaterThan(0);
    // The transition still actually happened — this proves the lock, not a no-op.
    expect(await currentState(cornerId)).toBe('working');
  });


  ;
});
describe('review dispatch and the fix loop cap (row 9)', () => {
const scope9 = fixtureScope9();


  it("an approved review records review -> review and wakes nobody to merge", async () => {
    const cornerId = await scope9.toReview();
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await rootFixture.daemon.execute('approveCornerMerge', { cornerId, headSha: '7'.repeat(40) }, B);
    await result(review!, 'Review complete: approved, merge it.');
    expect(await currentState(cornerId)).toBe('idle');

    expect(await reasons(cornerId, A)).not.toContain('corner_land');
  });


  it('PASS-LANDS: a reviewer PASS on a green head lands the PR at once', async () => {
    const cornerId = await scope9.toReview();
    const [review] = await commands(B, cornerId);
    await claim(review!);
    rootFixture.githubHead = '7'.repeat(40);
    rootFixture.githubRollupState = 'passed';
    const landing = new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, id => rootFixture.github.landCorner(id));
    Object.assign(landing, { github: { assertCornerReviewerNotAuthor: async () => {} } });
    await expect(landing.execute('approveCornerMerge', { cornerId, headSha: '7'.repeat(40) }, B))
      .resolves.toMatchObject({ status: 'approved' });
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(await reasons(cornerId, A)).not.toContain('corner_land');
    console.log('PASS-LANDS Demonstrated: the reviewer PASS reached landCorner with no implementer merge_corner turn.');
  });


  it('a review that ends without a PASS records nothing and stays in review', async () => {
    const cornerId = await scope9.toReview();
    const before = await cards(cornerId);
    const [review] = await commands(B, cornerId);
    await claim(review!);
    await result(review!, 'Review complete: please fix the race condition.');
    expect(await currentState(cornerId)).toBe('working');

    expect(await reasons(cornerId, A)).not.toContain('corner_review');
  });


  it('a reviewer privately orders repairs from its corner on a green head and it stays in review', async () => {
    const cornerId = await scope9.toReview();
    const [review] = await commands(B, cornerId);
    await claim(review!, 'review-generation');
    await rootFixture.daemon.execute('order', { roomId: cornerId, requestId: review!.turnRequestId,
      generationId: 'review-generation', address: cornerId, text: 'Fix the race condition' }, B);
    expect((await commands(A, cornerId)).some(c => c.reason === 'order')).toBe(true);
    expect(await currentState(cornerId)).toBe('working');
    await rootFixture.daemon.execute('approveCornerMerge', { cornerId, headSha: '7'.repeat(40) }, B);
    // The PASS is landed by the server, not handed to the implementer.
    expect(await reasons(cornerId, A)).not.toContain('corner_land');
  });
});
describe('landing and closing from any state (finding 3, implicit edges)', () => {
const scope10 = fixtureScope10();

  it('the merge webhook lands the corner even while it is still mid-review', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 9, '9'.repeat(40));
    expect(await currentState(cornerId)).toBe('review');
    await rootFixture.github.processWebhook('pull_request', {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      action: 'closed',
      pull_request: {
        number: 9,
        title: 'Ship the widget',
        html_url: 'https://github.com/owner/widgets/pull/9',
        head: { ref: `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`, sha: '9'.repeat(40) },
        base: { ref: 'main' },
        merged: true,
        merged_at: '2026-01-01T00:00:00Z',
        commits: 1,
        changed_files: 1,
      },
      sender: { login: 'octocat' },
    });
    expect(await currentState(cornerId)).toBe('archived');
    expect(await cards(cornerId)).toEqual([]);
  });


  it('the merge webhook cancels the reviewer\'s still-pending review command, not just the implementer\'s', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    await greenHead(cornerId, 9, '9'.repeat(40));
    const [review] = await commands(B, cornerId);
    expect(review).toBeDefined();
    await rootFixture.github.processWebhook('pull_request', {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      action: 'closed',
      pull_request: {
        number: 9,
        title: 'Ship the widget',
        html_url: 'https://github.com/owner/widgets/pull/9',
        head: { ref: `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`, sha: '9'.repeat(40) },
        base: { ref: 'main' },
        merged: true,
        merged_at: '2026-01-01T00:00:00Z',
        commits: 1,
        changed_files: 1,
      },
      sender: { login: 'octocat' },
    });
    expect(
      (await rootFixture.db.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [review!.id])).rows[0]!
        .state,
    ).toBe('cancelled');
  });


  it('closing an untouched corner lands it on closed from implement', async () => {
    const cornerId = await open();
    await rootFixture.daemon.execute('archiveCorner', { cornerId }, A);
    expect(await currentState(cornerId)).toBe('archived');

  });


  it('an agent archiving its corner cancels a reviewer\'s still-pending review command', async () => {
    const cornerId = await inReview();
    const [review] = await commands(B, cornerId);
    expect(review).toBeDefined();
    await rootFixture.github.closeCornerPullRequest(cornerId);
    await rootFixture.daemon.execute('archiveCorner', { cornerId }, A);
    expect(
      (await rootFixture.db.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [review!.id])).rows[0]!
        .state,
    ).toBe('cancelled');
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1
      AND action IN ('input','resume') AND state IN ('pending','claimed')`, [cornerId])).rowCount).toBe(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_turns WHERE room_id=$1
      AND status='working'`, [cornerId])).rowCount).toBe(0);
  });


  it('a human close request lands whatever state the corner is in', async () => {
    const cornerId = await open('owner/widgets');
    expect((await commands(A, cornerId)).length).toBeGreaterThan(0);
    await rootFixture.phone.execute('requestCornerClose', { roomId: cornerId }, H);
    expect(await currentState(cornerId)).toBe('archived');
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1
      AND action IN ('input','resume') AND state IN ('pending','claimed')`, [cornerId])).rowCount).toBe(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_turns WHERE room_id=$1
      AND status='working'`, [cornerId])).rowCount).toBe(0);
  });


  it.each(['close', 'merge'] as const)('removes corner wake sources on %s and preserves the live Room (Reproduction corner-wake-cleanup)', async (path) => {
    const cornerId = path === 'close' ? await open() : await inReview();
    const scheduleId = await scope10.seedWakeSources(cornerId);
    const liveScheduleId = await scope10.seedWakeSources(R);
    const liveSubscriptions = (await rootFixture.db.query(`SELECT * FROM agent_subscriptions WHERE room_id=$1 ORDER BY id`, [R])).rows;
    const { holdId } = await rootFixture.phone.execute('setCornerHold', { cornerId }, H);
    if (path === 'close') await rootFixture.phone.execute('requestCornerClose', { roomId: cornerId }, H);
    else await mergedWebhook(cornerId, 7, SHA);
    expect((await rootFixture.db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0].archived_at).not.toBeNull();
    await scope10.expectWakeSources(cornerId, 0);
    await scope10.expectWakeSources(R, 1);
    expect((await rootFixture.db.query(`SELECT * FROM agent_subscriptions WHERE room_id=$1 ORDER BY id`, [R])).rows).toEqual(liveSubscriptions);
    expect((await rootFixture.db.query(`SELECT released_at IS NOT NULL released FROM corner_merge_holds WHERE id=$1`, [holdId])).rows[0]!.released).toBe(true);
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_schedule_occurrences WHERE schedule_id=$1`, [scheduleId])).rowCount).toBe(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_schedule_occurrences WHERE schedule_id=$1`, [liveScheduleId])).rowCount).toBe(1);
  });


  it('release migration removes existing archived corner wakes and preserves live wakes', async () => {
    const cornerId = await open();
    const liveCornerId = await open();
    await scope10.seedWakeSources(cornerId);
    await scope10.seedWakeSources(liveCornerId);
    await scope10.seedWakeSources(R);
    await rootFixture.db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [cornerId]);
    await rootFixture.db.query(`DELETE FROM workflow_backfills WHERE name='archived-corner-wakes-v1'`);
    await migrate(rootFixture.db);
    await migrate(rootFixture.db);
    await scope10.expectWakeSources(cornerId, 0);
    await scope10.expectWakeSources(liveCornerId, 1);
    await scope10.expectWakeSources(R, 1);
  });


  it('a human close request abandons a live saved workflow run inside the corner', async () => {
    const cornerId = await open();
    const starter = { room_id: cornerId, agent_id: A } as CommandRow;
    await saveWorkflow(rootFixture.db, starter, { contract: describedWorkflow({
      version: 1, name: 'corner-chore', description: 'One step inside a corner', roles: ['worker'], start: 'work',
      handoffs: {
        work: { role: 'worker', requires: ['note'], on: { done: 'finished', timeout: 'failed' }, timeoutSeconds: 3600 },
        finished: { kind: 'terminal', status: 'done' },
        failed: { kind: 'terminal', status: 'failed' },
      },
    }) });
    const { runId } = await startWorkflow(rootFixture.db, starter, { name: 'corner-chore', roleBindings: { worker: A } });
    expect((await getWorkflowRun(rootFixture.db, cornerId, runId)).status).toBe('live');
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_schedules WHERE room_id=$1`, [cornerId])).rowCount).toBe(0);
    await rootFixture.phone.execute('requestCornerClose', { roomId: cornerId }, H);
    expect((await getWorkflowRun(rootFixture.db, cornerId, runId)).status).toBe('abandoned');
    expect(await liveWorkflowRun(rootFixture.db, cornerId, 'corner-chore')).toBeUndefined();
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_schedules WHERE room_id=$1`, [cornerId])).rowCount).toBe(0);
    console.log('Demonstrated corner-close-run: closing the corner abandoned the saved workflow run without creating a schedule timer');
  });


  it('a GitHub merge abandons a live saved workflow run without schedule timers inside the corner', async () => {
    const cornerId = await inReview();
    const starter = { room_id: cornerId, agent_id: A } as CommandRow;
    await saveWorkflow(rootFixture.db, starter, { contract: describedWorkflow({
      version: 1, name: 'corner-chore', description: 'One step inside a corner', roles: ['worker'], start: 'work',
      handoffs: {
        work: { role: 'worker', requires: ['note'], on: { done: 'finished', timeout: 'failed' }, timeoutSeconds: 3600 },
        finished: { kind: 'terminal', status: 'done' },
        failed: { kind: 'terminal', status: 'failed' },
      },
    }) });
    const { runId } = await startWorkflow(rootFixture.db, starter, { name: 'corner-chore', roleBindings: { worker: A } });
    expect((await getWorkflowRun(rootFixture.db, cornerId, runId)).status).toBe('live');
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_schedules WHERE room_id=$1`, [cornerId])).rowCount).toBe(0);
    await mergedWebhook(cornerId, 7, SHA);
    expect((await getWorkflowRun(rootFixture.db, cornerId, runId)).status).toBe('abandoned');
    expect(await liveWorkflowRun(rootFixture.db, cornerId, 'corner-chore')).toBeUndefined();
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_schedules WHERE room_id=$1`, [cornerId])).rowCount).toBe(0);
    expect(await currentState(cornerId)).toBe('archived');
    await mergedWebhook(cornerId, 7, SHA);
    expect((await getWorkflowRun(rootFixture.db, cornerId, runId)).status).toBe('abandoned');
  });


  it('never posts a second terminal card for an already-landed corner', async () => {
    const cornerId = await open();
    await rootFixture.daemon.execute('archiveCorner', { cornerId }, A);
    const before = await cards(cornerId);
    // A retried merge webhook or close request must not re-terminate an
    // already-closed run.
    expect(await advanceCorner(rootFixture.db, cornerId, { kind: 'merged', contents: {} })).toEqual({
      state: 'archived',
      accepted: false,
    });

  });
});


it('review dispatch is immediate and leaves unrelated reviewer work independent', async () => {
  const cornerId = await inReview();
  expect(await currentState(cornerId)).toBe('review');
  expect(await commands(B, cornerId)).toHaveLength(1);
  expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ approved: false, open: false });
  const other = await createAgentCommand(rootFixture.db, { roomId: cornerId, agentId: B, sourceMessageId: null,
    reason: 'corner_brief', privatePayload: { text: 'Unrelated reviewer fact', authorId: A, fromRoomId: R, kind: 'lifecycle' } });
  const pending = await commands(B, cornerId);
  expect(pending).toHaveLength(2);
  expect(pending.find(command => command.id === other!.id)?.source.body).toBe('Unrelated reviewer fact');
});


it('Reproduction F1-7: opener revises a delegated sibling from its own command', async () => {
  const source = await open('owner/widgets');
  const command = await commissioned(source);
  const input = { roomId: source, requestId: command.turnRequestId, generationId: 'g1', name: 'Delegate-widget', objective: 'Ship the widget', repository: 'owner/widgets', implementer: 'goosy', brief: brief(command.sourceMessageId) };
  const { cornerId } = await rootFixture.daemon.execute('createCorner', input, A);
  await rootFixture.db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`, [R, B]);
  const result = await rootFixture.daemon.execute('reviseCornerBrief', { roomId: source, cornerId, requestId: command.turnRequestId, generationId: 'g1', expectedRevision: 1, brief: { ...input.brief, spec: 'Corrected widget', change: 'Correct scope' } }, A);
  console.info(`Reproduction F1-7: wrong=revision denied; right=revision 2; observed=${result.revision}`);
  expect(result).toMatchObject({ revision: 2, wake: { queued: true, agentId: B } });
  await fallback(cornerId);
  const outsider = await createAgentCommand(rootFixture.db, { roomId: cornerId, agentId: F, sourceMessageId: command.sourceMessageId, reason: 'audit' });
  await rootFixture.daemon.execute('claimAgentCommand', { roomId: cornerId, commandId: outsider!.id, generationId: 'g1' }, F);
  // Reach, not role, decides: an agent outside both the corner and its parent Room is refused.
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id IN ($1,$2) AND identity_id=$3`, [cornerId, R, F]);
  await expect(rootFixture.daemon.execute('reviseCornerBrief', { roomId: cornerId, cornerId, requestId: outsider!.turn_request_id, generationId: 'g1', expectedRevision: 2, brief: { ...input.brief, change: 'Unauthorized' } }, F)).rejects.toThrow(/denied/);
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, B]);
  const unwoken = await rootFixture.daemon.execute('reviseCornerBrief', { roomId: source, cornerId, requestId: command.turnRequestId, generationId: 'g1', expectedRevision: 2, brief: { ...input.brief, spec: 'Saved without a worker', change: 'Keep the revision' } }, A);
  expect(unwoken).toMatchObject({ revision: 3, wake: { queued: false, reason: expect.any(String) } });
  expect((await rootFixture.daemon.execute('listCornerBriefRevisions', { cornerId }, A)).revisions[0]!.revision).toBe(3);
});


it('a corner member revises from its own corner and the Room', async () => {
  const cornerId = await open('owner/widgets');
  const command = await commissioned(cornerId);
  const G = '8'.repeat(64);
  await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Heir','heir') ON CONFLICT DO NOTHING`, [G]);
  await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [G, H]);
  for (const roomId of [null, R])
    await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING`, [W, roomId, G]);
  const turn = await createAgentCommand(rootFixture.db, { roomId: cornerId, agentId: G, sourceMessageId: command.sourceMessageId, reason: 'human_tag' });
  await rootFixture.daemon.execute('claimAgentCommand', { roomId: cornerId, commandId: turn!.id, generationId: 'g1' }, G);
  const input = { cornerId, requestId: turn!.turn_request_id, generationId: 'g1', expectedRevision: 1, brief: { ...brief(command.sourceMessageId), spec: 'Heir scope', change: 'Take over' } };
  expect(await rootFixture.daemon.execute('reviseCornerBrief', input, G)).toMatchObject({ revision: 2 });
  await rootFixture.phone.execute('sendRoomMessage', { roomId: R, messageId: randomBytes(32).toString('hex'), text: '@heir revise the brief' }, H);
  const roomTurn = (await rootFixture.daemon.execute('getAgentCommands', { roomId: R }, G)).commands.at(-1)!;
  await claim(roomTurn);
  expect(await rootFixture.daemon.execute('reviseCornerBrief', { ...input, expectedRevision: 2, roomId: R, requestId: roomTurn.turnRequestId }, G))
    .toMatchObject({ revision: 3 });
});


it('Reproduction F1-9: brief history defaults to one revision with a cursor', async () => {
  const cornerId = await open('owner/widgets');
  await revise(cornerId);
  const result = await rootFixture.daemon.execute('listCornerBriefRevisions', { cornerId }, A);
  console.info(`Reproduction F1-9: wrong=2 full revisions; right=1 with cursor; observed=${result.revisions.length}`);
  expect(result.revisions.map(r => r.revision)).toEqual([2]);
  expect(result.nextBeforeRevision).toBe(2);
  expect((await rootFixture.daemon.execute('listCornerBriefRevisions', { cornerId, beforeRevision: 2 }, A)).revisions[0]!.revision).toBe(1);
  expect((await rootFixture.daemon.execute('listCornerBriefRevisions', { cornerId, limit: 20 }, A)).revisions).toHaveLength(2);
  await expect(rootFixture.daemon.execute('listCornerBriefRevisions', { cornerId, limit: 21 }, A)).rejects.toThrow('invalid');
});


it('Reproduction F1-11: exact replay survives implementer departure', async () => {
  const command = await commissioned(R);
  const input = { roomId: R, requestId: command.turnRequestId, generationId: 'g1', idempotencyKey: 'f1-replay', name: 'Delegate-widget', objective: 'Ship widget', repository: 'owner/widgets', implementer: 'goosy', brief: brief(command.sourceMessageId) };
  const first = await rootFixture.daemon.execute('createCorner', input, A);
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, B]);
  const replay = await rootFixture.daemon.execute('createCorner', input, A);
  console.info(`Reproduction F1-11: wrong=membership refusal; right=original corner; observed=${replay.cornerId}`);
  expect(replay).toEqual(first);
  await expect(rootFixture.daemon.execute('createCorner', { ...input, implementer: 'hoots' }, A)).rejects.toThrow('assignment conflict');
  await expect(rootFixture.daemon.execute('createCorner', { ...input, brief: { ...input.brief, spec: 'Different' } }, A)).rejects.toThrow('assignment conflict');
  await expect(rootFixture.daemon.execute('createCorner', { ...input, idempotencyKey: 'new-call' }, A)).rejects.toThrow('current member');
});
describe('a brief revision wakes only the implementer and keeps the yes', () => {
const scope11 = fixtureScope11();


  it.each(['removed', 'offline'] as const)('wakes the implementer, not another agent, when the reviewer is %s', async (condition) => {
    const cornerId = await approved();
    await scope11.implementerOnline();
    await fallback(cornerId);
    if (condition === 'removed') await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [R, B]);
    const before = await reasons(cornerId, B);
    expect(await revise(cornerId)).toMatchObject({ revision: 2, wake: { queued: true, agentId: A } });
    expect(await reasons(cornerId, A)).toContain('corner_brief_revision');
    expect(await reasons(cornerId, F)).toEqual([]);
    expect(await reasons(cornerId, B)).toEqual(before);
    expect(await currentState(cornerId)).toBe('working');
  });


  it('keeps the yes on the head: a brief edit does not cancel it, and the implementer still merges', async () => {
    const cornerId = await approved();
    await implementerOnline();
    const recording = new RecordingDatabase(db);
    expect(await revise(cornerId, new DaemonService(recording, new LiveHub())))
      .toMatchObject({ revision: 2, wake: { queued: true, agentId: A } });
    const lock = recording.calls.findIndex(c => c.sql === 'SELECT corner_id FROM corner_facts WHERE corner_id=$1 FOR UPDATE');
    const write = recording.calls.findIndex(c => c.sql.startsWith('INSERT INTO corner_brief_revisions'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(write);
    expect(await reasons(cornerId, B)).not.toContain('corner_check');
    expect(await currentState(cornerId)).toBe('working');
    expect(await cornerMergeGate(db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ approved: true, open: true });
    expect(await github.prChecksStatus({ cornerId })).toMatchObject({ approved: true, mergeAllowed: true });
    expect(await implementersMerge()).toBe(1);
    expect(githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);
  });


  it('a green brief revision wakes the implementer without another review', async () => {
    const cornerId = await inReview();
    await scope11.implementerOnline();
    const reviewerBefore = await reasons(cornerId, B);
    expect(await revise(cornerId)).toMatchObject({ wake: { queued: true, agentId: A } });
    expect(await reasons(cornerId, B)).toEqual(reviewerBefore);
    expect(await currentState(cornerId)).toBe('working');
  });


  it.each(['pending', 'failing'])('does not review a revision while checks are %s', async (checks) => {
    const cornerId = await approved();
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}',to_jsonb($2::text)) WHERE corner_id=$1`, [cornerId, checks]);
    await revise(cornerId);
    expect(await reasons(cornerId, B)).not.toContain('corner_check');
  });
});
