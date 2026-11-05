import { describe, expect, it, vi, PhoneService, backfillArchivedCornerCleanup, deleteArchivedCornerBranch, GitHubHttpError, H, A, W, R, db, phone, daemon, github, githubApp, currentState, open, SHA, branchOf, reasons, inReview, approved, mergedWebhook, rootFixture, fixtureScope37, fixtureScope38, type GitHubAppClient } from './corner-lifecycle.test-support.js';

describe('closed corner branch cleanup (Reproduction BRANCH-CLOSE-1)', () => {
const scope37 = fixtureScope37();


  it('BRANCH-DERIVED: closes and deletes once after commit, without a queue or repeat on duplicate close', async () => {
    rootFixture.githubApp.deleteBranch.mockImplementation(async (_installation: number, _repository: number, _name: string, branch: string) => {
      const rows = await rootFixture.db.query(`SELECT 1 FROM rooms WHERE archived_at IS NOT NULL
        AND 'feature/corner-'||left(replace(id::text,'-',''),12)=$1`, [branch]);
      expect(rows.rowCount).toBe(1);
    });
    const cornerId = await scope37.closeAndClean();
    await rootFixture.phone.execute('requestCornerClose', { roomId: cornerId }, H);
    expect(rootFixture.githubApp.deleteBranch).toHaveBeenCalledTimes(1);
    expect(rootFixture.githubApp.deleteBranch).toHaveBeenCalledWith(77, 101, 'owner/widgets', branchOf(cornerId));
  });


  it('keeps a branch used by an unarchived corner with a colliding prefix', async () => {
    const cornerId = await open('owner/widgets');
    const sibling = cornerId.slice(0, -1) + (cornerId.endsWith('0') ? '1' : '0');
    await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Collision')`, [sibling, W, R]);
    await rootFixture.db.query(`INSERT INTO corner_facts(corner_id) VALUES($1)`, [sibling]);
    await rootFixture.daemon.execute('archiveCorner', { cornerId }, A);
    expect(rootFixture.githubApp.deleteBranch).not.toHaveBeenCalled();
  });


  it.each(['head', 'base'])('keeps a branch used as an open PR %s', async role => {
    if (role === 'head') rootFixture.githubApp.openPullRequestsForBranch.mockResolvedValue([42]);
    else rootFixture.githubApp.branchDeletionSafety.mockResolvedValue({ defaultBranch: 'main', aheadBy: 0, protected: false, openBasePullRequest: true });
    await scope37.closeAndClean();
    expect(rootFixture.githubApp.deleteBranch).not.toHaveBeenCalled();
  });


  it.each(['default', 'protected'])('keeps a live %s branch', async kind => {
    const cornerId = await open('owner/widgets');
    rootFixture.githubApp.branchDeletionSafety.mockResolvedValue({ defaultBranch: kind === 'default' ? branchOf(cornerId) : 'main', aheadBy: 0, protected: kind === 'protected' });
    await rootFixture.daemon.execute('archiveCorner', { cornerId }, A);
    expect(rootFixture.githubApp.deleteBranch).not.toHaveBeenCalled();
  });


  it('logs a failed deletion without blocking archival, queuing or retrying', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    rootFixture.githubApp.deleteBranch.mockRejectedValueOnce(new Error('offline'));
    const cornerId = await scope37.closeAndClean();
    await rootFixture.phone.execute('requestCornerClose', { roomId: cornerId }, H);
    expect((await rootFixture.db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0]!.archived_at).not.toBeNull();
    expect(rootFixture.githubApp.deleteBranch).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('offline'));
    log.mockRestore();
  });


  it.each([404, 422])('treats deletion HTTP %i as done', async status => {
    rootFixture.githubApp.deleteBranch.mockRejectedValueOnce(new GitHubHttpError('delete', status));
    const cornerId = await scope37.closeAndClean();
    expect(rootFixture.githubApp.deleteBranch).toHaveBeenCalledTimes(1);
  });


  it('BRANCH-DERIVED: deletes a merged branch once with no queue', async () => {
    const cornerId = await approved();
    await mergedWebhook(cornerId, 7, SHA);
    await mergedWebhook(cornerId, 7, SHA);
    expect(rootFixture.githubApp.deleteBranch).toHaveBeenCalledTimes(1);
    expect(rootFixture.githubApp.deleteBranch).toHaveBeenCalledWith(77, 101, 'owner/widgets', branchOf(cornerId));
  });


  it('cleans the derived branch after a person closes the corner', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.phone.execute('requestCornerClose', { roomId: cornerId }, H);
    expect(rootFixture.githubApp.deleteBranch).toHaveBeenCalledWith(77, 101, 'owner/widgets', branchOf(cornerId));
  });


  it('finishes without deletion if GitHub already removed the branch', async () => {
    rootFixture.githubApp.branchDeletionSafety.mockResolvedValue(undefined);
    await scope37.closeAndClean();
    expect(rootFixture.githubApp.deleteBranch).not.toHaveBeenCalled();
  });


  it('CLEANUP-GIT-1: maintenance scans historical archives on each explicit invocation and excludes live corners', async () => {
    const archived = await inReview();
    const live = await open('owner/widgets');
    await rootFixture.db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [archived]);
    const app = rootFixture.githubApp as unknown as GitHubAppClient;
    const results = await backfillArchivedCornerCleanup(rootFixture.db, app);
    expect(results).toEqual([{ cornerId: archived, branch: branchOf(archived), status: 'deleted_or_already_absent' }]);
    expect(rootFixture.githubApp.deleteBranch).not.toHaveBeenCalledWith(77, 101, 'owner/widgets', branchOf(live));
    await backfillArchivedCornerCleanup(rootFixture.db, app);
    expect(rootFixture.githubApp.deleteBranch).toHaveBeenCalledTimes(2);
  });


  it.each(['head', 'base'])('CLEANUP-GIT-1: maintenance rechecks a temporary %s blocker only when invoked', async kind => {
    if (kind === 'head') rootFixture.githubApp.openPullRequestsForBranch.mockResolvedValue([42]);
    else rootFixture.githubApp.branchDeletionSafety.mockResolvedValue({ defaultBranch: 'main', aheadBy: 0, protected: false, openBasePullRequest: true });
    await scope37.closeAndClean();
    expect(rootFixture.githubApp.deleteBranch).not.toHaveBeenCalled();
    rootFixture.githubApp.openPullRequestsForBranch.mockResolvedValue([]);
    rootFixture.githubApp.branchDeletionSafety.mockResolvedValue({ defaultBranch: 'main', aheadBy: 0, protected: false, openBasePullRequest: false });
    await backfillArchivedCornerCleanup(rootFixture.db, rootFixture.githubApp as unknown as GitHubAppClient);
    expect(rootFixture.githubApp.deleteBranch).toHaveBeenCalledTimes(1);
  });


  it('CLEANUP-GIT-1: reports retention when the repository mapping is unavailable', async () => {
    const cornerId = await open('owner/widgets');
    await rootFixture.db.query(`UPDATE rooms SET repository_key='unknown/missing',repository_remote=NULL WHERE id=$1`, [R]);
    await rootFixture.db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [cornerId]);
    expect(await deleteArchivedCornerBranch(rootFixture.db, rootFixture.githubApp as unknown as GitHubAppClient, cornerId))
      .toMatchObject({ status: 'kept', reason: 'GitHub repository is unavailable' });
    expect(rootFixture.githubApp.deleteBranch).not.toHaveBeenCalled();
    await rootFixture.db.query(`UPDATE rooms SET repository_key='owner/widgets',repository_remote='https://github.com/owner/widgets.git' WHERE id=$1`, [R]);
  });


  it('BRANCH-DERIVED: closing an unmerged corner retains commits absent from the default branch', async () => {
    rootFixture.githubApp.branchDeletionSafety.mockResolvedValue({ defaultBranch: 'main', aheadBy: 3, protected: false, openBasePullRequest: false });
    await scope37.closeAndClean();
    expect(rootFixture.githubApp.deleteBranch).not.toHaveBeenCalled();
  });


  it.each([true, false])('CLEANUP-GIT-1: historical squash-merge cleanup requires the exact merged head (matches=%s)', async matches => {
    const cornerId = await approved();
    rootFixture.githubApp.branchDeletionSafety.mockResolvedValue({ defaultBranch: 'main', aheadBy: 2, protected: false, openBasePullRequest: false });
    await mergedWebhook(cornerId, 7, SHA);
    expect(rootFixture.githubApp.deleteBranch).toHaveBeenCalledTimes(1);
    rootFixture.githubApp.deleteBranch.mockClear();
    const app = { ...rootFixture.githubApp, readBranchHead: vi.fn(async () => matches ? SHA : 'new-unpublished-head') } as unknown as GitHubAppClient;
    const results = await backfillArchivedCornerCleanup(rootFixture.db, app);
    expect(results[0]?.status).toBe(matches ? 'deleted_or_already_absent' : 'kept');
    expect(rootFixture.githubApp.deleteBranch).toHaveBeenCalledTimes(matches ? 1 : 0);
  });
});
describe('merge queue (Reproduction R1)', () => {
const scope38 = fixtureScope38();


  it('R1: closing a queued PR keeps the corner open without queue state or further GitHub reads', async () => {
    const cornerId = await scope38.queued();
    await rootFixture.github.closeCornerPullRequest(cornerId);
    const visible = (await rootFixture.phone.readCorners(R, H))!.corners.find(row => row.corner.id === cornerId);
    expect(visible).toBeDefined();
    expect(visible?.lifecycle.pr).toBeUndefined();
    expect(visible?.lifecycle.mergeQueue).toBeUndefined();
    expect(await currentState(cornerId)).toBe('implement');
    rootFixture.githubApp.readPullRequest.mockClear();
    rootFixture.githubApp.readPullRequestQueue.mockClear();
    await rootFixture.github.reconcileQueuedCorners();
    expect(rootFixture.githubApp.readPullRequest).not.toHaveBeenCalled();
    expect(rootFixture.githubApp.readPullRequestQueue).not.toHaveBeenCalled();
  });


  it('R1: main advances, combined checks fail, the PR leaves the queue and wakes its implementer once', async () => {
    const cornerId = await scope38.queued();
    rootFixture.githubApp.readPullRequestQueue.mockResolvedValue({ id: 'PR_7', headSha: SHA, entry: null });
    rootFixture.githubApp.readCommitCheckRollup.mockImplementation(async (_token, _repo, sha) => ({
      state: sha === scope38.combinedSha ? 'failed' : 'passed', total: 1,
      failing: sha === scope38.combinedSha ? ['TYPECHECK'] : [], checks: [],
    }));
    await rootFixture.github.reconcileQueuedCorners();
    await rootFixture.github.reconcileQueuedCorners();
    expect(await currentState(cornerId)).toBe('implement');
    expect((await reasons(cornerId, A)).filter(reason => reason === 'corner_merge_refused')).toHaveLength(1);
    expect((await rootFixture.db.query(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%Removed from the merge queue%'`, [cornerId])).rows)
      .toEqual([expect.objectContaining({ text: expect.stringContaining('TYPECHECK') })]);
    expect((await rootFixture.db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0]!.archived_at).toBeNull();
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
    console.info('Reproduction R1: advanced main + failed combined TYPECHECK -> returned to implement, no merge, one wake');
  });


  it('R1: combined checks pass and GitHub confirms the merge through the existing close path', async () => {
    const cornerId = await scope38.queued();
    rootFixture.githubApp.readPullRequest.mockResolvedValue({ headSha: SHA, headRef: branchOf(cornerId),
      baseRef: 'main', merged: true, mergedAt: '2026-10-22T15:00:00Z' });
    await rootFixture.github.reconcileQueuedCorners();
    expect(await currentState(cornerId)).toBe('landed');
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });


  it.each(['agent close', 'GitHub close', 'missed close webhook'] as const)(
    'R1: %s clears queued state before reconciling the open corner', async path => {
      const cornerId = await scope38.queued();
      if (path === 'agent close') {
        await rootFixture.github.closeCornerPullRequest(cornerId);
      } else if (path === 'GitHub close') {
        await rootFixture.github.processWebhook('pull_request', {
          action: 'closed', installation: { id: 77 }, repository: { id: 101, full_name: 'owner/widgets' },
          pull_request: { number: 7, html_url: 'https://github.com/owner/widgets/pull/7', title: 'Widget', merged: false,
            head: { ref: branchOf(cornerId), sha: SHA }, base: { ref: 'main' } },
        });
      } else {
        rootFixture.githubApp.readPullRequest.mockResolvedValue({ number: 7, headSha: SHA, headRef: branchOf(cornerId),
          merged: false, state: 'closed' });
        await rootFixture.github.prChecksStatus({ cornerId, pullRequest: 7 });
      }
      const visible = (await rootFixture.phone.readCorners(R, H))!.corners.find(row => row.corner.id === cornerId);
      expect(visible?.lifecycle.pr).toBeUndefined();
      expect(visible?.lifecycle.mergeQueue).toBeUndefined();
      expect(await currentState(cornerId)).toBe('implement');
      expect((await rootFixture.db.query(`SELECT archived_at FROM rooms WHERE id=$1`, [cornerId])).rows[0]!.archived_at).toBeNull();

      rootFixture.githubApp.readPullRequest.mockClear();
      rootFixture.githubApp.readPullRequestQueue.mockClear();
      await rootFixture.github.reconcileQueuedCorners();
      expect(rootFixture.githubApp.readPullRequest).not.toHaveBeenCalled();
      expect(rootFixture.githubApp.readPullRequestQueue).not.toHaveBeenCalled();
    },
  );


  it('dequeues a queued PR after a human sets a hold', async () => {
    const cornerId = await scope38.queued();
    const wiredPhone = new PhoneService(rootFixture.db, 'http://test', rootFixture.github);
    await wiredPhone.execute('setCornerHold', { cornerId }, H);
    expect(rootFixture.githubApp.dequeuePullRequest).toHaveBeenCalledWith('tok', 'PR_7');
    expect(await currentState(cornerId)).toBe('implement');
    expect(await rootFixture.github.landCornerOutcome(cornerId)).toEqual({ status: 'not-attempted' });
  });
});


it('R1 / A6: a hold dequeues an accepted enqueue whose response and first queue read were lost', async () => {
  const cornerId = await approved();
  rootFixture.githubApp.readPullRequest.mockResolvedValue({ headSha: SHA, headRef: branchOf(cornerId), baseRef: 'main', merged: false });
  rootFixture.githubApp.mergePullRequest.mockRejectedValueOnce(Object.assign(new Error('response lost'), { queueAttempted: true }));
  rootFixture.githubApp.readPullRequestQueue.mockRejectedValueOnce(new Error('queue read unavailable'));
  expect(await rootFixture.github.landCornerOutcome(cornerId)).toEqual({ status: 'refused', reason: 'response lost' });
  expect(await currentState(cornerId)).toBe('review');
  expect((await rootFixture.phone.readCorners(R, H))!.corners.find(row => row.corner.id === cornerId)?.lifecycle.mergeQueue)
    .toBeUndefined();
  // GitHub did queue it. A person's hold reads the queue live and takes it out.
  rootFixture.githubApp.readPullRequestQueue.mockResolvedValue({ id: 'PR_7', headSha: SHA, entry: { id: 'MQ_7' } });
  await new PhoneService(rootFixture.db, 'http://test', rootFixture.github).execute('setCornerHold', { cornerId }, H);
  expect(rootFixture.githubApp.dequeuePullRequest).toHaveBeenCalledWith('tok', 'PR_7');
  expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  console.info('Reproduction A6 Demonstrated: lost enqueue response, then a hold dequeued the live queue entry with no stored claim.');
});
