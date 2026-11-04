import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { compareReleasedRuntime, enforceReleasedRuntime } from './release-preflight-native.mjs';
const require = createRequire(import.meta.url);
const { triageFailure, validateRunnerResults, recoverFailures } = require('./release-preflight.cjs');

test('forced release failure creates exactly one triage issue even after redelivery and closure', async () => {
  const issues = [];
  const failedJobs = [{name: 'server', conclusion: 'failure'}, {name: 'website', conclusion: 'success'}, {name: 'helper', conclusion: 'skipped'}];
  const github = {
    paginate: async method => method === github.rest.actions.listJobsForWorkflowRun ? failedJobs : issues,
    rest: { actions: { listJobsForWorkflowRun() {} }, issues: {
      listForRepo() {}, getLabel: async () => ({}),
      create: async data => { issues.push(data); return data; },
    } },
  };
  const context = { repo: { owner: 'test', repo: 'test' } };
  const run = { id: 123, path: '.github/workflows/unified-release.yml', name: 'Unified production release', conclusion: 'failure', html_url: 'https://github.com/test/test/actions/runs/123', head_sha: 'a'.repeat(40), run_attempt: 1 };
  await triageFailure({ github, context, run });
  issues[0].state = 'closed';
  await triageFailure({ github, context, run });
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].labels, ['release-failure']);
  assert.match(issues[0].body, /<!-- release-failed-jobs:\["server"\] -->/);
  assert.match(issues[0].body, /Failed jobs: server/);
  await triageFailure({ github, context, run: {...run, id: 124, conclusion: 'cancelled', path: '.github/workflows/release-preflight.yml' } });
  assert.equal(issues.length, 2);
  await triageFailure({ github, context, run: {...run, id: 125, conclusion: 'success' } });
  assert.equal(issues.length, 2);
});

test('runner completion inspects once and fails closed for incomplete or failed probes', async () => {
  let reads=0;
  let jobs=[{name:'Runner probe android',status:'queued'}];
  const github={paginate:async()=>{reads++;return jobs;},rest:{actions:{listJobsForWorkflowRun(){}}}};
  const context={repo:{},runId:42},core={info(){}};
  await assert.rejects(validateRunnerResults({github,context,core}),/completion is unavailable/);
  assert.equal(reads,1);
  jobs=['production','android','ios'].map(label=>({name:`Runner probe ${label}`,status:'completed',conclusion:'success'}));
  await validateRunnerResults({github,context,core});assert.equal(reads,2);
  jobs[0].conclusion='failure';
  await assert.rejects(validateRunnerResults({github,context,core}),/probes failed/);assert.equal(reads,3);
  const workflow=readFileSync('.github/workflows/release-preflight.yml','utf8');
  assert.match(workflow,/runners_online:\n    needs: runner\n    if: always\(\)/);
});

test('compares native fingerprints and shipped pins independently for each platform', () => {
  const baseline = {android: {runtimeVersion:'39'}, ios:{runtimeVersion:'36'}, fingerprints:{android:'a',ios:'b'}};
  assert.ok(compareReleasedRuntime(baseline,baseline).every(r=>r.ok));
  const changed = {...baseline, android:{runtimeVersion:'40'}, fingerprints:{android:'c',ios:'b'}};
  assert.deepEqual(compareReleasedRuntime(changed,baseline).map(r=>r.ok), [false,true]);
  assert.equal(compareReleasedRuntime({...baseline,fingerprints:{android:'c',ios:'b'}},baseline)[0].ok,false);
});

