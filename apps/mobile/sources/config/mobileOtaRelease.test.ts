import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const mobileRoot = resolve(__dirname, '../..');
const releaseScript = join(mobileRoot, 'scripts/ota-release.mjs');
const deliveryIndexScript = readFileSync(
  join(mobileRoot, 'scripts/ota-delivery-index.mjs'),
  'utf8',
);
const canaryScript = readFileSync(join(mobileRoot, 'scripts/ota-canary.sh'), 'utf8');
const maestroScript = readFileSync(join(mobileRoot, 'scripts/maestro-e2e.sh'), 'utf8');
const workflow = readFileSync(
  resolve(mobileRoot, '../../.github/workflows/mobile-ota.yml'),
  'utf8',
);
const postPromoteWorkflow = readFileSync(
  resolve(mobileRoot, '../../.github/workflows/mobile-ota-post-promote.yml'),
  'utf8',
);
const reconcileWorkflow = readFileSync(
  resolve(mobileRoot, '../../.github/workflows/mobile-ota-reconcile.yml'),
  'utf8',
);
const rollbackWorkflow = readFileSync(
  resolve(mobileRoot, '../../.github/workflows/mobile-ota-rollback.yml'),
  'utf8',
);

function runRelease(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [releaseScript, ...args], {
    cwd: mobileRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('mobile OTA release governor', () => {
  it('dry-runs beta publish and exact-group production operations with pinned EAS CLI', () => {
    const publish = runRelease([
      'publish',
      '--dry-run',
      '--sha',
      '1234567890abcdef',
      '--ref',
      'main',
      '--ledger',
      '/tmp/unused-ledger.json',
    ]);
    expect(publish.status).toBe(0);
    expect(publish.stdout).toContain('eas-cli@22.2.0 channel:view beta');
    expect(publish.stdout).toContain('eas-cli@22.2.0 update --branch beta');
    expect(publish.stdout).not.toMatch(/update --branch production/);

    const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-dry-run-'));
    const ledger = join(directory, 'ledger.json');
    writeFileSync(
      ledger,
      JSON.stringify({
        status: 'beta',
        sourceSha: '1234567890abcdef',
        candidateGroupId: 'candidate-group',
        canary: { status: 'passed' },
      }),
    );
    const promote = runRelease(['promote', '--dry-run', '--ledger', ledger]);
    expect(promote.status).toBe(0);
    expect(promote.stdout).toContain(
      'update:republish --group candidate-group --destination-branch production',
    );
    const rollback = runRelease([
      'rollback',
      '--dry-run',
      '--group',
      'known-good-group',
      '--ledger',
      ledger,
    ]);
    expect(rollback.status).toBe(0);
    expect(rollback.stdout).toContain(
      'update:republish --group known-good-group --destination-branch production',
    );
    const guardedRollback = runRelease([
      'rollback',
      '--dry-run',
      '--group',
      'known-good-group',
      '--expected-current-group',
      'failed-production-group',
      '--ledger',
      ledger,
    ]);
    expect(guardedRollback.status).toBe(0);
    expect(guardedRollback.stdout).toContain('update:list --branch production');
    expect(guardedRollback.stdout).toContain(
      'update:republish --group known-good-group --destination-branch production',
    );
  }, 60_000);

  it('refuses production promotion while the canary is still pending', () => {
    const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-pending-'));
    const ledger = join(directory, 'ledger.json');
    writeFileSync(
      ledger,
      JSON.stringify({
        status: 'beta',
        sourceSha: '1234567890abcdef',
        candidateGroupId: 'candidate-group',
        canary: { status: 'pending' },
      }),
    );

    const result = runRelease(['promote', '--ledger', ledger]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing production promotion');
  }, 60_000);

  it('records the predecessor, canary proof, and republished production group', () => {
    const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-ledger-'));
    const ledgerPath = join(directory, 'ledger.json');
    const fakeEas = join(directory, 'fake-eas.sh');
    writeFileSync(
      fakeEas,
      `#!/bin/sh
case "$1" in
  channel:view|channel:edit) printf '{}\\n' ;;
  update:list) printf '[{"id":"prod-android","platform":"android","group":"known-good","runtimeVersion":"21"}]\\n' ;;
  update) printf '[{"id":"beta-android","platform":"android","group":"candidate-group","runtimeVersion":"21"},{"id":"beta-ios","platform":"ios","group":"candidate-group","runtimeVersion":"21"}]\\n' ;;
  update:republish) printf '[{"id":"prod-next-android","platform":"android","group":"production-group","runtime":{"version":"21"}},{"id":"prod-next-ios","platform":"ios","group":"production-group","runtime":{"version":"21"}}]\\n' ;;
  *) exit 9 ;;
esac
`,
    );
    chmodSync(fakeEas, 0o755);
    const env = { EAS_CLI_PATH: fakeEas };

    expect(
      runRelease(
        ['publish', '--sha', '1234567890abcdef', '--ref', 'main', '--ledger', ledgerPath],
        env,
      ).status,
    ).toBe(0);
    expect(
      runRelease(['mark-canary', '--ledger', ledgerPath, '--status', 'passed'], env).status,
    ).toBe(0);
    expect(runRelease(['promote', '--ledger', ledgerPath], env).status).toBe(0);

    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    expect(ledger).toMatchObject({
      status: 'production',
      candidateGroupId: 'candidate-group',
      androidUpdateId: 'beta-android',
      previousProductionGroupId: 'known-good',
      canary: { status: 'passed' },
      production: {
        sourceGroupId: 'candidate-group',
        groupId: 'production-group',
      },
    });
  }, 60_000);

  it('fails loudly unless the ledger and delivery index prove exact production promotion', () => {
    const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-assert-promotion-'));
    const ledgerPath = join(directory, 'ledger.json');
    const indexPath = join(directory, 'index.json');
    const sha = 'a'.repeat(40);
    const production = {
      sourceGroupId: 'candidate-group',
      groupId: 'production-group',
      updates: [
        { id: 'prod-android', platform: 'android' },
        { id: 'prod-ios', platform: 'ios' },
      ],
    };
    writeFileSync(ledgerPath, JSON.stringify({
      status: 'production',
      sourceSha: sha,
      candidateGroupId: 'candidate-group',
      production,
    }));
    writeFileSync(indexPath, JSON.stringify({
      schemaVersion: 1,
      merges: [{ sha, state: 'published', published: { groupId: 'production-group' } }],
    }));

    const proved = runRelease([
      'assert-promotion', '--ledger', ledgerPath, '--index', indexPath,
    ]);
    expect(proved.status).toBe(0);
    expect(proved.stdout).toContain('production_group_id=production-group');
    expect(proved.stdout).toContain(`source_sha=${sha}`);

    writeFileSync(indexPath, JSON.stringify({
      schemaVersion: 1,
      merges: [{ sha, state: 'built' }],
    }));
    const missing = runRelease([
      'assert-promotion', '--ledger', ledgerPath, '--index', indexPath,
    ]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('does not prove that the current main head was published');
  });

  it('never lets a stale failed canary roll back a newer production group', () => {
    const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-guarded-rollback-'));
    const ledgerPath = join(directory, 'rollback.json');
    const callsPath = join(directory, 'calls.log');
    const fakeEas = join(directory, 'fake-eas.sh');
    writeFileSync(
      fakeEas,
      `#!/bin/sh
printf '%s\\n' "$*" >> "${callsPath}"
case "$1" in
  update:list) printf '[{"id":"new-android","platform":"android","group":"newer-production"}]\\n' ;;
  update:republish) printf '[{"id":"rollback-android","platform":"android","group":"rollback-group"},{"id":"rollback-ios","platform":"ios","group":"rollback-group"}]\\n' ;;
  *) exit 9 ;;
esac
`,
    );
    chmodSync(fakeEas, 0o755);

    const result = runRelease([
      'rollback', '--group', 'known-good', '--expected-current-group', 'failed-production',
      '--ledger', ledgerPath,
    ], { EAS_CLI_PATH: fakeEas });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Rollback skipped');
    expect(readFileSync(callsPath, 'utf8')).not.toContain('update:republish');
    expect(JSON.parse(readFileSync(ledgerPath, 'utf8'))).toMatchObject({
      status: 'rollback-skipped-superseded',
      expectedCurrentGroupId: 'failed-production',
      observedCurrentGroupId: 'newer-production',
    });
  });

  it('records an automatic rollback only when the failed group is still production', () => {
    const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-automatic-rollback-'));
    const ledgerPath = join(directory, 'rollback.json');
    const fakeEas = join(directory, 'fake-eas.sh');
    writeFileSync(
      fakeEas,
      `#!/bin/sh
case "$1" in
  update:list) printf '[{"id":"failed-android","platform":"android","group":"failed-production"}]\\n' ;;
  update:republish) printf '[{"id":"rollback-android","platform":"android","group":"rollback-group"},{"id":"rollback-ios","platform":"ios","group":"rollback-group"}]\\n' ;;
  *) exit 9 ;;
esac
`,
    );
    chmodSync(fakeEas, 0o755);

    const result = runRelease([
      'rollback', '--group', 'known-good', '--expected-current-group', 'failed-production',
      '--ledger', ledgerPath,
    ], { EAS_CLI_PATH: fakeEas });

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(ledgerPath, 'utf8'))).toMatchObject({
      status: 'rolled-back',
      sourceGroupId: 'known-good',
      productionGroupId: 'rollback-group',
    });
  });

  it('fails closed before republishing when the guarded current-group query is unavailable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-rollback-query-failure-'));
    const ledgerPath = join(directory, 'rollback.json');
    const callsPath = join(directory, 'calls.log');
    const fakeEas = join(directory, 'fake-eas.sh');
    writeFileSync(
      fakeEas,
      `#!/bin/sh
printf '%s\\n' "$*" >> "${callsPath}"
case "$1" in
  update:list) echo 'project config unavailable' >&2; exit 1 ;;
  update:republish) echo 'rollback must never reach this command' >&2; exit 9 ;;
  *) exit 9 ;;
esac
`,
    );
    chmodSync(fakeEas, 0o755);

    const result = runRelease([
      'rollback', '--group', 'known-good', '--expected-current-group', 'failed-production',
      '--ledger', ledgerPath,
    ], { EAS_CLI_PATH: fakeEas });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EAS command failed');
    expect(readFileSync(callsPath, 'utf8')).toContain('update:list');
    expect(readFileSync(callsPath, 'utf8')).not.toContain('update:republish');
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it('tracks every merge through pending, built, published, and physical-device confirmation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-delivery-index-'));
    const ledgerPath = join(directory, 'ledger.json');
    const indexPath = join(directory, 'index.json');
    const commitsPath = join(directory, 'commits.json');
    const receiptPath = join(directory, 'receipt.json');
    const fakeEas = join(directory, 'fake-eas.sh');
    const firstSha = '1'.repeat(40);
    const headSha = '2'.repeat(40);
    writeFileSync(commitsPath, JSON.stringify([{ sha: firstSha }, { sha: headSha }]));
    writeFileSync(
      fakeEas,
      `#!/bin/sh
case "$1" in
  channel:view|channel:edit) printf '{}\\n' ;;
  update:list) printf '[{"id":"old-android","platform":"android","group":"known-good"}]\\n' ;;
  update) printf '[{"id":"beta-android","platform":"android","group":"candidate-group"},{"id":"beta-ios","platform":"ios","group":"candidate-group"}]\\n' ;;
  update:republish) printf '[{"id":"prod-android","platform":"android","group":"production-group"},{"id":"prod-ios","platform":"ios","group":"production-group"}]\\n' ;;
  *) exit 9 ;;
esac
`,
    );
    chmodSync(fakeEas, 0o755);
    const env = { EAS_CLI_PATH: fakeEas };

    expect(runRelease([
      'init-delivery', '--sha', headSha, '--ref', 'main', '--run-id', 'run-1',
      '--attempt', '1', '--commits', commitsPath, '--ledger', ledgerPath, '--index', indexPath,
    ], env).status).toBe(0);
    expect(JSON.parse(readFileSync(indexPath, 'utf8')).merges.map((merge: { state: string }) => merge.state))
      .toEqual(['pending', 'pending']);

    expect(runRelease([
      'publish', '--sha', headSha, '--ref', 'main', '--ledger', ledgerPath, '--index', indexPath,
    ], env).status).toBe(0);
    expect(JSON.parse(readFileSync(indexPath, 'utf8')).merges.at(-1).state).toBe('built');
    expect(runRelease(['mark-canary', '--ledger', ledgerPath, '--status', 'passed'], env).status).toBe(0);
    expect(runRelease(['promote', '--ledger', ledgerPath, '--index', indexPath], env).status).toBe(0);
    expect(JSON.parse(readFileSync(indexPath, 'utf8')).merges.map((merge: { state: string }) => merge.state))
      .toEqual(['published', 'published']);

    writeFileSync(receiptPath, JSON.stringify({ devices: [{
      deviceId: 'owner-device',
      updateId: 'prod-android',
      channel: 'production',
      group: null,
      environment: 'physical',
      reportedAt: '2026-08-29T20:05:00.000Z',
    }] }));
    expect(runRelease([
      'confirm', '--ledger', ledgerPath, '--index', indexPath, '--receipt', receiptPath,
      '--group', 'production-group', '--update-ids', 'prod-android,prod-ios',
    ], env).status).toBe(0);
    expect(JSON.parse(readFileSync(indexPath, 'utf8')).merges.map((merge: { state: string }) => merge.state))
      .toEqual(['confirmed', 'confirmed']);
    expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).delivery.state).toBe('confirmed');
  }, 60_000);

  it('classifies failed attempts and keeps every undelivered merge queryable for escalation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-failures-'));
    const ledgerPath = join(directory, 'ledger.json');
    const indexPath = join(directory, 'index.json');
    const undeliveredPath = join(directory, 'undelivered.json');
    const sha = '3'.repeat(40);
    const failures = [
      ['2', 'runner setup failed', 'environment-setup'],
      ['124', 'canary deadline', 'deadline'],
      ['1', 'SMOKE ROOM SEND timed out', 'smoke-timeout'],
    ];
    failures.forEach(([exitCode, reason], offset) => {
      const attempt = String(offset + 1);
      expect(runRelease([
        'init-delivery', '--sha', sha, '--ref', 'main', '--run-id', `run-${attempt}`,
        '--attempt', attempt, '--ledger', ledgerPath, '--index', indexPath,
      ]).status).toBe(0);
      expect(runRelease([
        'record-failure', '--sha', sha, '--run-id', `run-${attempt}`, '--attempt', attempt,
        '--exit-code', exitCode, '--reason', reason, '--ledger', ledgerPath, '--index', indexPath,
      ]).status).toBe(0);
    });
    expect(runRelease([
      'list-undelivered', '--index', indexPath, '--output', undeliveredPath,
    ]).status).toBe(0);
    const [merge] = JSON.parse(readFileSync(undeliveredPath, 'utf8')).undelivered;
    expect(merge.state).toBe('pending');
    expect(merge.failures.map((failure: { class: string }) => failure.class)).toEqual(
      failures.map((failure) => failure[2]),
    );
    expect(workflow).toContain("title: 'Undelivered merges'");
    expect(workflow).toContain('if (attempt >= 3)');
    expect(workflow).toContain('createWorkflowDispatch');
    expect(workflow).not.toContain('maxFailures < 3');
    expect(workflow).toContain("else await github.rest.issues.create");
    expect(deliveryIndexScript).toContain("['merge-base', '--is-ancestor', lastTracked, head]");
    expect(deliveryIndexScript).toContain('`${rangeStart}..${head}`');
  }, 60_000);

  it('discovers every untracked commit behind the delivery-index boundary', () => {
    const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-commit-range-'));
    const ledgerPath = join(directory, 'ledger.json');
    const indexPath = join(directory, 'index.json');
    const before = spawnSync('git', ['rev-parse', 'HEAD~2'], {
      cwd: mobileRoot,
      encoding: 'utf8',
    }).stdout.trim();
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: mobileRoot,
      encoding: 'utf8',
    }).stdout.trim();
    const expected = spawnSync('git', ['rev-list', '--reverse', `${before}..${head}`], {
      cwd: mobileRoot,
      encoding: 'utf8',
    }).stdout.trim().split(/\s+/);

    expect(runRelease([
      'init-delivery', '--sha', head, '--ref', 'main', '--run-id', 'range-run',
      '--before', before, '--ledger', ledgerPath, '--index', indexPath,
    ]).status).toBe(0);

    expect(JSON.parse(readFileSync(indexPath, 'utf8')).merges.map((merge: { sha: string }) => merge.sha))
      .toEqual(expected);
    expect(workflow).toContain('--before "$PUSH_BEFORE"');
    expect(workflow).not.toContain("require('node:child_process')");
  });

  it('accepts dispatch delivery initialization without a push before sha', () => {
    const before = spawnSync('git', ['rev-parse', 'HEAD~2'], {
      cwd: mobileRoot,
      encoding: 'utf8',
    }).stdout.trim();
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: mobileRoot,
      encoding: 'utf8',
    }).stdout.trim();
    const expected = spawnSync('git', ['rev-list', '--reverse', `${before}..${head}`], {
      cwd: mobileRoot,
      encoding: 'utf8',
    }).stdout.trim().split(/\s+/);

    for (const [name, beforeArgs] of [
      ['push', ['--before', before]],
      ['dispatch-empty', ['--before', '']],
      ['dispatch-omitted', []],
    ]) {
      const directory = mkdtempSync(join(tmpdir(), `beeline-ota-${name}-before-`));
      const ledgerPath = join(directory, 'ledger.json');
      const indexPath = join(directory, 'index.json');
      writeFileSync(indexPath, JSON.stringify({ schemaVersion: 1, merges: [{ sha: before }] }));

      const result = runRelease([
        'init-delivery', '--sha', head, '--ref', 'main', '--run-id', `${name}-run`,
        ...beforeArgs, '--ledger', ledgerPath, '--index', indexPath,
      ]);

      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(indexPath, 'utf8')).merges.slice(1).map(
        (merge: { sha: string }) => merge.sha,
      )).toEqual(expected);
    }
  });

  it('selects only the newest published delivery for receipt reconciliation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-delivery-target-'));
    const indexPath = join(directory, 'index.json');
    const index = {
      schemaVersion: 1,
      merges: [
        { sha: '1'.repeat(40), state: 'confirmed', published: { groupId: 'old', updateIds: ['old-id'] } },
        { sha: '2'.repeat(40), state: 'published', published: { groupId: 'current', updateIds: ['android', 'ios'] } },
        { sha: '3'.repeat(40), state: 'built' },
      ],
    };
    writeFileSync(indexPath, JSON.stringify(index));

    const result = runRelease(['delivery-target', '--index', indexPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('group_id=current\nupdate_ids=android,ios\n');
    expect(`${workflow}\n${reconcileWorkflow}`.match(/ota-release\.mjs delivery-target/g)).toHaveLength(2);

    index.merges[1].state = 'confirmed';
    writeFileSync(indexPath, JSON.stringify(index));
    expect(runRelease(['delivery-target', '--index', indexPath]).stdout).toBe(
      'group_id=\nupdate_ids=\n',
    );
  });

  it('rebases receipt confirmation onto a concurrent release without dropping its merges', () => {
    const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-reconcile-race-'));
    const basePath = join(directory, 'base.json');
    const overlayPath = join(directory, 'overlay.json');
    const outputPath = join(directory, 'output.json');
    const overlayOnlySha = '4'.repeat(40);
    const staleSha = '5'.repeat(40);
    const matchingSha = '6'.repeat(40);
    const newSha = '7'.repeat(40);
    writeFileSync(basePath, JSON.stringify({
      schemaVersion: 1,
      merges: [
        { sha: staleSha, state: 'published', published: { groupId: 'new-group' } },
        { sha: matchingSha, state: 'published', published: { groupId: 'same-group' } },
        { sha: newSha, state: 'published', published: { groupId: 'new-group' } },
      ],
    }));
    writeFileSync(overlayPath, JSON.stringify({
      schemaVersion: 1,
      merges: [
        { sha: overlayOnlySha, state: 'confirmed', confirmed: { groupId: 'old-group' } },
        {
          sha: staleSha,
          state: 'confirmed',
          confirmed: { groupId: 'old-group', deviceId: 'owner-device' },
        },
        {
          sha: matchingSha,
          state: 'confirmed',
          confirmed: { groupId: 'same-group', deviceId: 'owner-device' },
        },
      ],
    }));

    const result = runRelease([
      'merge-reconciliation', '--base', basePath, '--overlay', overlayPath, '--output', outputPath,
    ]);

    expect(result.status).toBe(0);
    const merged = JSON.parse(readFileSync(outputPath, 'utf8'));
    expect(merged.merges).toHaveLength(4);
    expect(merged.merges[0].sha).toBe(overlayOnlySha);
    expect(merged.merges.at(-1).sha).toBe(newSha);
    expect(merged.merges.find((merge: { sha: string }) => merge.sha === staleSha).state).toBe('published');
    expect(merged.merges.find((merge: { sha: string }) => merge.sha === matchingSha)).toMatchObject({
      state: 'confirmed',
      confirmed: { groupId: 'same-group' },
    });
    expect(merged.merges.find((merge: { sha: string }) => merge.sha === newSha).state).toBe('published');
  });

  it('does not confirm delivery from a non-physical or unrelated receipt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-receipt-proof-'));
    const indexPath = join(directory, 'index.json');
    const receiptPath = join(directory, 'receipt.json');
    writeFileSync(indexPath, JSON.stringify({
      schemaVersion: 1,
      merges: [{
        sha: '4'.repeat(40),
        state: 'published',
        published: { groupId: 'production-group', updateIds: ['production-update'] },
      }],
    }));
    writeFileSync(receiptPath, JSON.stringify({ devices: [
      { environment: 'emulator', group: 'production-group', updateId: 'production-update' },
      { environment: 'physical', group: 'different-group', updateId: 'different-update' },
    ] }));

    const result = runRelease([
      'confirm', '--index', indexPath, '--receipt', receiptPath,
      '--group', 'production-group', '--update-ids', 'production-update',
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ confirmed: false, groupId: 'production-group' });
    expect(JSON.parse(readFileSync(indexPath, 'utf8')).merges[0].state).toBe('published');
  });

  it('splits receipt-only reconciliation from production delivery conclusions', () => {
    expect(reconcileWorkflow).toContain('MOBILE_OTA_OWNER_PUBKEY');
    expect(reconcileWorkflow).toContain('MOBILE_OTA_RECEIPT_TOKEN');
    expect(reconcileWorkflow).toContain("cron: '*/15 * * * *'");
    expect(reconcileWorkflow).toContain('node scripts/ota-release.mjs confirm');
    expect(reconcileWorkflow).toContain('does not release');
    expect(reconcileWorkflow).not.toContain('ota-release.mjs promote');
    expect(reconcileWorkflow).toContain('Recheck canonical index before writing');
    expect(reconcileWorkflow).toContain('ota-release.mjs merge-reconciliation');
    expect(workflow).not.toContain("cron: '*/15 * * * *'");
    expect(workflow).not.toMatch(/branches: \[main\][\s\S]{0,120}paths:/);
  });

  it('makes a commanded run measure and enforce trigger-to-promotion under ten minutes', () => {
    expect(workflow).toContain('getWorkflowRun');
    expect(workflow).toContain("core.exportVariable('TRIGGER_EPOCH'");
    expect(workflow).toContain('trigger_to_promotion');
    expect(workflow).toContain('Mobile OTA delivery timing');
    expect(workflow).toContain('if [ "$elapsed" -ge 600 ]');
    expect(workflow).toContain('assert-promotion --ledger "$RUN_LEDGER" --index "$DELIVERY_INDEX"');
    expect(workflow).toContain('**NOT DELIVERED:** production promotion proof was not produced.');
    expect(workflow).toContain("delivered: ${{ steps.promotion.outcome == 'success' }}");
    expect(workflow).toContain("needs.release.outputs.delivered != 'true'");
  });

  it('runs validation beside candidate export and safely supersedes stale cumulative releases', () => {
    expect(workflow).toContain('Validate while exporting and publishing the beta candidate');
    expect(workflow).toContain('validation_pid=$!');
    expect(workflow).toContain('wait "$validation_pid"');
    expect(workflow).toContain('parallel_candidate_wall');
    expect(workflow).toMatch(/group: mobile-ota-production-delivery\s+cancel-in-progress: true/);
    expect(workflow).toContain('--before "$PUSH_BEFORE"');
    expect(deliveryIndexScript).toContain("['merge-base', '--is-ancestor', lastTracked, head]");
  });

  it('promotes before dispatching the full rehearsal and arms guarded rollback', () => {
    expect(workflow).not.toContain('skip_canary');
    expect(workflow).toContain('--status post-promote');
    expect(workflow).toContain('node scripts/ota-release.mjs promote');
    expect(workflow.indexOf('node scripts/ota-release.mjs promote')).toBeLessThan(
      workflow.indexOf('uses: ./.github/workflows/mobile-ota-post-promote.yml'),
    );
    expect(postPromoteWorkflow).toContain('scripts/ota-canary.sh --ledger "$RUN_LEDGER" --promoted');
    expect(workflow).toContain("if: always() && steps.promotion.outcome == 'success'");
    expect(workflow).toContain("if: always() && needs.release.outputs.delivered == 'true'");
    expect(postPromoteWorkflow).toContain('workflow_call:');
    expect(postPromoteWorkflow).toContain('--expected-current-group "$FAILED_GROUP"');
    expect(postPromoteWorkflow).toContain("needs.canary.result == 'failure' && needs.canary.outputs.failure_class == 'product-failure'");
    expect(postPromoteWorkflow).toContain('Escalate rehearsal infrastructure failure without rollback');
    expect(postPromoteWorkflow).toContain('Install mobile dependencies for EAS project context');
    expect(rollbackWorkflow).toContain("artifact.name.startsWith('mobile-ota-ledger-')");
    expect(rollbackWorkflow).toContain('dry_run:');
    expect(rollbackWorkflow).toContain('update:list --branch production --limit 1 --json --non-interactive');
    expect(rollbackWorkflow).toContain('args+=(--dry-run)');
    expect(rollbackWorkflow).toContain('Record rollback dry-run proof');
    expect(rollbackWorkflow).toContain('Install mobile dependencies for EAS project context');
  });

  it('bounds the canary and tests either the beta or promoted production runtime without rebuilding native code', () => {
    expect(canaryScript).toContain('MAX_SECONDS="${OTA_CANARY_MAX_SECONDS:-600}"');
    expect(canaryScript).toContain('MAX_SECONDS > 600');
    expect(canaryScript).toContain('BUILD_PROFILE="beta-apk"');
    expect(canaryScript).toContain('BUILD_PROFILE="production-apk"');
    expect(canaryScript).toContain('--build-profile "$BUILD_PROFILE"');
    expect(canaryScript).toContain('--runtime-version "$android_runtime"');
    expect(canaryScript).toContain('MAESTRO_SKIP_BUILD=1');
    expect(canaryScript).toContain('EXPECTED_ANDROID_UPDATE_ID="$android_update"');
    expect(canaryScript).toContain('OTA_CANARY_UPDATE_APPLY_TIMEOUT_SECONDS:-120');
    expect(canaryScript).toContain('android-device-ready.sh');
    expect(canaryScript).toContain('wait_for_android_device_ready');
    expect(canaryScript).toContain('MAESTRO_VERIFY_UPDATE_ONLY=1');
    expect(canaryScript).not.toContain('OTA_CANARY_WARMUP_SECONDS');
    expect(canaryScript.indexOf('MAESTRO_VERIFY_UPDATE_ONLY=1')).toBeLessThan(
      canaryScript.indexOf('smoke_log="$temporary/maestro-smoke.log"'),
    );
  });

  it('makes update identity a mandatory gate before every requested Maestro flow', () => {
    expect(maestroScript).toContain('EXPECTED_ANDROID_UPDATE_ID is required');
    expect(maestroScript).toContain('verify_running_update_identity');
    expect(maestroScript).toContain('$observed_channel" == "$EXPECTED_UPDATE_CHANNEL"');
    expect(maestroScript).toContain('EXPECTED_UPDATE_CHANNEL must be beta or production');
    expect(maestroScript.indexOf('verify_running_update_identity')).toBeLessThan(
      maestroScript.indexOf('npx tsx scripts/provision-smoke.ts'),
    );
    expect(maestroScript.indexOf('verify_running_update_identity')).toBeLessThan(
      maestroScript.indexOf('maestro test --device'),
    );
    expect(maestroScript).toContain('MAESTRO_VERIFY_UPDATE_ONLY');
    expect(maestroScript).toContain('android-device-ready.sh');
    expect(maestroScript).toContain('wait_for_android_device_ready');
  });

  it('binds deep-link canary steps to the production package on a shared AVD', () => {
    const enumerateHandlers = maestroScript.indexOf('cmd package query-activities --brief');
    const disableCompetitor = maestroScript.indexOf('pm disable-user --user 0 "$package"');
    const runFlow = maestroScript.indexOf('maestro test --device');
    const restoreCompetitor = maestroScript.indexOf('pm enable --user 0 "$package"');

    expect(enumerateHandlers).toBeGreaterThan(-1);
    expect(maestroScript).toContain("-d 'beeline://buzz/channels'");
    expect(maestroScript).toContain('target_handler_seen=1');
    expect(maestroScript).toContain('$APP_ID is not registered for beeline://');
    expect(disableCompetitor).toBeGreaterThan(enumerateHandlers);
    expect(disableCompetitor).toBeLessThan(runFlow);
    expect(restoreCompetitor).toBeGreaterThan(-1);
    expect(maestroScript).not.toContain('uninstall "$package"');
  });

  describe('canary runner environment classification', () => {
    const barePath = '/usr/bin:/bin';
    const defaultMaestroDirectory = mkdtempSync(join(tmpdir(), 'beeline-maestro-stub-'));
    const defaultMaestro = join(defaultMaestroDirectory, 'maestro');
    writeFileSync(defaultMaestro, '#!/bin/sh\nexit 0\n');
    chmodSync(defaultMaestro, 0o755);

    function runCanary(
      args: string[] = [],
      env: Record<string, string | undefined> = {},
    ) {
      return spawnSync(
        'bash',
        [join(mobileRoot, 'scripts/ota-canary.sh'), ...args],
        {
          cwd: mobileRoot,
          encoding: 'utf8',
          // Empty strings make the script's ${VAR:-} defaults treat these as
          // unset even when this developer shell exported a real SDK.
          env: {
            ...process.env,
            ANDROID_HOME: '',
            ANDROID_SDK_ROOT: '',
            // Most environment tests exercise later gates. Pin a known
            // executable so they do not depend on the developer/CI account's
            // optional ~/.maestro installation.
            MAESTRO_BIN: defaultMaestro,
            // The script accepts the governor's Node.js executable explicitly
            // because its intentionally narrow runner PATH may not contain it.
            NODE_BIN: process.execPath,
            PATH: barePath,
            ...env,
          },
        },
      );
    }

    function writeBetaLedger(directory: string): string {
      const ledger = join(directory, 'ledger.json');
      writeFileSync(
        ledger,
        JSON.stringify({
          status: 'beta',
          sourceSha: '1234567890abcdef',
          candidateGroupId: 'candidate-group',
          androidUpdateId: 'beta-android',
          candidateUpdates: [
            {
              id: 'beta-android',
              platform: 'android',
              group: 'candidate-group',
              runtimeVersion: '21',
            },
          ],
          canary: { status: 'pending' },
        }),
      );
      return ledger;
    }

    function writeProductionLedger(directory: string): string {
      const ledger = join(directory, 'ledger.json');
      writeFileSync(
        ledger,
        JSON.stringify({
          status: 'production',
          sourceSha: '1234567890abcdef',
          candidateGroupId: 'candidate-group',
          production: {
            sourceGroupId: 'candidate-group',
            groupId: 'production-group',
            updates: [
              {
                id: 'production-android',
                platform: 'android',
                group: 'production-group',
                runtimeVersion: '21',
              },
            ],
          },
        }),
      );
      return ledger;
    }

    function stubAdbSdk(directory: string, devicesOutput: string): string {
      const platformTools = join(directory, 'platform-tools');
      mkdirSync(platformTools, { recursive: true });
      const adb = join(platformTools, 'adb');
      writeFileSync(
        adb,
        `#!/bin/sh
case "$*" in
  devices) printf '${devicesOutput}\\n' ;;
  *' get-state') printf 'device\\n' ;;
  *'shell getprop sys.boot_completed') printf '1\\n' ;;
esac
`,
      );
      chmodSync(adb, 0o755);
      return directory;
    }

    it('parks with an actionable reason when no adb is reachable from the runner environment', () => {
      const result = runCanary();

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('platform-tools');
      expect(result.stderr).toContain('ANDROID_HOME');
      expect(result.stderr).not.toContain('requires the existing Android emulator');
    }, 60_000);

    it('parks with an actionable reason when Node.js is absent from the runner environment', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-no-node-'));
      const sdkRoot = stubAdbSdk(
        directory,
        'List of devices attached\nemulator-5554\tdevice',
      );
      const ledger = writeBetaLedger(directory);

      const result = runCanary(['--ledger', ledger], {
        ANDROID_HOME: sdkRoot,
        NODE_BIN: join(directory, 'missing-node'),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Node.js is not executable');
      expect(result.stderr).toContain('NODE_BIN and PATH');
    }, 60_000);

    it('resolves adb from ANDROID_HOME when PATH lacks it and proceeds past the device gate', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-adb-ok-'));
      const sdkRoot = stubAdbSdk(
        directory,
        'List of devices attached\\nemulator-5554\\tdevice',
      );
      const ledger = writeBetaLedger(directory);

      // A missing APK proves the run got past adb resolution AND the device
      // gate without touching a real emulator or the network. The missing
      // operator-supplied APK itself is a setup failure, so the run parks
      // (exit 2) naming the path instead of dying as an opaque flow error.
      const result = runCanary(['--ledger', ledger], {
        ANDROID_HOME: sdkRoot,
        BEELINE_BETA_APK: join(directory, 'missing.apk'),
      });

      expect(result.stderr).not.toContain('platform-tools binary');
      expect(result.stderr).not.toContain('not attached to the shared adb server');
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('BEELINE_BETA_APK');
      expect(result.stderr).toContain('missing.apk');
    }, 60_000);

    it('selects the production APK and promoted Android identity for post-promotion rehearsal', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-promoted-apk-'));
      const sdkRoot = stubAdbSdk(
        directory,
        'List of devices attached\nemulator-5554\tdevice',
      );
      const ledger = writeProductionLedger(directory);

      const result = runCanary(['--ledger', ledger, '--promoted'], {
        ANDROID_HOME: sdkRoot,
        BEELINE_PRODUCTION_APK: join(directory, 'missing-production.apk'),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('BEELINE_PRODUCTION_APK');
      expect(result.stderr).toContain('production-channel APK');
      expect(result.stderr).not.toContain('missing the production group or Android update id');
    }, 60_000);

    it('resolves the runner-local Maestro install when the non-login PATH omits it', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-maestro-ok-'));
      const sdkRoot = stubAdbSdk(directory, 'List of devices attached');
      const maestro = join(directory, '.maestro/bin/maestro');
      mkdirSync(join(directory, '.maestro/bin'), { recursive: true });
      writeFileSync(maestro, '#!/bin/sh\nexit 0\n');
      chmodSync(maestro, 0o755);

      const result = runCanary([], {
        ANDROID_HOME: sdkRoot,
        HOME: directory,
        MAESTRO_BIN: undefined,
      });

      expect(result.status).toBe(2);
      expect(result.stderr).not.toContain('Maestro is not executable');
      expect(result.stderr).toContain('emulator-5554');
      expect(result.stderr).toContain('not attached');
    }, 60_000);

    it('parks with an actionable persisted reason when Maestro is absent', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-maestro-missing-'));
      const sdkRoot = stubAdbSdk(
        directory,
        'List of devices attached\\nemulator-5554\\tdevice',
      );
      const reasonFile = join(directory, 'reason.txt');

      const result = runCanary([], {
        ANDROID_HOME: sdkRoot,
        HOME: directory,
        MAESTRO_BIN: undefined,
        OTA_CANARY_REASON_FILE: reasonFile,
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Maestro is not executable');
      expect(result.stderr).toContain('Install Maestro for the runner account');
      const reason = readFileSync(reasonFile, 'utf8').trim();
      expect(reason).toContain('Maestro is not executable');
      expect(reason).toContain('MAESTRO_BIN');
      expect(reason.split('\n')).toHaveLength(1);
    }, 60_000);

    it('parks when the sanctioned emulator is not attached to the adb server', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-adb-none-'));
      const sdkRoot = stubAdbSdk(directory, 'List of devices attached');

      const result = runCanary([], { ANDROID_HOME: sdkRoot });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('emulator-5554');
      expect(result.stderr).toContain('boot');
    }, 60_000);

    it('recovers an offline emulator when adb reconnect offline returns it to device within the readiness window', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-adb-recovers-'));
      const platformTools = join(directory, 'platform-tools');
      const callLog = join(directory, 'adb-calls.log');
      mkdirSync(platformTools, { recursive: true });
      writeFileSync(
        join(platformTools, 'adb'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_CALL_LOG"
case "$*" in
  devices)
    if [ -f "$STUB_RECONNECTED" ]; then
      printf 'List of devices attached\\nemulator-5554\\tdevice\\n'
    else
      printf 'List of devices attached\\nemulator-5554\\toffline\\n'
    fi
    ;;
  'reconnect offline') touch "$STUB_RECONNECTED" ;;
  '-s emulator-5554 get-state')
    if [ -f "$STUB_RECONNECTED" ]; then printf 'device\\n'; else printf 'offline\\n'; fi
    ;;
  '-s emulator-5554 shell getprop sys.boot_completed') printf '1\\n' ;;
esac
`,
      );
      chmodSync(join(platformTools, 'adb'), 0o755);
      const ledger = writeBetaLedger(directory);

      const result = runCanary(['--ledger', ledger], {
        ANDROID_HOME: directory,
        BEELINE_BETA_APK: join(directory, 'missing.apk'),
        OTA_CANARY_DEVICE_READY_TIMEOUT_SECONDS: '2',
        STUB_CALL_LOG: callLog,
        STUB_RECONNECTED: join(directory, 'reconnected'),
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('adb reconnect offline');
      expect(result.stderr).toContain('emulator-5554 is ready');
      expect(result.stderr).toContain('BEELINE_BETA_APK');
      expect(readFileSync(callLog, 'utf8')).toContain('reconnect offline');
    }, 60_000);

    it('parks with the existing not-ready message class when an offline emulator outlives the readiness window', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-adb-offline-'));
      const sdkRoot = stubAdbSdk(
        directory,
        'List of devices attached\\nemulator-5554\\toffline',
      );

      const result = runCanary([], {
        ANDROID_HOME: sdkRoot,
        OTA_CANARY_DEVICE_READY_TIMEOUT_SECONDS: '1',
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('offline');
      expect(result.stderr).toContain('not ready');
      expect(result.stderr).toContain('adb reconnect offline');
    }, 60_000);

    it('validates the bounded device-readiness timeout before touching adb', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-ready-timeout-'));
      const sdkRoot = stubAdbSdk(
        directory,
        'List of devices attached\\nemulator-5554\\tdevice',
      );

      const result = runCanary([], {
        ANDROID_HOME: sdkRoot,
        OTA_CANARY_DEVICE_READY_TIMEOUT_SECONDS: '0',
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        'OTA_CANARY_DEVICE_READY_TIMEOUT_SECONDS must be between 1 and 300 (got 0)',
      );
    }, 60_000);

    it('writes the parked reason to OTA_CANARY_REASON_FILE on a device-gate failure', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-reason-file-'));
      const sdkRoot = stubAdbSdk(directory, 'List of devices attached');
      const reasonFile = join(directory, 'reason.txt');

      const result = runCanary([], {
        ANDROID_HOME: sdkRoot,
        OTA_CANARY_REASON_FILE: reasonFile,
      });

      expect(result.status).toBe(2);
      const reason = readFileSync(reasonFile, 'utf8').trim();
      expect(reason).toContain('emulator-5554');
      expect(reason).toContain('not attached to the shared adb server');
      // Exactly one line so the workflow can quote it verbatim.
      expect(reason.split('\n')).toHaveLength(1);
    }, 60_000);

    // Stubs for the APK-acquisition preflight. The stub npx/curl sit earlier
    // on PATH than /usr/bin, so no real EAS call or download ever happens.
    function stubReleaseTools(
      directory: string,
      options: {
        buildListStdout?: string;
        buildListExit?: number;
        curlExit?: number;
      } = {},
    ): string {
      const bin = join(directory, 'stub-bin');
      mkdirSync(bin, { recursive: true });
      const stdout = (options.buildListStdout ?? '[]').replaceAll("'", '');
      const buildListExit = options.buildListExit ?? 0;
      writeFileSync(
        join(bin, 'npx'),
        `#!/bin/sh\nprintf '%s\\n' '${stdout}'\nexit ${buildListExit}\n`,
      );
      chmodSync(join(bin, 'npx'), 0o755);
      const curlExit = options.curlExit ?? 0;
      if (curlExit !== 0) {
        writeFileSync(
          join(bin, 'curl'),
          `#!/bin/sh\necho 'curl: stub network failure' >&2\nexit ${curlExit}\n`,
        );
        chmodSync(join(bin, 'curl'), 0o755);
      }
      return bin;
    }

    it('parks with a self-describing reason when EAS has no finished beta-apk build for the runtime', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-no-beta-build-'));
      const sdkRoot = stubAdbSdk(
        directory,
        'List of devices attached\nemulator-5554\tdevice',
      );
      const stubBin = stubReleaseTools(directory, { buildListStdout: '[]' });
      const ledger = writeBetaLedger(directory);
      const reasonFile = join(directory, 'reason.txt');

      const result = runCanary(['--ledger', ledger], {
        ANDROID_HOME: sdkRoot,
        PATH: `${stubBin}:${barePath}`,
        OTA_CANARY_REASON_FILE: reasonFile,
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('no finished beta-apk Android build');
      expect(result.stderr).toContain('runtime version 21');
      expect(result.stderr).toContain('build --profile beta-apk');

      const reason = readFileSync(reasonFile, 'utf8').trim();
      expect(reason).toContain('no finished beta-apk Android build for runtime version 21');
      expect(reason).toContain('build --profile beta-apk --platform android');

      // The broken canary must never be recorded as success or silently
      // consumed: the beta ledger stays pending for the governor to park.
      expect(JSON.parse(readFileSync(ledger, 'utf8')).canary).toMatchObject({
        status: 'pending',
      });
    }, 60_000);

    // Stubs a full canary adb surface driven by env knobs. The call log and
    // state live under the caller's temp directory so assertions can prove
    // the exact commands the canary issued.
    function stubAdbFlow(
      directory: string,
      options: {
        installFailures?: number;
        uninstallFails?: boolean;
        monkeyFails?: boolean;
      } = {},
    ) {
      const sdkRoot = join(directory, 'android-sdk');
      const platformTools = join(sdkRoot, 'platform-tools');
      mkdirSync(platformTools, { recursive: true });
      const stateDir = join(directory, 'stub-state');
      mkdirSync(stateDir, { recursive: true });
      const callLog = join(stateDir, 'calls.log');
      const adbScript = [
        '#!/bin/sh',
        'printf \'%s\\n\' "$*" >> "$STUB_CALL_LOG"',
        'case "$*" in',
        '  devices)',
        "    printf 'List of devices attached\\nemulator-5554\\tdevice\\n'",
        '    ;;',
        '  *" get-state")',
        "    printf 'device\\n'",
        '    ;;',
        '  *"shell getprop sys.boot_completed")',
        "    printf '1\\n'",
        '    ;;',
        '  *"install -r"*)',
        '    count="$(cat "$STUB_STATE_DIR/installs" 2>/dev/null || echo 0)"',
        '    count=$((count + 1))',
        '    printf \'%s\\n\' "$count" > "$STUB_STATE_DIR/installs"',
        '    if [ "$count" -le "${STUB_INSTALL_FAILURES:-0}" ]; then',
        '      echo "Performing Streamed Install"',
        '      echo "adb: failed to install cmd: INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package app.usebeeline.mobile signatures do not match newer version; ignoring!"',
        '      exit 1',
        '    fi',
        '    echo "Success"',
        '    ;;',
        '  *uninstall*)',
        '    printf \'%s\\n\' "$*" > "$STUB_STATE_DIR/uninstall_call"',
        '    [ "${STUB_UNINSTALL_FAILS:-0}" = "1" ] && exit 1',
        '    echo "Success"',
        '    ;;',
        '  *monkey*)',
        '    [ "${STUB_MONKEY_FAILS:-0}" = "1" ] && exit 1',
        '    ;;',
        '  *"shell cat /sdcard/beeline-maestro-update-identity.xml"*)',
        '    if [ -n "${STUB_REPORTED_UPDATE:-}" ]; then',
        '      printf \'<hierarchy><node text="Running update: %s"/><node text="Channel: %s"/></hierarchy>\\n\' "$STUB_REPORTED_UPDATE" "${STUB_REPORTED_CHANNEL:-beta}"',
        '    fi',
        '    ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n');
      writeFileSync(join(platformTools, 'adb'), adbScript);
      chmodSync(join(platformTools, 'adb'), 0o755);
      return { sdkRoot, stateDir, callLog };
    }

    function runMaestroGate(
      sdkRoot: string,
      env: Record<string, string | undefined> = {},
    ) {
      return spawnSync('bash', [join(mobileRoot, 'scripts/maestro-e2e.sh')], {
        cwd: mobileRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(sdkRoot, 'platform-tools')}:${barePath}`,
          MAESTRO_REUSE_INSTALLED_APP: '1',
          MAESTRO_SKIP_BUILD: '1',
          MAESTRO_KEEP_DEVICE: '1',
          MAESTRO_VERIFY_UPDATE_ONLY: '1',
          MAESTRO_UPDATE_IDENTITY_TIMEOUT_SECONDS: '1',
          ...env,
        },
      });
    }

    it('refuses a direct Maestro invocation when the expected update id is empty', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-maestro-no-update-id-'));
      const { sdkRoot, stateDir, callLog } = stubAdbFlow(directory);

      const result = runMaestroGate(sdkRoot, {
        EXPECTED_ANDROID_UPDATE_ID: '',
        STUB_CALL_LOG: callLog,
        STUB_STATE_DIR: stateDir,
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('EXPECTED_ANDROID_UPDATE_ID is required');
      expect(result.stderr).toContain('refusing to run any flow');
      expect(readFileSync(callLog, 'utf8')).toBe(
        'devices\ndevices\n-s emulator-5554 get-state\n-s emulator-5554 shell getprop sys.boot_completed\n',
      );
    }, 60_000);

    it('refuses a custom MAESTRO_FLOW when the device reports a stale update', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-maestro-stale-update-'));
      const { sdkRoot, stateDir, callLog } = stubAdbFlow(directory);
      const customFlow = join(directory, 'custom-flow.yaml');

      const result = runMaestroGate(sdkRoot, {
        EXPECTED_ANDROID_UPDATE_ID: 'expected-update',
        MAESTRO_FLOW: customFlow,
        STUB_REPORTED_UPDATE: 'stale-update',
        STUB_REPORTED_CHANNEL: 'beta',
        STUB_CALL_LOG: callLog,
        STUB_STATE_DIR: stateDir,
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(customFlow);
      expect(result.stderr).toContain("reported update 'stale-update'");
      expect(result.stderr).toContain("expected 'expected-update'");
      expect(result.stdout).not.toContain('Provisioning complete');
    }, 60_000);

    it('accepts the gate only when both the expected update and beta channel match', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-maestro-update-ok-'));
      const { sdkRoot, stateDir, callLog } = stubAdbFlow(directory);

      const result = runMaestroGate(sdkRoot, {
        EXPECTED_ANDROID_UPDATE_ID: 'expected-update',
        STUB_REPORTED_UPDATE: 'expected-update',
        STUB_REPORTED_CHANNEL: 'beta',
        STUB_CALL_LOG: callLog,
        STUB_STATE_DIR: stateDir,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'Maestro update identity verified: expected-update (channel beta).',
      );
    }, 60_000);

    function writeDummyApk(directory: string): string {
      const apk = join(directory, 'beeline-beta.apk');
      writeFileSync(apk, 'dummy beta apk bytes');
      return apk;
    }

    it('parks before product smoke when the expected OTA update never becomes active', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-stale-update-'));
      const { sdkRoot, stateDir, callLog } = stubAdbFlow(directory);
      const ledger = writeBetaLedger(directory);
      const reasonFile = join(directory, 'reason.txt');

      const result = runCanary(['--ledger', ledger], {
        ANDROID_HOME: sdkRoot,
        BEELINE_BETA_APK: writeDummyApk(directory),
        OTA_CANARY_UPDATE_APPLY_TIMEOUT_SECONDS: '1',
        OTA_CANARY_UPDATE_PROBE_TIMEOUT_SECONDS: '1',
        OTA_CANARY_REASON_FILE: reasonFile,
        STUB_CALL_LOG: callLog,
        STUB_STATE_DIR: stateDir,
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        'expected beta Android update beta-android was not reported running',
      );
      expect(result.stderr).toContain('update fetch/reload did not converge');
      expect(readFileSync(reasonFile, 'utf8')).toContain(
        'expected beta Android update beta-android',
      );
      expect(readFileSync(callLog, 'utf8')).not.toContain('provision-smoke');
    }, 60_000);

    it('removes exactly the canary package and retries once when the existing install has a different signature', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-signature-ok-'));
      const { sdkRoot, stateDir, callLog } = stubAdbFlow(directory, {
        installFailures: 1,
        monkeyFails: true,
      });
      const ledger = writeBetaLedger(directory);
      const reasonFile = join(directory, 'reason.txt');

      const result = runCanary(['--ledger', ledger], {
        ANDROID_HOME: sdkRoot,
        BEELINE_BETA_APK: writeDummyApk(directory),
        OTA_CANARY_WARMUP_SECONDS: '0',
        STUB_CALL_LOG: callLog,
        STUB_STATE_DIR: stateDir,
        STUB_INSTALL_FAILURES: '1',
        STUB_MONKEY_FAILS: '1',
        OTA_CANARY_REASON_FILE: reasonFile,
      });

      // The signature-recovery worked; the run proceeds past install and pm
      // clear and only parks afterwards at the deliberately failing launch.
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('different signature');
      expect(result.stderr).toContain('could not launch');

      const calls = readFileSync(callLog, 'utf8').split('\n').filter(Boolean);
      expect(calls.filter((call) => call.includes('install -r'))).toHaveLength(2);
      expect(
        calls.filter((call) => call.includes('uninstall app.usebeeline.mobile')),
      ).toHaveLength(1);
      expect(readFileSync(join(stateDir, 'uninstall_call'), 'utf8')).toBe(
        '-s emulator-5554 uninstall app.usebeeline.mobile\n',
      );
    }, 60_000);

    it('parks honestly when the incompatible existing package cannot be removed', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-signature-unins-'));
      const { sdkRoot, callLog } = stubAdbFlow(directory, {
        installFailures: 1,
        uninstallFails: true,
      });
      const ledger = writeBetaLedger(directory);

      const result = runCanary(['--ledger', ledger], {
        ANDROID_HOME: sdkRoot,
        BEELINE_BETA_APK: writeDummyApk(directory),
        OTA_CANARY_WARMUP_SECONDS: '0',
        STUB_CALL_LOG: callLog,
        STUB_STATE_DIR: join(directory, 'stub-state'),
        STUB_INSTALL_FAILURES: '1',
        STUB_UNINSTALL_FAILS: '1',
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        'could not remove the differently-signed existing app.usebeeline.mobile',
      );
      // Exactly one install attempt, no retry past a failed cleanup.
      const calls = readFileSync(callLog, 'utf8').split('\n').filter(Boolean);
      expect(calls.filter((call) => call.includes('install -r'))).toHaveLength(1);
    }, 60_000);

    it('parks honestly when the install still fails after removing the differently-signed package', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-signature-still-'));
      const { sdkRoot, callLog } = stubAdbFlow(directory, {
        installFailures: 99,
      });
      const ledger = writeBetaLedger(directory);

      const result = runCanary(['--ledger', ledger], {
        ANDROID_HOME: sdkRoot,
        BEELINE_BETA_APK: writeDummyApk(directory),
        OTA_CANARY_WARMUP_SECONDS: '0',
        STUB_CALL_LOG: callLog,
        STUB_STATE_DIR: join(directory, 'stub-state'),
        STUB_INSTALL_FAILURES: '99',
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        'even after removing the differently-signed existing package',
      );
      expect(result.stderr).toContain('INSTALL_FAILED_UPDATE_INCOMPATIBLE');
      const calls = readFileSync(callLog, 'utf8').split('\n').filter(Boolean);
      expect(calls.filter((call) => call.includes('install -r'))).toHaveLength(2);
    }, 60_000);

    it('parks when the EAS build listing itself fails', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-eas-fail-'));
      const sdkRoot = stubAdbSdk(
        directory,
        'List of devices attached\nemulator-5554\tdevice',
      );
      const stubBin = stubReleaseTools(directory, { buildListExit: 7 });
      const ledger = writeBetaLedger(directory);

      const result = runCanary(['--ledger', ledger], {
        ANDROID_HOME: sdkRoot,
        PATH: `${stubBin}:${barePath}`,
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('could not list EAS builds');
      expect(result.stderr).toContain('exited 7');
      expect(result.stderr).toContain('EXPO_TOKEN');
    }, 60_000);

    it('parks when the ledger is unreadable by the canary process', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-ledger-eacces-'));
      const sdkRoot = stubAdbSdk(
        directory,
        'List of devices attached\nemulator-5554\tdevice',
      );
      const ledger = writeBetaLedger(directory);
      chmodSync(ledger, 0o000);

      const result = runCanary(['--ledger', ledger], { ANDROID_HOME: sdkRoot });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('unreadable or malformed JSON');
      // Restore so the temp directory can be cleaned up afterwards.
      chmodSync(ledger, 0o600);
    }, 60_000);

    it('parks when the beta APK download fails after a successful build lookup', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-download-fail-'));
      const sdkRoot = stubAdbSdk(
        directory,
        'List of devices attached\nemulator-5554\tdevice',
      );
      const stubBin = stubReleaseTools(directory, {
        buildListStdout:
          '[{"id":"b1","artifacts":{"buildUrl":"https://example.invalid/beeline-beta.apk"}}]',
        curlExit: 22,
      });
      const ledger = writeBetaLedger(directory);

      const result = runCanary(['--ledger', ledger], {
        ANDROID_HOME: sdkRoot,
        PATH: `${stubBin}:${barePath}`,
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('could not download the beta APK');
    }, 60_000);
  });

  it('records a blocked canary and parks production promotion behind the stored reason', () => {
    const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-blocked-'));
    const ledger = join(directory, 'ledger.json');
    writeFileSync(
      ledger,
      JSON.stringify({
        status: 'beta',
        sourceSha: '1234567890abcdef',
        candidateGroupId: 'candidate-group',
        canary: { status: 'pending' },
      }),
    );

    const missingReason = runRelease([
      'mark-canary',
      '--ledger',
      ledger,
      '--status',
      'blocked',
    ]);
    expect(missingReason.status).toBe(1);
    expect(missingReason.stderr).toContain('--reason');

    const blocked = runRelease([
      'mark-canary',
      '--ledger',
      ledger,
      '--status',
      'blocked',
      '--reason',
      'ota-canary.sh exited 2: runner cannot reach adb/emulator-5554',
    ]);
    expect(blocked.status).toBe(0);

    const promote = runRelease(['promote', '--ledger', ledger]);
    expect(promote.status).toBe(1);
    expect(promote.stderr).toContain('parked');
    expect(promote.stderr).toContain('runner cannot reach adb/emulator-5554');

    expect(JSON.parse(readFileSync(ledger, 'utf8')).canary).toMatchObject({
      status: 'blocked',
      reason: 'ota-canary.sh exited 2: runner cannot reach adb/emulator-5554',
    });
  }, 60_000);

  it('the post-promotion workflow pins adb and escalates every failed promoted group', () => {
    expect(postPromoteWorkflow).toContain('ANDROID_HOME: /home/lunchbox/android-sdk');
    expect(postPromoteWorkflow).toContain('Put every affected merge and failure reason in escalation');
    expect(postPromoteWorkflow).toContain("index.merges.filter((merge) => merge.state !== 'confirmed')");
    expect(postPromoteWorkflow).toContain("merge.published?.groupId === process.env.FAILED_GROUP");
    expect(postPromoteWorkflow).toContain('Guarded automatic rollback');
    expect(workflow).toMatch(/Store release ledger, timings, and promotion proof[\s\S]*?if: always\(\) && steps\.initialize\.outcome == 'success'/);
  });

  it('the workflow records a self-describing parked reason even when the canary dies before its own handlers', () => {
    // The canary is told where to publish its one-line parked reason...
    expect(postPromoteWorkflow).toContain('OTA_CANARY_REASON_FILE:');
    // ...stale reasons are cleared before the run...
    expect(postPromoteWorkflow).toContain('rm -f "$OTA_CANARY_REASON_FILE"');
    // ...and a failure folds that line into the escalation reason, falling
    // back to the exit status when the shell died before writing anything.
    const canaryStep = postPromoteWorkflow.slice(
      postPromoteWorkflow.indexOf('Run full post-promotion Android rehearsal'),
      postPromoteWorkflow.indexOf('Store post-promotion rehearsal evidence'),
    );
    expect(canaryStep).toContain('head -n 1 "$OTA_CANARY_REASON_FILE"');
    expect(canaryStep).toContain('ota-canary.sh exited ${canary_status}');
    expect(canaryStep).toContain('exit "$canary_status"');
  });

  it('the canary script owns the parked-reason contract for every preflight stage', () => {
    // One funnel prints AND persists every environment/setup reason.
    expect(canaryScript).toMatch(/park\(\) \{/);
    expect(canaryScript).toContain('OTA_CANARY_REASON_FILE');
    const parkCalls = canaryScript.match(/\bpark "/g)?.length ?? 0;
    // adb unresolvable, adb enumeration, emulator missing/not-ready, deadline
    // config, ledger missing/shape, EAS listing, empty build list, download,
    // supplied APK missing, install/pm-clear/launch/warm-up device failures.
    expect(parkCalls).toBeGreaterThanOrEqual(14);
    // The empty channel-matched APK parking names the exact remediation.
    expect(canaryScript).toContain('no finished ${BUILD_PROFILE} Android build');
    expect(canaryScript).toContain('build --profile ${BUILD_PROFILE} --platform android --non-interactive');
  });

  it('a provisioning-bootstrap death parks self-describingly instead of exiting as a generic smoke failure', () => {
    // The smoke stage is captured to a log...
    expect(canaryScript).toMatch(/maestro-e2e\.sh" 2>&1 \| tee "\$smoke_log"/);
    // ...its failure is classified against bootstrap signatures...
    expect(canaryScript).toMatch(/grep -m1 -E 'Cannot find module\|MODULE_NOT_FOUND' "\$smoke_log"/);
    expect(canaryScript).toContain(
      'its provisioning bootstrap failed before Maestro ran',
    );
    // ...and only a bootstrap match parks (exit 2); everything else re-exits
    // with the genuine smoke status.
    expect(canaryScript).toContain('if [[ -n "$bootstrap_line" ]]; then');
    expect(canaryScript.indexOf('if [[ -n "$bootstrap_line" ]]; then')).toBeLessThan(
      canaryScript.indexOf('exit "$smoke_status"'),
    );
    expect(canaryScript).toContain('OTA_CANARY_OUTCOME_FILE');
    expect(canaryScript).toContain('completed product-assertion verdict');
    expect(canaryScript).toContain('product-assertion-failure');
  });

  it('bridges the root smoke scripts to the mobile workspace modules they import', () => {
    // Node resolves upward from each script's real path (repo root) and never
    // reaches apps/mobile/node_modules; the bridge is declared before the
    // first provisioning invocation.
    expect(maestroScript).toMatch(/export NODE_PATH="\$MOBILE_DIR\/node_modules/);
    expect(maestroScript.indexOf('NODE_PATH')).toBeLessThan(
      maestroScript.indexOf('npx tsx scripts/provision-smoke.ts'),
    );
  });

  it('starts each propagation budget at relay observation and proves RoomView visibility within seconds', () => {
    const replyFixture = readFileSync(
      resolve(mobileRoot, '../../scripts/publish-smoke-replies.ts'),
      'utf8',
    );
    const budget = replyFixture.match(/ROOMVIEW_LATENCY_BUDGET_MS = ([\d_]+);/);
    expect(budget).not.toBeNull();
    expect(Number(budget![1].replaceAll('_', ''))).toBeLessThanOrEqual(8_000);
    expect(replyFixture).toContain(
      "const roomSend = await waitForRelayMessage(client, roomId, 'SMOKE ROOM SEND')",
    );
    expect(replyFixture).toContain(
      "await requireRoomViewWithinBudget(roomViews, roomId, roomSend, 'room-send')",
    );
    expect(replyFixture).toContain(
      "const cornerSteer = await waitForRelayMessage(client, cornerId, 'SMOKE CORNER STEER')",
    );
    expect(replyFixture).toContain(
      "await requireRoomViewWithinBudget(roomViews, cornerId, cornerSteer, 'corner-steer')",
    );
    const pickerCheckpoint = replyFixture.indexOf(
      "await waitForRelayMessage(client, roomId, 'mention picker stayed responsive')",
    );
    const exactMentionWait = replyFixture.indexOf(
      'await waitForRelayMessage(client, roomId, "@beebee what\'s up")',
    );
    const exactMentionCount = replyFixture.indexOf(
      'await requireExactlyOneMessage(client, roomId, "@beebee what\'s up")',
    );
    expect(pickerCheckpoint).toBeGreaterThan(-1);
    expect(exactMentionWait).toBeGreaterThan(pickerCheckpoint);
    expect(exactMentionCount).toBeGreaterThan(exactMentionWait);
    expect(replyFixture).toContain('AGENT_PRESENCE_HEARTBEAT_MS');
    expect(replyFixture).toContain('KIND_AGENT_PRESENCE');
    expect(replyFixture).toContain('TAG_AGENT_PRESENCE');
    expect(replyFixture).toMatch(
      /setTimeout\([\s\S]*?AGENT_PRESENCE_HEARTBEAT_MS[\s\S]*?clearTimeout/,
    );

    const smoke = readFileSync(join(mobileRoot, 'e2e', 'smoke.yaml'), 'utf8');
    expect(smoke).toMatch(/visible: SMOKE AGENT ROOM REPLY\.\*[\s\S]*?timeout: 10000/);
    expect(smoke).toMatch(/visible: SMOKE AGENT CORNER REPLY\.\*[\s\S]*?timeout: 10000/);
  });

  it('provisions a human-accessible corner and publishes its durable turn lifecycle', () => {
    const provisionScript = readFileSync(
      resolve(mobileRoot, '../../scripts/provision-smoke.ts'),
      'utf8',
    );
    const smoke = readFileSync(join(mobileRoot, 'e2e', 'smoke.yaml'), 'utf8');
    const replyFixture = readFileSync(
      resolve(mobileRoot, '../../scripts/publish-smoke-replies.ts'),
      'utf8',
    );
    const createCorner = provisionScript.indexOf('await agentClient.createSubchannel(');
    const addHuman = provisionScript.indexOf(
      "await agentClient.addMember(cornerId, identity.publicKey, 'member')",
      createCorner,
    );
    const proveHuman = provisionScript.indexOf(
      'await client.waitUntilMember(cornerId, identity.publicKey)',
      addHuman,
    );

    expect(createCorner).toBeGreaterThan(-1);
    expect(addHuman).toBeGreaterThan(createCorner);
    expect(proveHuman).toBeGreaterThan(addHuman);
    expect(replyFixture).not.toContain('KIND_CORNER_STATE');
    expect(replyFixture).not.toContain('TAG_CORNER_STATE');
    expect(replyFixture).toMatch(/kind: 9,[\s\S]*?\['h', cornerId\]/);
    expect(replyFixture).toContain("['t', 'body-control']");
    expect(replyFixture).toContain("['t', 'agent-turn']");
    expect(replyFixture).toContain("['request', requestId]");
    expect(replyFixture).toContain("['session', 'smoke-corner-session']");
    expect(replyFixture).toContain("['agent', identity.publicKey]");
    expect(replyFixture).toContain("['mode', 'readonly']");
    expect(replyFixture).toContain("['status', status]");
    expect(replyFixture).toContain("'Agent is thinking…' : 'Agent reply complete.'");
    expect(replyFixture).toMatch(
      /SMOKE CORNER PHASE READY[\s\S]*?publishCornerTurnStatus\(cornerPhaseRequest\.id, 'working'\)[\s\S]*?SMOKE CORNER STEER[\s\S]*?publishCornerRemoteState\('in-review', \{ checks: 'failing' \}\)[\s\S]*?SMOKE CHECKS GREEN[\s\S]*?publishCornerRemoteState\('in-review', \{ checks: 'passing' \}\)[\s\S]*?SMOKE GH MERGE[\s\S]*?publishCornerRemoteState\('gone', \{ outcome: 'landed' \}\)/,
    );
    const cornerPhaseCheckpoint = replyFixture.indexOf(
      'const cornerPhaseRequest = await waitForRelayMessage(',
    );
    const cornerSteerWait = replyFixture.indexOf(
      "await waitForRelayMessage(client, cornerId, 'SMOKE CORNER STEER')",
    );
    expect(cornerPhaseCheckpoint).toBeGreaterThan(-1);
    expect(cornerSteerWait).toBeGreaterThan(cornerPhaseCheckpoint);
    expect(smoke).toMatch(
      /SMOKE CORNER PHASE READY[\s\S]*?id: corner-status-working/,
    );
    expect(smoke).toMatch(
      /id: corner-status-working[\s\S]*?waitToSettleTimeoutMs: 1000[\s\S]*?id: corner-session-header/,
    );
    expect(smoke).toMatch(
      /id: chat-input[\s\S]*?waitToSettleTimeoutMs: 1000[\s\S]*?inputText: SMOKE CORNER STEER/,
    );
  });

  it('types a unique valid handle before claiming in every Maestro onboarding flow', () => {
    const provisionScript = readFileSync(resolve(mobileRoot, '../../scripts/provision-smoke.ts'), 'utf8');
    expect(provisionScript).toContain('MAESTRO_SMOKE_HANDLE=smoke-${identity.publicKey.slice(0, 12)}');
    expect(maestroScript).toContain('read_seed_value MAESTRO_SMOKE_HANDLE');
    expect(maestroScript).toContain('--env "SMOKE_HANDLE=$SMOKE_HANDLE"');

    const flows = [
      ['smoke.yaml', 'inputText: ${SMOKE_HANDLE}'],
      ['live-agent-send-once.yaml', 'inputText: ${LIVE_HANDLE}'],
      ['live-chat-layout.yaml', 'inputText: ${LIVE_HANDLE}'],
    ] as const;
    for (const [flowName, uniqueInput] of flows) {
      const flow = readFileSync(join(mobileRoot, 'e2e', flowName), 'utf8');
      const ceremony = flow.indexOf('id: onboarding-handle-ceremony');
      const typeHandle = flow.indexOf(uniqueInput, ceremony);
      const dismissIme = flow.indexOf('pressKey: back', typeHandle);
      const claim = flow.indexOf('id: onboarding-claim-handle', dismissIme);

      expect(ceremony, `${flowName} waits for the current handle ceremony`).toBeGreaterThan(-1);
      expect(typeHandle, `${flowName} fills the captured empty handle input`).toBeGreaterThan(ceremony);
      expect(dismissIme, `${flowName} dismisses the auto-focused IME`).toBeGreaterThan(typeHandle);
      expect(claim, `${flowName} claims the generated handle`).toBeGreaterThan(dismissIme);
      expect(flow).not.toContain('onboarding-person-name-step');
      expect(flow).not.toContain('onboarding-person-name-input');
      expect(flow).not.toContain('onboarding-enter-workspace');
      expect(flow).not.toMatch(/inputText: (Maestro Smoke|Live device|Layout device|ada-labs)/);
    }
  });

  it('reuses fixed relay Workspaces and exercises a real round-trip Workspace switch', () => {
    const provisionScript = readFileSync(
      resolve(mobileRoot, '../../scripts/provision-smoke.ts'),
      'utf8',
    );
    const maestroScript = readFileSync(join(mobileRoot, 'scripts/maestro-e2e.sh'), 'utf8');
    const canaryFlow = readFileSync(join(mobileRoot, 'e2e', 'ota-canary.yaml'), 'utf8');
    const switchFlow = readFileSync(join(mobileRoot, 'e2e', 'workspace-switch.yaml'), 'utf8');

    // The runner-local state owns one fixture key and stable ids. Exclusive,
    // mode-0600 creation prevents concurrent first runs from splitting it.
    expect(provisionScript).toContain('loadOrCreateFixtureState');
    expect(provisionScript).toContain("open(path, 'wx', 0o600)");
    expect(provisionScript).toContain('await client.getCommunity(communityId)');
    expect(provisionScript).toContain('await client.createCommunity(name, { communityId })');
    expect(provisionScript).not.toMatch(/createCommunity\('Buzzy Maestro/);

    expect(maestroScript).toContain('read_seed_value MAESTRO_SMOKE_SWITCH_WORKSPACE_ID');
    expect(maestroScript).toContain('read_seed_value MAESTRO_SMOKE_SWITCH_ROOM_ID');
    expect(maestroScript).toContain('--env "SMOKE_SWITCH_WORKSPACE_ID=$SMOKE_SWITCH_WORKSPACE_ID"');
    expect(canaryFlow).toContain('runFlow: workspace-switch.yaml');
    const smokeFlow = readFileSync(join(mobileRoot, 'e2e', 'smoke.yaml'), 'utf8');
    expect(smokeFlow).toContain('id: workspace-avatar-trigger');
    expect(smokeFlow).toContain('id: community-rail-${SMOKE_WORKSPACE_ID}');
    expect(switchFlow).toContain('id: community-rail-${SMOKE_SWITCH_WORKSPACE_ID}');
    expect(switchFlow).toContain('id: community-rail-${SMOKE_WORKSPACE_ID}');
    expect(switchFlow).toContain('id: room-${SMOKE_SWITCH_ROOM_ID}');
    expect(switchFlow).toContain('id: room-${SMOKE_ROOM_ID}');
    expect(switchFlow).toContain("assertNotVisible: '! ERROR'");
  });

  it('does not repeat the script-level update identity gate in the Maestro flow', () => {
    const canaryFlow = readFileSync(join(mobileRoot, 'e2e', 'ota-canary.yaml'), 'utf8');
    const smoke = canaryFlow.indexOf('runFlow: smoke.yaml');

    expect(smoke).toBeGreaterThan(-1);
    expect(canaryFlow).not.toContain("assertVisible: 'Running update:");
    expect(canaryFlow).not.toContain("assertVisible: 'Channel: beta'");
  });

  it('keeps one Room reply assertion and clears the still-focused composer directly', () => {
    const smoke = readFileSync(join(mobileRoot, 'e2e', 'smoke.yaml'), 'utf8');

    expect(smoke.match(/SMOKE AGENT ROOM REPLY\.\*/g)).toHaveLength(1);
    expect(smoke).toMatch(
      /inputText: ['"] still accepting input['"][\s\S]*?visible: ['"]\.\*still accepting input['"][\s\S]*?timeout: 1000[\s\S]*?- eraseText/,
    );
  });

  it('waits for the transcript surface before interacting with its bottom-edge composer', () => {
    const flows = ['smoke.yaml', 'live-agent-send-once.yaml', 'live-chat-layout.yaml'] as const;
    for (const flowName of flows) {
      const flow = readFileSync(join(mobileRoot, 'e2e', flowName), 'utf8');
      const roomTap = flow.indexOf('id: room-${');
      const transcriptReady = flow.indexOf('id: chat-messages', roomTap);
      const composerInteraction = flow.indexOf('id: chat-input', roomTap);

      expect(roomTap, `${flowName} opens the selected Room`).toBeGreaterThan(-1);
      expect(transcriptReady, `${flowName} waits for the Room transcript`).toBeGreaterThan(roomTap);
      expect(composerInteraction, `${flowName} reaches the composer after the transcript`).toBeGreaterThan(
        transcriptReady,
      );
    }

    const smoke = readFileSync(join(mobileRoot, 'e2e', 'smoke.yaml'), 'utf8');
    expect(smoke.indexOf('id: chat-message-${SMOKE_LATEST_MESSAGE_ID}')).toBeGreaterThan(
      smoke.indexOf('id: chat-messages'),
    );
  });

  it('runs the governor on a node with a global WebSocket for relay provisioning', () => {
    // scripts/provision-smoke.ts connects through BuzzClient, which needs
    // globalThis.WebSocket; node 20 lacks it and died at connect time after
    // module resolution was fixed. 22 is the floor that has it.
    const releaseJob = workflow.slice(0, workflow.indexOf('  rollback:'));
    expect(releaseJob).toContain("node-version: '22'");
  });
});
