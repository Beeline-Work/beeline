import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { reportAdapterFailures } = createRequire(import.meta.url)('./acp-adapter-issue.cjs');

function fixture() {
  const issues = [], comments = [], labels = [];
  const github = {
    paginate: async (method, args) => {
      assert.equal(args.state, 'open');
      assert.equal(args.labels, 'adapter-compat');
      return issues.filter(issue => issue.state === 'open');
    },
    rest: {issues: {
      listForRepo() {},
      getLabel: async () => { if (!labels.length) throw Object.assign(new Error('not found'), {status: 404}); },
      createLabel: async data => { labels.push(data); },
      create: async data => {
        const issue = {...data, number: issues.length + 1, state: 'open'};
        issues.push(issue);
        return {data: issue};
      },
      createComment: async data => { comments.push(data); },
    }},
  };
  const context = {repo: {owner: 'test', repo: 'test'}, serverUrl: 'https://github.com', runId: 42};
  const programs = {dependencies: {
    '@openai/codex': {version: '0.106.0'},
    '@anthropic-ai/claude-code': {version: '2.1.0'},
    '@earendil-works/pi-coding-agent': {version: '0.60.0'},
  }};
  // Same shape emitted by check-acp-adapters.mjs; program is a path, not a version.
  const report = JSON.parse(`{"check":"acp-adapter-compatibility","results":[
    {"adapter":"@agentclientprotocol/codex-acp","version":"0.10.0","status":"failed","stage":"session/new","program":"/usr/local/bin/codex","error":"session/new timed out"},
    {"adapter":"@agentclientprotocol/claude-agent-acp","version":"0.20.0","status":"passed","stage":"complete","program":"/usr/local/bin/claude"},
    {"adapter":"pi-acp","version":"0.6.0","status":"failed","stage":"initialize","program":"/usr/local/bin/pi","error":"initialize failed"}
  ]}`);
  return {github, context, programs, report, issues, comments, labels};
}

test('files one labeled issue per failed adapter with exact program version, adapter version, stage and run link', async () => {
  const f = fixture();
  await reportAdapterFailures(f);
  assert.equal(f.issues.length, 2);
  assert.equal(f.labels.length, 1);
  assert.deepEqual(f.issues[0].labels, ['adapter-compat']);
  assert.equal(f.issues[0].title, 'ACP adapter compatibility: @agentclientprotocol/codex-acp@0.10.0 failed at session/new');
  assert.match(f.issues[0].body, /Program: @openai\/codex\nProgram version: 0.106.0/);
  assert.match(f.issues[0].body, /Adapter version: 0.10.0\nFailed stage: session\/new/);
  assert.match(f.issues[0].body, /https:\/\/github.com\/test\/test\/actions\/runs\/42/);
  assert.match(f.issues[0].body, /session\/new timed out/);
  assert.match(f.issues[1].body, /Program version: 0.60.0/);
});

test('repeat failures comment on the exact open title; new versions, stages and closed failures get separate issues', async () => {
  const f = fixture();
  f.report.results = [f.report.results[0]];
  await reportAdapterFailures(f);
  f.context.runId = 43;
  await reportAdapterFailures(f);
  assert.equal(f.issues.length, 1);
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].issue_number, 1);
  assert.match(f.comments[0].body, /actions\/runs\/43/);
  f.report.results[0].version = '0.11.0';
  await reportAdapterFailures(f);
  f.report.results[0].stage = 'initialize';
  await reportAdapterFailures(f);
  assert.equal(f.issues.length, 3);
  f.issues[2].state = 'closed';
  await reportAdapterFailures(f);
  assert.equal(f.issues.length, 4);
});

test('a passing report creates no label, issue or comment', async () => {
  const f = fixture();
  f.report.results = f.report.results.filter(result => result.status === 'passed');
  await reportAdapterFailures(f);
  assert.equal(f.labels.length, 0);
  assert.equal(f.issues.length, 0);
  assert.equal(f.comments.length, 0);
});

test('early adapter failures retain unknown versions and missing programs explicitly', async () => {
  const f = fixture();
  f.report.results = [{adapter: '@agentclientprotocol/claude-agent-acp', version: 'unknown', status: 'failed', stage: 'version', program: null}];
  f.programs = {dependencies: {}};
  await reportAdapterFailures(f);
  assert.match(f.issues[0].title, /@unknown failed at version$/);
  assert.match(f.issues[0].body, /Program: @anthropic-ai\/claude-code\nProgram version: unknown/);
});
