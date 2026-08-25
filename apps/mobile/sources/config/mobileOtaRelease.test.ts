import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  describe('canary runner environment classification', () => {
    const barePath = '/usr/bin:/bin';

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
          canary: { status: 'pending' },
        }),
      );
      return ledger;
    }

    function stubAdbSdk(directory: string, devicesOutput: string): string {
      const platformTools = join(directory, 'platform-tools');
      mkdirSync(platformTools, { recursive: true });
      const adb = join(platformTools, 'adb');
      writeFileSync(adb, `#!/bin/sh\nprintf '${devicesOutput}\\n'\n`);
      chmodSync(adb, 0o755);
      return directory;
    }

    it('parks with an actionable reason when no adb is reachable from the runner environment', () => {
      const result = runCanary();

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('platform-tools');
      expect(result.stderr).toContain('ANDROID_HOME');
      expect(result.stderr).not.toContain('requires the existing Android emulator');
    });

    it('resolves adb from ANDROID_HOME when PATH lacks it and proceeds past the device gate', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-adb-ok-'));
      const sdkRoot = stubAdbSdk(
        directory,
        'List of devices attached\\nemulator-5554\\tdevice',
      );
      const ledger = writeBetaLedger(directory);

      // A missing APK proves the run got past adb resolution AND the device
      // gate without touching a real emulator or the network.
      const result = runCanary(['--ledger', ledger], {
        ANDROID_HOME: sdkRoot,
        BEELINE_BETA_APK: join(directory, 'missing.apk'),
      });

      expect(result.stderr).not.toContain('platform-tools binary');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Beta APK not found');
    });

    it('parks when the sanctioned emulator is not attached to the adb server', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-adb-none-'));
      const sdkRoot = stubAdbSdk(directory, 'List of devices attached');

      const result = runCanary([], { ANDROID_HOME: sdkRoot });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('emulator-5554');
      expect(result.stderr).toContain('boot');
    });

    it('parks when the emulator is attached but not ready', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-adb-offline-'));
      const sdkRoot = stubAdbSdk(
        directory,
        'List of devices attached\\nemulator-5554\\toffline',
      );

      const result = runCanary([], { ANDROID_HOME: sdkRoot });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('offline');
      expect(result.stderr).toContain('not ready');
    });
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
  });

  it('the workflow parks the ledger record on canary failure and pins where adb lives', () => {
    expect(workflow).toContain('ANDROID_HOME: /home/lunchbox/android-sdk');
    expect(workflow).toContain("--status blocked");
    expect(workflow.indexOf('--status blocked')).toBeLessThan(
      workflow.indexOf('node scripts/ota-release.mjs promote'),
    );
    expect(workflow).toMatch(/Store release ledger[\s\S]*?if: always\(\) && steps\.candidate\.outcome == 'success'/);
  });
});
