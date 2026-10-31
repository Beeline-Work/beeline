// The path filters in checks.yml and desktop.yml are the pull-request gate.
// dorny/paths-filter@v3 matches one file with `some` (any pattern) unless the
// step sets `predicate-quantifier: every` (every pattern). This runs those
// lists, then the workflow's own decide script, and prints the gates a
// changed-file list would open.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import picomatch from 'picomatch';
import { parse } from 'yaml';

const matchOptions = { dot: true };

function workflow(name) {
  const doc = parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
  const steps = doc.jobs.changes.steps;
  const filters = steps.filter(
    (step) => typeof step.uses === 'string' && step.uses.startsWith('dorny/paths-filter@'),
  );
  const decide = steps.find((step) => step.id === 'decide');
  assert.ok(decide?.run, `${name} has a decide script`);
  return { name, filters, decide, jobs: doc.jobs };
}

function patternsOf(entry) {
  assert.ok(Array.isArray(entry), 'filter entry is a list');
  assert.ok(entry.every((pattern) => typeof pattern === 'string'), 'filter patterns are strings');
  return entry;
}

function fileMatches(filename, patterns, quantifier) {
  const hit = (pattern) => picomatch(pattern, matchOptions)(filename);
  return quantifier === 'every' ? patterns.every(hit) : patterns.some(hit);
}

function filterOutputs(files, filterSteps) {
  const outputs = {};
  for (const step of filterSteps) {
    const quantifier = step.with?.['predicate-quantifier'] ?? 'some';
    assert.ok(quantifier === 'some' || quantifier === 'every', quantifier);
    const filters = parse(step.with.filters);
    for (const [name, entry] of Object.entries(filters)) {
      assert.equal(outputs[name], undefined, `filter ${name} is defined twice`);
      const patterns = patternsOf(entry);
      outputs[name] = files.some((file) => fileMatches(file, patterns, quantifier));
    }
  }
  return outputs;
}

function runDecide(decide, outputs, context = {}) {
  const env = {};
  for (const [key, expression] of Object.entries(decide.env)) {
    if (key === 'EVENT_NAME') {
      assert.equal(expression, '${{ github.event_name }}');
      env[key] = context.eventName ?? 'pull_request';
      continue;
    }
    if (key === 'FILTER_OUTCOME' || key === 'UNMAPPED_OUTCOME') {
      assert.match(expression, /steps\.(filter|unmapped)\.outcome/);
      env[key] = context[key] ?? 'success';
      continue;
    }
    const match = String(expression).match(/steps\.[A-Za-z0-9_-]+\.outputs\.([A-Za-z0-9_-]+)/);
    assert.ok(match, `${key} does not read a filter output: ${expression}`);
    assert.ok(Object.hasOwn(outputs, match[1]), `${key} reads missing output ${match[1]}`);
    env[key] = outputs[match[1]] ? 'true' : 'false';
  }
  const directory = mkdtempSync(join(tmpdir(), 'workflow-filter-'));
  const outputPath = join(directory, 'output');
  const summaryPath = join(directory, 'summary');
  writeFileSync(outputPath, '');
  writeFileSync(summaryPath, '');
  execFileSync('bash', ['-c', decide.run], {
    env: { ...env, GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath },
  });
  const gates = {};
  for (const line of readFileSync(outputPath, 'utf8').split('\n')) {
    if (!line) continue;
    const split = line.indexOf('=');
    assert.ok(split > 0, line);
    gates[line.slice(0, split)] = line.slice(split + 1);
  }
  const summary = readFileSync(summaryPath, 'utf8');
  const runEverything = summary.match(/^run_everything=(true|false)$/m);
  return { gates, runEverything: runEverything ? runEverything[1] : undefined };
}

function unmappedStep(parsed) {
  const holders = parsed.filters.filter((step) => {
    const filters = parse(step.with.filters);
    return Object.hasOwn(filters, 'unmapped');
  });
  assert.equal(holders.length, 1, `${parsed.name} defines unmapped once`);
  return holders[0];
}

function report(label, checks, desktop) {
  const gates = Object.entries(checks.gates)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ');
  console.log(
    `${label}: run_everything=${checks.runEverything} ${gates} desktop=${desktop.gates.desktop}`,
  );
}

const checksWorkflow = workflow('checks.yml');
const desktopWorkflow = workflow('desktop.yml');

