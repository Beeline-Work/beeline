import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { classify, easternSlot, runNightly, finishNightly, publishIssues } from './nightly-checks.mjs';

const job = (name, conclusion, attempt) => ({ name, conclusion, id: attempt, html_url: `https://example/jobs/${attempt}`, started_at: `2026-01-01T08:0${attempt}:00Z`, completed_at: `2026-01-01T08:0${attempt + 1}:00Z` });
test('nightly schedule selects 03 Eastern in winter and summer and dispatches all on main', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/nightly-checks.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on.schedule.map(s => s.cron), ['7 7 * * *', '7 8 * * *']);
  assert.equal(workflow.jobs.nightly.steps[2].env.SCHEDULE, '${{ github.event.schedule }}');
  assert.equal(workflow.permissions.actions, 'write');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  for (const [yes, no] of [['2026-01-01T08:00Z', '2026-01-01T07:00Z'], ['2026-07-01T07:00Z', '2026-07-01T08:00Z']]) {
    assert.equal(easternSlot(new Date(yes)), true);
    assert.equal(easternSlot(new Date(no)), false);
  }
});
test('same SHA failures become flaky only when the retry succeeds, with both links', () => {
  const result = classify([
    { sha: 'abc', jobs: [job('flaky', 'failure', 1), job('broken', 'failure', 1)] },
    { sha: 'abc', jobs: [job('flaky', 'success', 2), job('broken', 'failure', 2)] },
  ]);
  assert.deepEqual(result.flakyJobs.map(j => j.name), ['flaky']);
  assert.deepEqual(result.failures.map(j => j.name), ['broken']);
  assert.deepEqual(result.flakyJobs[0].attempts.map(a => a.html_url), ['https://example/jobs/1', 'https://example/jobs/2']);
  assert.equal(result.runnerMinutes, 4);
  assert.throws(() => classify([{ sha: 'a', jobs: [] }, { sha: 'b', jobs: [] }]), /SHA/);
});
test('dispatch returns immediately and completion events classify one bounded rerun', async () => {
  const calls = [], artifacts = []; let attempt = 1, complete = true;
  const run = { id:7,event:'workflow_dispatch',head_branch:'main',path:'.github/workflows/checks.yml',
    display_title:'Nightly Checks 42',status:'completed',run_attempt:1,head_sha:'abc',html_url:'https://example/runs/7' };
  const api = async (method, endpoint, body) => {
    calls.push([method, endpoint, body]);
    if (endpoint.includes('unified-release')) return { workflow_runs: [] };
    if (endpoint === 'commits/main') return { sha: 'abc' };
    if (endpoint.endsWith('dispatches')) { assert.deepEqual(body, { ref:'main', inputs:{suite:'all',nightly_id:'42'} }); return; }
    if (endpoint.endsWith('rerun-failed-jobs')) { attempt=2;complete=false;return; }
    if (endpoint.endsWith('/logs')) return 'not ok 1 - failing test';
    if (endpoint.includes('/jobs?')) {
      const n=Number(endpoint.match(/attempts\/(\d+)/)[1]);
      return { total_count:1,jobs:[job('suite',n===1?'failure':'success',n)] };
    }
    if (endpoint.endsWith('/attempts/1')) return {...run,conclusion:'failure'};
    if (endpoint === 'actions/runs/7') return {...run,run_attempt:attempt,status:complete?'completed':'in_progress',conclusion:attempt===1?'failure':'success'};
    assert.fail(`Unexpected observation ${endpoint}`);
  };
  const save=a=>artifacts.push(a);
  const dispatched=await runNightly({api,save,manual:true,requestId:'42'});
  assert.equal(dispatched.dispatched,true);assert.equal(calls.length,3);
  const first=await finishNightly({api,run,save});
  assert.equal(first.rerunRequested,true);assert.equal(first.failures.length,1);
  const duplicate=await finishNightly({api,run,save});assert.equal(duplicate.skipped,true);
  complete=true;
  const result=await finishNightly({api,run:{...run,run_attempt:2},save});
  assert.equal(result.failures.length,0);assert.equal(result.flakyJobs.length,1);
  assert.deepEqual(result.flakyJobs[0].attempts[0].failingTests,['not ok 1 - failing test']);
  assert.equal(calls.filter(c=>c[1].endsWith('rerun-failed-jobs')).length,1);
  assert.equal(calls.filter(c=>c[1]==='actions/runs/7').length,3);
  assert.equal(artifacts.at(-1).attempts.length,2);
});
test('unrelated or untrusted completions cannot read results or request reruns',async()=>{
  const api=()=>assert.fail('No unrelated network observation');
  for(const run of [undefined,{event:'pull_request'}, {event:'workflow_dispatch',head_branch:'feature'},
    {event:'workflow_dispatch',head_branch:'main',path:'.github/workflows/checks.yml',display_title:'Checks',status:'completed'}])
    assert.equal(await finishNightly({api,run,save:()=>{}}),undefined);
});
test('status observation cannot loop while a completion is superseded',async()=>{
  let calls=0;
  const result=await finishNightly({save:()=>{},api:async()=>{calls++;return {run_attempt:2,status:'in_progress'};},
    run:{id:7,event:'workflow_dispatch',head_branch:'main',path:'.github/workflows/checks.yml',display_title:'Nightly Checks 42',status:'completed',run_attempt:1}});
  assert.equal(result.skipped,true);assert.equal(calls,1);
});
test('active release publishes an explicit skip without dispatching checks', async () => {
  const calls = [];
  const result = await runNightly({ manual: true, pause: () => {}, save: () => {}, api: async (...args) => {
    calls.push(args);
    return { workflow_runs: [{ status: 'in_progress', html_url: 'release' }] };
  } });
  assert.equal(result.skipped, true);
  assert.equal(calls.length, 1);
});
test('nightly result opens, updates and closes one issue per job for the fix loop', async () => {
  const issues = [
    { number: 1, title: 'Nightly Checks: steady is flaky' },
    { number: 2, title: 'Nightly Checks: fixed failed twice' },
    { number: 3, title: 'Nightly Checks: other failed twice' },
    { number: 4, title: 'Nightly Checks: the nightly run did not finish' },
    { number: 5, title: 'A pull request', pull_request: {} },
  ];
  const calls = [];
  const api = async (method, endpoint, body) => { calls.push([method, endpoint, body]); return method === 'GET' ? issues : {}; };
  const failing = { ...job('broken', 'failure', 1), failingTests: ['not ok 3 - sends'] };
  const result = classify([
    { sha: 'abc', jobs: [failing, job('steady', 'failure', 1), job('fixed', 'success', 1), job('other', 'skipped', 1)] },
    { sha: 'abc', jobs: [job('broken', 'failure', 2), job('steady', 'success', 2)] },
  ]);
  const actions = await publishIssues({ api, result, runUrl: 'https://example/runs/9' });
  assert.deepEqual(actions, [
    ['open', 'Nightly Checks: broken failed twice'],
    ['comment', 'Nightly Checks: steady is flaky'],
    ['close', 'Nightly Checks: fixed failed twice'],
    ['close', 'Nightly Checks: the nightly run did not finish'],
  ]);
  const opened = calls.find(([method, endpoint]) => method === 'POST' && endpoint === 'issues')[2];
  assert.deepEqual(opened.labels, ['nightly-checks']);
  assert.match(opened.body, /not ok 3 - sends/);
  assert.ok(calls.some(([method, endpoint, body]) => method === 'PATCH' && endpoint === 'issues/2' && body.state === 'closed'));
  // A skipped night changes nothing; an unfinished night is reported once.
  calls.length = 0;
  assert.deepEqual(await publishIssues({ api, result: { skipped: true }, runUrl: 'x' }), []);
  assert.equal(calls.length, 0);
  assert.deepEqual(await publishIssues({ api, result: { infrastructureError: 'boom' }, runUrl: 'x' }), [['comment', 'Nightly Checks: the nightly run did not finish']]);
});