test('each shell-bearing self-hosted release job installs pinned Node before its first command or composite', () => {
  const workflow = readFileSync('.github/workflows/unified-release.yml','utf8');
  const jobs = workflow.split(/\n  [a-z_]+:\n/).slice(1);
  for (const job of jobs.filter(job => /self-hosted/.test(job) && /\n        run:|\n      - run:/.test(job))) {
    const firstRun = job.search(/\n        run:|\n      - run:|uses: \.\//);
    const setup = job.indexOf('uses: actions/setup-node@v4');
    assert.ok(setup > 0 && setup < firstRun, job.slice(0,120));
    assert.match(job.slice(setup,firstRun), /node-version: 22/);
  }
});

test('failure intake accepts the mutation receipt without polling stale issue listings', async () => {
  let lists=0,creates=0;
  const receipt={data:{number:42}};
  const github={paginate:async method=>{if(method===github.rest.issues.listForRepo)lists++;return [];},rest:{actions:{listJobsForWorkflowRun(){}},issues:{listForRepo(){},getLabel:async()=>({}),
    create:async()=>{creates++;return receipt;}}}};
  const args={github,context:{repo:{}},run:{id:99,path:'.github/workflows/release-preflight.yml',conclusion:'failure'}};
  assert.equal(await triageFailure(args),receipt);assert.equal(lists,1);assert.equal(creates,1);
  github.rest.issues.create=async()=>{creates++;throw new Error('ambiguous mutation');};
  await assert.rejects(triageFailure(args),/ambiguous mutation/);assert.equal(creates,2);
  assert.doesNotMatch(readFileSync('scripts/release-preflight.cjs','utf8'),/setTimeout|setInterval|watchRunners/);
});

function recoveryFixture() {
  const issues = [], comments = [], updates = [];
  let failClose = false;
  const jobs = [{name: 'server', conclusion: 'success'}, {name: 'helper', conclusion: 'skipped'}, {name: 'website', conclusion: 'success'}];
  const run = {id: 200, path: '.github/workflows/unified-release.yml', conclusion: 'success', run_started_at: '2026-11-02T05:00:00Z', html_url: 'https://github.com/test/test/actions/runs/200'};
  const context = {repo: {owner: 'test', repo: 'test'}, payload: {workflow_run: run}};
  const github = {
    rest: {
      actions: {listJobsForWorkflowRun() {}},
      issues: {
        listForRepo() {}, listComments() {},
        createComment: async data => { comments.push(data); },
        update: async data => {
          if (failClose) { failClose = false; throw new Error('close failed'); }
          updates.push(data);
          issues.find(issue => issue.number === data.issue_number).state = data.state;
        },
      },
    },
    paginate: async (method, args) => {
      if (method === github.rest.actions.listJobsForWorkflowRun) {
        assert.equal(args.filter, 'latest');
        return jobs;
      }
      if (method === github.rest.issues.listComments) return comments.filter(comment => comment.issue_number === args.issue_number);
      assert.equal(args.state, 'open');
      assert.equal(args.labels, 'release-failure');
      return issues.filter(issue => issue.state === 'open');
    },
  };
  const add = (title, failedJobs, extra = {}) => {
    const issue = {number: issues.length + 1, state: 'open', created_at: '2026-11-01T05:00:00Z', title,
      body: failedJobs === undefined ? 'Old failure' : `<!-- release-failed-jobs:${JSON.stringify(failedJobs)} -->`, ...extra};
    issues.push(issue);
    return issue;
  };
  return {github, context, run, issues, jobs, comments, updates, add, failNextClose: () => { failClose = true; }};
}

test('successful preflight closes all earlier preflight issues with recovery links, leaving release failures open', async () => {
  const f = recoveryFixture();
  f.run.path = '.github/workflows/release-preflight.yml';
  f.add('Release preflight: failure (run 100)');
  f.add('Release preflight: cancelled (run 101)');
  f.add('Unified production release: failure (run 102)', ['server']);
  await recoverFailures(f);
  assert.deepEqual(f.issues.map(issue => issue.state), ['closed', 'closed', 'open']);
  assert.equal(f.comments.length, 2);
  assert.ok(f.comments.every(comment => comment.body.includes(f.run.html_url)));
  assert.ok(f.updates.every(update => update.state_reason === 'completed'));
});

test('unified recovery requires every recorded failed job to succeed; skipped or absent jobs keep issues open', async () => {
  const f = recoveryFixture();
  f.add('Unified production release: failure (run 100)', ['server', 'website']);
  f.add('Production release · @firstmate · receipt: failure (run 101)', ['website']);
  f.add('Unified production release: failure (run 102)', ['server', 'helper']);
  f.add('Unified production release: failure (run 103)', ['mobile_native_ios']);
  f.add('Release preflight: failure (run 104)', ['native']);
  await recoverFailures(f);
  assert.deepEqual(f.issues.map(issue => issue.state), ['closed', 'closed', 'open', 'open', 'open']);
  assert.equal(f.comments.length, 2);
});

test('OTA-only success never closes a preflight issue', async () => {
  const f = recoveryFixture();
  f.jobs.splice(0, f.jobs.length, {name: 'mobile_ota', conclusion: 'success'});
  f.add('Release preflight: failure (run 100)', ['Native fingerprint and released runtime']);
  await recoverFailures(f);
  assert.equal(f.issues[0].state, 'open');
  assert.equal(f.comments.length, 0);
});

test('legacy unified failures require all component jobs to succeed without skips', async () => {
  const f = recoveryFixture();
  f.add('Unified production release: failure (run 100)');
  await recoverFailures(f);
  assert.equal(f.issues[0].state, 'open');
  f.jobs[1].conclusion = 'success';
  f.jobs.push({name: 'release_proof', conclusion: 'skipped'});
  await recoverFailures(f);
  assert.equal(f.issues[0].state, 'closed');
});

test('recovery leaves newer issues, unrelated issues and pull requests untouched', async () => {
  const f = recoveryFixture();
  f.add('Unified production release: failure (run 100)', ['server'], {created_at: f.run.run_started_at});
  f.add('Unified production release: failure (run 101)', ['server'], {created_at: '2026-11-02T05:01:00Z'});
  f.add('Unrelated failure', ['server']);
  f.add('Unified production release: failure (run 102)', ['server'], {pull_request: {}});
  await recoverFailures(f);
  assert.equal(f.updates.length, 0);
  assert.equal(f.comments.length, 0);
});

test('recovery is idempotent on redelivery and reruns, including a retry after comment creation', async () => {
  const f = recoveryFixture();
  f.add('Unified production release: failure (run 100)', ['server']);
  f.failNextClose();
  await assert.rejects(recoverFailures(f), /close failed/);
  await recoverFailures(f);
  await recoverFailures(f);
  f.run.run_attempt = 2;
  await recoverFailures(f);
  assert.equal(f.comments.length, 1);
  assert.equal(f.updates.length, 1);
});

test('recovery ignores unsuccessful and unrelated workflow runs', async () => {
  const f = recoveryFixture();
  f.add('Unified production release: failure (run 100)', ['server']);
  f.run.conclusion = 'failure';
  await recoverFailures(f);
  f.run.conclusion = 'success';
  f.run.path = '.github/workflows/checks.yml';
  await recoverFailures(f);
  assert.equal(f.updates.length, 0);
});


test('native preflight fails unshipped runtimes; diagnostic mode can warn', () => {
  const results = [{platform:'android', ok:false}, {platform:'ios', ok:true}];
  assert.throws(() => enforceReleasedRuntime(results), /store build/);
  const warnings = [];
  enforceReleasedRuntime(results, {reportOnly:true, warn:message=>warnings.push(message)});
  assert.match(warnings[0], /::warning::.*store build/);
  const workflow = readFileSync('.github/workflows/release-preflight.yml','utf8');
  assert.doesNotMatch(workflow, /pull_request|PREFLIGHT_REPORT_ONLY/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /continue-on-error/);
});
