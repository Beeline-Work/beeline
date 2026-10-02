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
  return { name, filters, decide };
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

function runDecide(decide, outputs) {
  const env = {};
  for (const [key, expression] of Object.entries(decide.env)) {
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
      label: 'push-gateway-only',
      files: ['apps/push-gateway/src/index.ts'],
      runEverything: 'false',
      desktop: 'false',
      on: ['pushGateway', 'authImage'],
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
    'pushGateway',
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

test('packages and a path outside the four app trees still open every path-filtered suite', () => {
  const cases = [
    { label: 'packages-only', files: ['packages/api-contract/src/index.ts'] },
    { label: 'docs-only', files: ['docs/foo.md'] },
    { label: 'gate-app', files: ['apps/gate/src/index.ts'] },
    {
      label: 'mobile-plus-docs',
      files: ['apps/mobile/sources/scrubber.ts', 'docs/foo.md'],
    },
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
      'pushGateway',
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