test('dispatch and pending rerun do not publish premature failure issues', async () => {
  const api = async () => { throw new Error('No issue observation before terminal classification'); };
  assert.deepEqual(await publishIssues({api,result:{dispatched:true},runUrl:'https://example/run'}),[]);
  assert.deepEqual(await publishIssues({api,result:{rerunRequested:true,failures:[{name:'body'}]},runUrl:'https://example/run'}),[]);
  const workflow=parse(readFileSync(new URL('../.github/workflows/nightly-checks-result.yml',import.meta.url),'utf8'));
  assert.equal(workflow.permissions.issues,'write');
});
test('scheduled starts reject missed slots and quietly ignore DST twins, including delayed twins', async () => {
  for (const [date, schedule, late] of [
    ['2026-01-01T07:07Z', '7 7 * * *', false],
    ['2026-01-01T08:17Z', '7 7 * * *', false],
    ['2026-01-01T09:07Z', '7 8 * * *', true],
    ['2026-07-01T08:07Z', '7 8 * * *', false],
    ['2026-07-01T09:07Z', '7 8 * * *', false],
    ['2026-07-01T08:07Z', '7 7 * * *', true],
    ['2026-11-01T09:07Z', '7 8 * * *', true],
    ['2026-03-08T08:07Z', '7 7 * * *', true],
  ]) {
    const run = runNightly({ schedule, now: () => new Date(date), api: () => assert.fail('must not dispatch'), save: () => assert.fail('must not classify'), pause: () => {} });
    if (late) await assert.rejects(run, /missed the 03:00 America\/New_York slot/);
    else assert.equal(await run, undefined);
  }
});
test('correct scheduled trigger enters nightly controller in winter, summer and on DST transition dates', async () => {
  for (const [date, schedule] of [
    ['2026-01-01T08:07Z', '7 8 * * *'],
    ['2026-07-01T07:07Z', '7 7 * * *'],
    ['2026-03-08T07:07Z', '7 7 * * *'],
    ['2026-11-01T08:07Z', '7 8 * * *'],
  ]) {
    let calls = 0;
    await runNightly({ schedule, now: () => new Date(date), save: () => {}, api: async () => {
      calls++;
      return { workflow_runs: [{ status: 'in_progress' }] };
    } });
    assert.equal(calls, 1);
  }
});
