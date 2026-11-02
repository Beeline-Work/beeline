import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { compareReleasedRuntime, enforceReleasedRuntime } from './release-preflight-native.mjs';
const require = createRequire(import.meta.url);
const { triageFailure, validateRunnerResults } = require('./release-preflight.cjs');

test('forced release failure creates exactly one triage issue even after redelivery and closure', async () => {
  const issues = [];
  const github = {
    paginate: async () => issues,
    rest: { issues: {
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
  const github={paginate:async()=>{lists++;return [];},rest:{issues:{listForRepo(){},getLabel:async()=>({}),
    create:async()=>{creates++;return receipt;}}}};
  const args={github,context:{repo:{}},run:{id:99,path:'.github/workflows/release-preflight.yml',conclusion:'failure'}};
  assert.equal(await triageFailure(args),receipt);assert.equal(lists,1);assert.equal(creates,1);
  github.rest.issues.create=async()=>{creates++;throw new Error('ambiguous mutation');};
  await assert.rejects(triageFailure(args),/ambiguous mutation/);assert.equal(creates,2);
  assert.doesNotMatch(readFileSync('scripts/release-preflight.cjs','utf8'),/setTimeout|setInterval|watchRunners/);
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
