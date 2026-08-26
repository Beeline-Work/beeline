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
    }, 60_000);
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
      }, 60_000);

      expect(result.stderr).not.toContain('platform-tools binary');
      expect(result.stderr).not.toContain('not attached to the shared adb server');
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('BEELINE_BETA_APK');
      expect(result.stderr).toContain('missing.apk');
    });

    it('parks when the sanctioned emulator is not attached to the adb server', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-adb-none-'));
      const sdkRoot = stubAdbSdk(directory, 'List of devices attached');

      const result = runCanary([], { ANDROID_HOME: sdkRoot });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('emulator-5554');
      expect(result.stderr).toContain('boot');
    }, 60_000);

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
    }, 60_000);

    it('writes the parked reason to OTA_CANARY_REASON_FILE on a device-gate failure', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-reason-file-'));
      const sdkRoot = stubAdbSdk(directory, 'List of devices attached');
      const reasonFile = join(directory, 'reason.txt');

      const result = runCanary([], {
        ANDROID_HOME: sdkRoot,
        OTA_CANARY_REASON_FILE: reasonFile,
      }, 60_000);

      expect(result.status).toBe(2);
      const reason = readFileSync(reasonFile, 'utf8').trim();
      expect(reason).toContain('emulator-5554');
      expect(reason).toContain('not attached to the shared adb server');
      // Exactly one line so the workflow can quote it verbatim.
      expect(reason.split('\n')).toHaveLength(1);
    });

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
    });

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
        'esac',
        'exit 0',
        '',
      ].join('\n');
      writeFileSync(join(platformTools, 'adb'), adbScript);
      chmodSync(join(platformTools, 'adb'), 0o755);
      return { sdkRoot, stateDir, callLog };
    }

    function writeDummyApk(directory: string): string {
      const apk = join(directory, 'beeline-beta.apk');
      writeFileSync(apk, 'dummy beta apk bytes');
      return apk;
    }

    it('removes exactly the canary package and retries once when the existing install has a different signature', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-signature-ok-'));
      const { sdkRoot, stateDir, callLog } = stubAdbFlow(directory, {
        installFailures: 1,
        monkeyFails: true,
      }, 60_000);
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
    });

    it('parks honestly when the incompatible existing package cannot be removed', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-signature-unins-'));
      const { sdkRoot, callLog } = stubAdbFlow(directory, {
        installFailures: 1,
        uninstallFails: true,
      }, 60_000);
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
    });

    it('parks honestly when the install still fails after removing the differently-signed package', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-signature-still-'));
      const { sdkRoot, callLog } = stubAdbFlow(directory, {
        installFailures: 99,
      }, 60_000);
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
    });

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
      }, 60_000);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('could not list EAS builds');
      expect(result.stderr).toContain('exited 7');
      expect(result.stderr).toContain('EXPO_TOKEN');
    });

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
      }, 60_000);
      const ledger = writeBetaLedger(directory);

      const result = runCanary(['--ledger', ledger], {
        ANDROID_HOME: sdkRoot,
        PATH: `${stubBin}:${barePath}`,
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('could not download the beta APK');
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
    }, 60_000);
  });

  it('the workflow parks the ledger record on canary failure and pins where adb lives', () => {
    expect(workflow).toContain('ANDROID_HOME: /home/lunchbox/android-sdk');
    expect(workflow).toContain("--status blocked");
    expect(workflow.indexOf('--status blocked')).toBeLessThan(
      workflow.indexOf('node scripts/ota-release.mjs promote'),
    );
    expect(workflow).toMatch(/Store release ledger[\s\S]*?if: always\(\) && steps\.candidate\.outcome == 'success'/);
  });

  it('the workflow records a self-describing parked reason even when the canary dies before its own handlers', () => {
    // The canary is told where to publish its one-line parked reason...
    expect(workflow).toContain('OTA_CANARY_REASON_FILE:');
    // ...stale reasons are cleared before the run...
    expect(workflow).toMatch(/rm -f "\$RUNNER_TEMP\/ota-canary-reason\.txt"/);
    // ...and a failure folds that line into the ledger reason, falling back to
    // an exit-code classification when the shell died before writing anything.
    const canaryStep = workflow.slice(
      workflow.indexOf('Run Android beta canary'),
      workflow.indexOf('Record captain-ordered canary skip'),
    );
    expect(canaryStep).toMatch(/head -n 1 "\$RUNNER_TEMP\/ota-canary-reason\.txt"/);
    expect(canaryStep).toContain('environment/setup failure');
    expect(canaryStep).toContain('ten-minute canary deadline fired');
    expect(canaryStep).toContain('canary flow failure');
    // Blocked is recorded BEFORE the step re-exits with the canary's status.
    expect(canaryStep.indexOf('--status blocked')).toBeLessThan(
      canaryStep.indexOf('exit "$canary_status"'),
    );
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
    // The empty-beta-apk-build parking names the exact remediation.
    expect(canaryScript).toContain('no finished beta-apk Android build');
    expect(canaryScript).toContain('build --profile beta-apk --platform android --non-interactive');
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
  });

  it('bridges the root smoke scripts to the mobile workspace modules they import', () => {
    const maestroScript = readFileSync(join(mobileRoot, 'scripts/maestro-e2e.sh'), 'utf8');
    // Node resolves upward from each script's real path (repo root) and never
    // reaches apps/mobile/node_modules; the bridge is declared before the
    // first provisioning invocation.
    expect(maestroScript).toMatch(/export NODE_PATH="\$MOBILE_DIR\/node_modules/);
    expect(maestroScript.indexOf('NODE_PATH')).toBeLessThan(
      maestroScript.indexOf('npx tsx scripts/provision-smoke.ts'),
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