test('unmapped is every, and only unmapped is every', () => {
  for (const parsed of [checksWorkflow, desktopWorkflow]) {
    const step = unmappedStep(parsed);
    assert.equal(step.with['predicate-quantifier'], 'every', parsed.name);
    const patterns = patternsOf(parse(step.with.filters).unmapped);
    assert.equal(patterns.includes('*'), false, `${parsed.name} unmapped still has a bare *`);
    assert.equal(Object.keys(parse(step.with.filters)).join(','), 'unmapped');
    for (const other of parsed.filters) {
      if (other === step) continue;
      assert.equal(other.with?.['predicate-quantifier'] ?? 'some', 'some', parsed.name);
    }
  }
});

function evaluate(files) {
  const checks = runDecide(checksWorkflow.decide, filterOutputs(files, checksWorkflow.filters));
  const desktop = runDecide(desktopWorkflow.decide, filterOutputs(files, desktopWorkflow.filters));
  return { checks, desktop };
}

test('a mapped tree opens only its own suites', () => {
  const cases = [
    {
      label: 'mobile-sources-only',
      files: ['apps/mobile/sources/scrubber.ts'],
      runEverything: 'false',
      desktop: 'false',
      on: ['mobileSuite', 'mobileExportReachability'],
    },
    {
      label: 'server-only',
      files: ['apps/server/src/index.ts'],
      runEverything: 'false',
      desktop: 'false',
      on: ['serverSuite', 'serverIntegration', 'productionCorpusReplay', 'authImage'],
    },
    {
      label: 'body-cli',
      files: ['apps/body/src/cli.ts'],
      runEverything: 'false',
      desktop: 'false',
      on: ['body', 'macHelper', 'authImage'],
    },
    {
      label: 'mobile-and-server',
      files: ['apps/mobile/sources/scrubber.ts', 'apps/server/src/index.ts'],
      runEverything: 'false',
      desktop: 'false',
      on: [
        'mobileSuite',
        'mobileExportReachability',
        'serverSuite',
        'serverIntegration',
        'productionCorpusReplay',
        'authImage',
      ],
    },
    {
      label: 'desktop-shell',
      files: ['apps/mobile/src-tauri/tauri.conf.json'],
      runEverything: 'false',
      desktop: 'true',
      on: ['mobileSuite', 'mobileExportReachability'],
    },
    {
      label: 'mobile-buzz-frame',
      files: ['apps/mobile/sources/buzz/x.ts'],
      runEverything: 'false',
      desktop: 'false',
      on: ['mobileSuite', 'mobileExportReachability', 'frameBudget', 'stateUpgrade'],
    },
  ];
  const gateNames = [
    'body',
    'serverSuite',
    'serverIntegration',
    'macHelper',

    'mobileSuite',
    'mobileExportReachability',
    'productionCorpusReplay',
    'frameBudget',
    'stateUpgrade',
    'nativeFingerprint',
    'readme',
    'appLinkAssociations',
    'workflows',
    'authImage',
  ];
  for (const item of cases) {
    const { checks, desktop } = evaluate(item.files);
    report(item.label, checks, desktop);
    assert.equal(checks.runEverything, item.runEverything, item.label);
    assert.equal(desktop.gates.desktop, item.desktop, item.label);
    for (const name of gateNames) {
      const expected = item.on.includes(name) ? 'true' : 'false';
      assert.equal(checks.gates[name], expected, `${item.label} ${name}`);
    }
  }
});

test('packages and unknown executable paths still open every path-filtered suite', () => {
  const cases = [
    { label: 'packages-only', files: ['packages/api-contract/src/index.ts'] },
    { label: 'unmapped-script', files: ['scripts/new-proof.mjs'] },
  ];
  for (const item of cases) {
    const { checks, desktop } = evaluate(item.files);
    report(item.label, checks, desktop);
    assert.equal(checks.runEverything, 'true', item.label);
    assert.equal(desktop.gates.desktop, 'true', item.label);
    assert.equal(checks.gates.macHelper, 'false', item.label);
    for (const name of [
      'body',
      'serverSuite',
      'serverIntegration',

      'mobileSuite',
      'mobileExportReachability',
      'productionCorpusReplay',
      'frameBudget',
      'stateUpgrade',
      'nativeFingerprint',
      'readme',
      'appLinkAssociations',
      'workflows',
      'authImage',
    ]) {
      assert.equal(checks.gates[name], 'true', `${item.label} ${name}`);
    }
  }
});

