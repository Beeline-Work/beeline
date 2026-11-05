import { describe, expect, it, systemLine, advanceCorner, CORNER_LIFECYCLE_CONTRACT, cornerMergeGate, H, A, B, R, db, phone, daemon, github, githubRollupState, githubHead, githubApp, recordedEdges, implementersMerge, cards, currentState, open, pushToCorner, redHead, SHA, branchOf, reasons, projected, inReview, approved, rootFixture, fixtureScope28, fixtureScope32, fixtureScope33, fixtureScope37 } from './corner-lifecycle.test-support.js';

describe('re-runs and pushes out of review (AC-1)', () => {

  it('a push during review goes review -> checks', async () => {
    const cornerId = await inReview();
    await pushToCorner(cornerId, '8'.repeat(40));
    expect(await currentState(cornerId)).toBe('checks');
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'review', outcome: 'pushed', toState: 'checks' }),
    );
  });
});
describe('the implementer merges when the gate opens (AC-5)', () => {

  it.each(['checks', 'implement'])('closing a PR from %s resets the run and cancels its yes', async state => {
    const cornerId = await inReview();
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}',to_jsonb($2::text)) WHERE corner_id=$1`,
      [cornerId, state === 'checks' ? 'pending' : 'failing']);
    if (state === 'checks') await advanceCorner(rootFixture.db, cornerId, { kind: 'checks-pending' });
    else await systemLine(rootFixture.db, { roomId: cornerId, authorId: H, subject: { kind: 'github', name: 'GitHub' },
      verb: 'failed a check', kind: 'check-failed' });
    expect(await currentState(cornerId)).toBe(state);
    await rootFixture.db.query(`INSERT INTO corner_merge_approvals(corner_id,approved_by,pull_request_number,head_sha) VALUES($1,$2,7,$3)`,
      [cornerId, B, SHA]);
    await rootFixture.github.closeCornerPullRequest(cornerId);
    expect(await currentState(cornerId)).toBe('implement');
    expect(await projected(cornerId)).toBe('implement');
    expect((await rootFixture.db.query(`SELECT 1 FROM corner_merge_approvals WHERE corner_id=$1`, [cornerId])).rowCount).toBe(0);
    expect(rootFixture.githubApp.deleteBranch).not.toHaveBeenCalled();
  });
});
describe('GitHub refusing the merge (AC-6)', () => {
  it.each([405, 409])('HTTP %i returns the corner to implement and wakes the implementer with the reason', async (status) => {
    const cornerId = await approved();
    const reason = `GitHub pull request merge failed: HTTP ${status}: Base branch was modified`;
    rootFixture.githubApp.mergePullRequest.mockRejectedValue(new Error(reason));
    await implementersMerge();
    expect(await currentState(cornerId)).toBe('implement');
    expect(await cards(cornerId)).toContainEqual(
      expect.objectContaining({ fromState: 'review', outcome: 'merge_refused', toState: 'implement' }),
    );
    expect((await reasons(cornerId, A)).filter((r) => r === 'corner_merge_refused')).toHaveLength(1);
    const lines = (
      await rootFixture.db.query<{ text: string }>(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%refused to merge%'`, [
        cornerId,
      ])
    ).rows;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain(`HTTP ${status}`);
    // Nothing records the attempt: a fresh merge_corner retries the head live,
    // and the same refusal is neither repeated in the corner nor re-woken.
    await implementersMerge();
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(2);
    expect(await currentState(cornerId)).toBe('implement');
    expect((await reasons(cornerId, A)).filter((r) => r === 'corner_merge_refused')).toHaveLength(1);
    expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND text LIKE '%refused to merge%'`, [cornerId])).rowCount)
      .toBe(1);
    // The queued recovery command keeps the badge working even before claim.
    const listed = (await rootFixture.phone.readCorners(R, H))!.corners.find((row) => row.corner.id === cornerId);
    expect(listed).toMatchObject({ state: 'working' });
  });
});
describe('MERGE-LIVE: merges read GitHub live; nothing records an attempt', () => {
const scope28 = fixtureScope28();


  it('Reproduction MERGE-RETRY-PROD: confirmed draft refusal, undraft, and merge_corner retry merge the same head once', async () => {
    const cornerId = await approved();
    let draft = true;
    rootFixture.githubApp.readPullRequest.mockResolvedValue(scope28.providerPr(cornerId));
    const reason = 'GitHub pull request merge failed: HTTP 405: Pull Request is still a draft';
    rootFixture.githubApp.mergePullRequest.mockImplementation(async () => {
      if (draft) throw new Error(reason);
      rootFixture.githubApp.readPullRequest.mockResolvedValue(scope28.providerPr(cornerId, true));
    });
    expect(await scope28.mergeDaemon().execute('mergeCorner', { cornerId }, A)).toEqual({ status: 'blocked', blocker: reason });
    expect(await currentState(cornerId)).toBe('implement');
    draft = false;
    expect(await scope28.mergeDaemon().execute('mergeCorner', { cornerId }, A)).toEqual({ status: 'merge-started', headSha: SHA });
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(2);
    expect(await currentState(cornerId)).toBe('landed');
  });
});
describe("a Workspace owner or admin's yes (order_corner_merge) merges only through the one gate", () => {
const scope32 = fixtureScope32();


  it("the phone's approve is the same yes: it waits for green checks, then the implementer merges", async () => {
    const cornerId = await open('owner/widgets');
    await redHead(cornerId, 7, SHA);
    rootFixture.githubHead = SHA;
    rootFixture.githubRollupState = 'failed';
    await expect(rootFixture.github.approveCornerMerge(H, { cornerId })).resolves.toMatchObject({ status: 'merge-requested' });
    await expect(rootFixture.github.approveCornerMerge(H, { cornerId })).resolves.toMatchObject({ status: 'already-requested' });
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
    expect(await cornerMergeGate(rootFixture.db, cornerId, { number: 7, headSha: SHA })).toMatchObject({ approved: true, open: true });
    rootFixture.githubRollupState = 'passed';
    expect(await implementersMerge()).toBe(1);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });
});
describe('the brief gate on landing: only a brief that assigns repository work merges', () => {
const scope33 = fixtureScope33();


  it("the phone's approve merges when the brief leaves repositoryWork unset", async () => {
    const cornerId = await scope33.waitingForPerson();
    await expect(rootFixture.github.approveCornerMerge(H, { cornerId })).resolves.toMatchObject({ status: 'merge-requested' });
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });
});
describe('closed corner branch cleanup (Reproduction BRANCH-CLOSE-1)', () => {
const scope37 = fixtureScope37();


  it('keeps the branch after close_corner_pr and deletes after the corner closes', async () => {
    const cornerId = await inReview();
    await rootFixture.github.closeCornerPullRequest(cornerId);
    expect(rootFixture.githubApp.deleteBranch).not.toHaveBeenCalled();
    await rootFixture.daemon.execute('archiveCorner', { cornerId }, A);
    expect(rootFixture.githubApp.deleteBranch).toHaveBeenCalledWith(77, 101, 'owner/widgets', branchOf(cornerId));
  });
});
describe('every contract edge (AC-1)', () => {
  it('is taken by some test in this file', () => {
    const expected = new Set<string>();
    for (const [from, state] of Object.entries(CORNER_LIFECYCLE_CONTRACT.handoffs)) {
      if (!('on' in state)) continue;
      for (const [outcome, to] of Object.entries(state.on)) expected.add(`${from}:${outcome}:${to}`);
      if ('loop' in state && state.loop) expected.add(`${from}:${state.loop.onEdge}:${state.loop.onExceeded}`);
    }
    const taken = new Set([...recordedEdges].map((edge) => edge));
    const missing = [...expected].filter((edge) => !taken.has(edge));
    expect(missing).toEqual([]);
    for (const terminal of CORNER_LIFECYCLE_CONTRACT.implicitEdges ?? [])
      expect([...taken].some((edge) => edge.endsWith(`:${terminal}:${terminal}`))).toBe(true);
  });
});
