import { cornerFeatureBranch, describe, expect, it, R, C, AUTHOR, REVIEWER, URL, SHA, db, operations, daemon, head, rollupState, mergeableState, pullBaseSha, mainHead, failMergeabilityRead, workflowCount, registeredCount, onWorkflowRead, gate, graphqlRequests, ownPr, rootFixture, fixtureScope2 } from './test-support-pr-checks-status.test-support.js';

describe('zero-check worker completion', () => {
const scope2 = fixtureScope2();


  it('finishes a head with workflows but no registered suites or runs in one explicit confirmation', async () => {
    rootFixture.rollupState = null;
    rootFixture.workflowCount = 2;
    rootFixture.registeredCount = 0;
    rootFixture.mergeableState = 'clean';
    rootFixture.pullBaseSha = rootFixture.mainHead;
    const after = await scope2.finishPrTurn(rootFixture.mainHead);
    expect(after.lifecycle).toMatchObject({ checks: 'passing', checksSummary: { total: 0 } });
    expect(after.reviewer).toEqual(['subscribed_event']);
  }, 20_000);


  it('does not transfer absence evidence to a head pushed during confirmation', async () => {
    rootFixture.rollupState = null;
    rootFixture.mergeableState = 'clean';
    rootFixture.pullBaseSha = rootFixture.mainHead;
    rootFixture.onWorkflowRead = async () => { rootFixture.head = 'f'.repeat(40); };
    const after = await scope2.finishPrTurn(rootFixture.mainHead);
    expect(after.lifecycle.checks).not.toBe('passing');
    expect(after.reviewer).toEqual([]);
  });


  it('does not overwrite a concurrent check webhook with an older empty read', async () => {
    rootFixture.rollupState = null;
    rootFixture.mergeableState = 'clean';
    rootFixture.pullBaseSha = rootFixture.mainHead;
    rootFixture.onWorkflowRead = async () => {
      rootFixture.rollupState = 'PENDING';
      await rootFixture.operations.processWebhook('check_run', {
        installation: { id: 77 }, repository: { id: 101, full_name: 'owner/widgets' }, action: 'created',
        check_run: { id: 1, name: 'test', status: 'in_progress', conclusion: null,
          check_suite: { head_branch: cornerFeatureBranch(C), head_sha: SHA } },
      });
      // The next provider read lags the webhook's committed rollup.
      rootFixture.rollupState = null;
    };
    const after = await scope2.finishPrTurn(rootFixture.mainHead);
    expect(after.lifecycle).toMatchObject({ checks: 'pending', checksSummary: { total: 1 } });
    expect(after.reviewer).toEqual([]);
  });


  it.each([
    `PR: ${URL}\nReady for review.`,
    'Checks are still pending; nothing to push.',
    '@owner the change is ready for review.',
  ])('Reproduction ZC-2: dispatches no-CI review after reply %s', async (text) => {
    rootFixture.rollupState = null;
    rootFixture.mergeableState = 'clean';
    rootFixture.pullBaseSha = rootFixture.mainHead;
    const after = await scope2.finishPrTurn(rootFixture.mainHead, text);
    console.info(
      `Reproduction ZC-2: zero contexts, worker completed; reviewer commands=${JSON.stringify(after.reviewer)}`,
    );
    expect(after.reviewer).toEqual(['subscribed_event']);
    expect(after.lifecycle).toMatchObject({ checks: 'passing', checksSummary: { total: 0 } });
    expect(after.worker).toEqual([]);
    expect(await gate()).toMatchObject({ approved: false, mergeAllowed: false });
  });


  it.each(['PENDING', 'FAILURE'])('keeps configured CI gated when checks are %s', async (state) => {
    rootFixture.rollupState = state;
    rootFixture.mergeableState = 'clean';
    rootFixture.pullBaseSha = rootFixture.mainHead;
    const after = await scope2.finishPrTurn(rootFixture.mainHead, 'Ready for review.');
    expect(after.reviewer).toEqual([]);
    expect(after.lifecycle.checks).not.toBe('passing');
    expect(await gate()).toMatchObject({
      checks: state === 'PENDING' ? 'pending' : 'failed',
      checkCount: 1,
      mergeAllowed: false,
    });
  });


  it('keeps waiting on a clean verdict GitHub computed against a stale base', async () => {
    rootFixture.rollupState = null;
    rootFixture.mergeableState = 'clean';
    rootFixture.pullBaseSha = 'e'.repeat(40);
    const after = await scope2.finishPrTurn(rootFixture.mainHead);
    expect(after.lifecycle.pr).toMatchObject({ mergeability: 'unknown', baseSha: rootFixture.mainHead });
    expect(after.lifecycle.checks).not.toBe('passing');
    expect(after.reviewer).toEqual([]);
  });


  it('keeps waiting while GitHub is still computing mergeability', async () => {
    rootFixture.rollupState = null;
    rootFixture.mergeableState = 'unknown';
    rootFixture.pullBaseSha = rootFixture.mainHead;
    const after = await scope2.finishPrTurn(rootFixture.mainHead);
    expect(after.lifecycle.pr.mergeability).toBe('unknown');
    expect(after.lifecycle.checks).not.toBe('passing');
    expect(after.lifecycle.checksSummary).toBeUndefined();
    expect(after.reviewer).toEqual([]);
    expect(after.worker).toEqual([]);
  });


  it('keeps waiting when the mergeability read fails', async () => {
    rootFixture.rollupState = null;
    rootFixture.mergeableState = 'clean';
    rootFixture.pullBaseSha = rootFixture.mainHead;
    rootFixture.failMergeabilityRead = true;
    const after = await scope2.finishPrTurn(rootFixture.mainHead);
    expect(after.lifecycle.pr.mergeability).toBe('unknown');
    expect(after.lifecycle.checks).not.toBe('passing');
    expect(after.lifecycle.checksSummary).toBeUndefined();
    expect(after.reviewer).toEqual([]);
    expect(after.worker).toEqual([]);
  });
});


it('Reproduction idle-1: a lost completion waits for explicit operator reconciliation', async () => {
  await ownPr();
  await rootFixture.db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1',[R,REVIEWER]);
  rootFixture.rollupState='PENDING';
  expect(await gate(AUTHOR)).toMatchObject({checks:'pending'});
  const before=graphqlRequests().length;
  rootFixture.rollupState='SUCCESS';
  expect(graphqlRequests()).toHaveLength(before);
  expect((await rootFixture.db.query(`SELECT lifecycle->>'checks' checks FROM corner_facts WHERE corner_id=$1`,[AUTHOR])).rows[0]?.checks).toBe('pending');
  await rootFixture.operations.prChecksStatus({cornerId:AUTHOR});
  expect(graphqlRequests()).toHaveLength(before+1);
  expect((await rootFixture.db.query(`SELECT lifecycle->>'checks' checks FROM corner_facts WHERE corner_id=$1`,[AUTHOR])).rows[0]?.checks).toBe('passing');
  expect((await rootFixture.daemon.execute('getAgentCommands',{roomId:AUTHOR},REVIEWER)).commands).toHaveLength(1);
});
