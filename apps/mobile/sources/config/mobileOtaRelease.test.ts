import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const mobileRoot = resolve(__dirname, '../..');
const releaseScript = join(mobileRoot, 'scripts/ota-release.mjs');
const canaryScript = readFileSync(join(mobileRoot, 'scripts/ota-canary.sh'), 'utf8');
const workflow = readFileSync(
  resolve(mobileRoot, '../../.github/workflows/mobile-ota.yml'),
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
  });

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
  });

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
  });

  it('keeps canary before promotion and exposes an off-by-default emergency bypass', () => {
    expect(workflow).toContain('default: false');
    expect(workflow).toContain('scripts/ota-canary.sh');
    expect(workflow).toContain('node scripts/ota-release.mjs promote');
    expect(workflow.indexOf('scripts/ota-canary.sh')).toBeLessThan(
      workflow.indexOf('node scripts/ota-release.mjs promote'),
    );
    expect(workflow).toContain("artifact.name.startsWith('mobile-ota-ledger-')");
    expect(workflow).toContain('previousProductionGroupId');
    expect(workflow).toContain('github.paginate(github.rest.actions.listWorkflowRuns');
  });

  it('bounds the canary and tests the candidate runtime without rebuilding native code', () => {
    expect(canaryScript).toContain('MAX_SECONDS="${OTA_CANARY_MAX_SECONDS:-540}"');
    expect(canaryScript).toContain('MAX_SECONDS > 600');
    expect(canaryScript).toContain('--build-profile beta-apk');
    expect(canaryScript).toContain('--runtime-version "$android_runtime"');
    expect(canaryScript).toContain('MAESTRO_SKIP_BUILD=1');
    expect(canaryScript).toContain('EXPECTED_ANDROID_UPDATE_ID="$android_update"');
  });
});