test('documentation does not fan out Checks suites', () => {
  for (const files of [['docs/foo.md'], ['AGENTS.md'], ['docs/foo.md', 'docs/bar.md']]) {
    const { checks } = evaluate(files);
    assert.equal(checks.runEverything, 'false');
    assert.ok(Object.values(checks.gates).every((value) => value === 'false'));
  }
  const mobile = evaluate(['apps/mobile/sources/scrubber.ts']).checks;
  const withDocs = evaluate(['apps/mobile/sources/scrubber.ts', 'docs/foo.md']).checks;
  assert.deepEqual(withDocs, mobile);
  assert.deepEqual(
    evaluate(['apps/server/src/index.ts', 'docs/foo.md']).checks,
    evaluate(['apps/server/src/index.ts']).checks,
  );
  const readme = evaluate(['README.md']).checks;
  assert.equal(readme.gates.readme, 'true');
  assert.equal(readme.gates.serverSuite, 'false');
  assert.equal(readme.gates.mobileSuite, 'false');
});

test('representative PRs request fewer hosted runners without hiding check contexts', () => {
  const examples = [
    { name: 'server-only', files: ['apps/server/src/index.ts'], before: 25, after: 14 },
    { name: 'mobile-only', files: ['apps/mobile/sources/buzz/x.ts'], before: 8, after: 8 },
    { name: 'mixed', files: ['apps/server/src/index.ts', 'apps/mobile/sources/buzz/x.ts'], before: 29, after: 18 },
    { name: 'mixed-components', files: ['apps/server/src/index.ts', 'apps/mobile/sources/components/example.tsx'], before: 27, after: 16 },
    { name: 'docs-only', files: ['docs/foo.md'], before: 34, after: 3 },
  ];
  for (const example of examples) {
    const { gates } = evaluate(example.files).checks;
    const needs = Object.fromEntries(Object.keys(checksWorkflow.jobs).map((name) => [name, { result: 'success', outputs: gates }]));
    let runners = 0;
    for (const job of Object.values(checksWorkflow.jobs)) {
      const expression = String(job.if ?? 'true').replace(/^\$\{\{\s*|\s*\}\}$/g, '')
        .replace(/needs\.([a-z][a-z0-9-]*)/g, "needs['$1']");
      const enabled = new Function('needs', 'github', 'inputs', 'cancelled', `return (${expression});`)(
        needs, { event_name: 'pull_request' }, { suite: '' }, () => false,
      );
      if (enabled) runners += job.strategy?.matrix?.shard?.length ?? 1;
    }
    console.log(`${example.name}: baseline=${example.before} current=${runners} runner jobs (skipped checks excluded)`);
    assert.equal(runners, example.after, example.name);
  }
});

test('PR concurrency cancels superseded pushes and isolates non-PR runs', () => {
  for (const name of ['checks', 'desktop', 'prompt-cases']) {
    const doc = parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
    assert.equal(doc.concurrency.group,
      `${name}-` + "${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.run_id }}");
    assert.equal(doc.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
  }
});
test('required workflows run merge groups and filter the group head against its base', () => {
  for (const name of ['checks.yml', 'desktop.yml', 'prompt-cases.yml']) {
    const doc = parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
    assert.deepEqual(doc.on.merge_group, { types: ['checks_requested'] }, name);
    assert.match(doc.jobs.changes.if, /merge_group/, name);
    const checkout = doc.jobs.changes.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with['fetch-depth'], 0, name);
    for (const filter of doc.jobs.changes.steps.filter(step => step.uses?.startsWith('dorny/paths-filter@'))) {
      assert.equal(filter.with.base, "${{ github.event.merge_group.base_sha || '' }}", name);
      assert.equal(filter.with.ref, "${{ github.event.merge_group.head_sha || '' }}", name);
    }
  }
});


test('a merge-group diff failure runs every suite instead of pruning from missing outputs', () => {
  const context = { eventName: 'merge_group', FILTER_OUTCOME: 'failure' };
  const checks = runDecide(checksWorkflow.decide, filterOutputs([], checksWorkflow.filters), context);
  const desktop = runDecide(desktopWorkflow.decide, filterOutputs([], desktopWorkflow.filters), context);
  assert.equal(checks.runEverything, 'true');
  assert.ok(Object.values(checks.gates).every(value => value === 'true'));
  assert.equal(desktop.gates.desktop, 'true');
});

test('merge groups execute both consolidated server shard steps', () => {
  const job = checksWorkflow.jobs['server-suite-shard'];
  const steps = job.steps.filter(step => step.name?.startsWith('Run '));
  assert.equal(steps.length, 2);
  for (const step of steps) {
    const expression = String(step.if).replace(/^\$\{\{\s*|\s*\}\}$/g, '');
    const enabled = new Function('github', 'inputs', 'cancelled', `return (${expression});`)(
      { event_name: 'merge_group' }, { suite: '' }, () => false,
    );
    assert.equal(enabled, true, step.name);
  }
});
