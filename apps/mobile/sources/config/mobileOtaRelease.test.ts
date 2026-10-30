import {
  chmodSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// The OTA release itself (branch per release, channel pointers, reruns and
// rollback) is tested in scripts/ota-release.test.mjs against a stand-in
// eas-cli. This file keeps the on-device canary and Maestro gate contracts.
const mobileRoot = resolve(__dirname, '../..');
const canaryScript = readFileSync(join(mobileRoot, 'scripts/ota-canary.sh'), 'utf8');
const maestroScript = readFileSync(join(mobileRoot, 'scripts/maestro-e2e.sh'), 'utf8');
const workflow = readFileSync(
  resolve(mobileRoot, '../../.github/actions/mobile-ota-leg/action.yml'),
  'utf8',
);
const unifiedWorkflow = readFileSync(
  resolve(mobileRoot, '../../.github/workflows/unified-release.yml'),
  'utf8',
);
const daemonWorkflow = readFileSync(
  resolve(mobileRoot, '../../.github/actions/daemon-leg/action.yml'),
  'utf8',
);
const serverWorkflow = readFileSync(
  resolve(mobileRoot, '../../.github/actions/server-leg/action.yml'),
  'utf8',
);

// The canary and Maestro scripts run from an isolated app directory.
const fixtureParent = resolve(mobileRoot, '../../.voice-proof');
mkdirSync(fixtureParent, { recursive: true });
const releaseFixtureRoot = mkdtempSync(join(fixtureParent, 'ota-runtime-fixture-'));
writeFileSync(join(releaseFixtureRoot, 'package.json'), readFileSync(join(mobileRoot, 'package.json')));
writeFileSync(join(releaseFixtureRoot, 'app.config.js'), "module.exports={name:'Beeline',slug:'beeline',android:{runtimeVersion:'33'},ios:{runtimeVersion:'32'}};");
symlinkSync(join(mobileRoot, 'node_modules'), join(releaseFixtureRoot, 'node_modules'), 'dir');

describe('mobile OTA release canary', () => {
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
      maestroScript.indexOf('node scripts/maestro-room.mjs'),
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
    expect(maestroScript).toContain("-d 'beeline://beeline/channels'");
    expect(maestroScript).toContain('target_handler_seen=1');
    expect(maestroScript).toContain('$APP_ID is not registered for beeline://');
    expect(disableCompetitor).toBeGreaterThan(enumerateHandlers);
    expect(disableCompetitor).toBeLessThan(runFlow);
    expect(restoreCompetitor).toBeGreaterThan(-1);
    expect(maestroScript).not.toContain('uninstall "$package"');
  });

  describe('canary runner environment classification', () => {
    const barePath = '/usr/bin:/bin';
    const noAdbPath = mkdtempSync(join(tmpdir(), 'beeline-no-adb-path-'));
    for (const command of ['cat', 'dirname']) {
      const wrapper = join(noAdbPath, command);
      writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/${command} "$@"\n`);
      chmodSync(wrapper, 0o755);
    }
    const defaultMaestroDirectory = mkdtempSync(join(tmpdir(), 'beeline-maestro-stub-'));
    const defaultMaestro = join(defaultMaestroDirectory, 'maestro');
    writeFileSync(defaultMaestro, '#!/bin/sh\nexit 0\n');
    chmodSync(defaultMaestro, 0o755);

    function runCanary(args: string[] = [], env: Record<string, string | undefined> = {}) {
      return spawnSync('/bin/bash', [join(mobileRoot, 'scripts/ota-canary.sh'), ...args], {
        cwd: releaseFixtureRoot,
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
          PATH:
            env.PATH ??
            (env.ANDROID_HOME ? `${env.ANDROID_HOME}/platform-tools:${barePath}` : noAdbPath),
          ...env,
        },
      });
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
      const sdkRoot = stubAdbSdk(directory, 'List of devices attached\nemulator-5554\tdevice');
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
      const sdkRoot = stubAdbSdk(directory, 'List of devices attached\\nemulator-5554\\tdevice');
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
      const sdkRoot = stubAdbSdk(directory, 'List of devices attached\nemulator-5554\tdevice');
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
      const sdkRoot = stubAdbSdk(directory, 'List of devices attached\\nemulator-5554\\tdevice');
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
      const sdkRoot = stubAdbSdk(directory, 'List of devices attached\\nemulator-5554\\toffline');

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
      const sdkRoot = stubAdbSdk(directory, 'List of devices attached\\nemulator-5554\\tdevice');

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

    it('parks with a self-describing reason when EAS has no finished beta-apk build for the runtime version', () => {
      const directory = mkdtempSync(join(tmpdir(), 'beeline-ota-no-beta-build-'));
      const sdkRoot = stubAdbSdk(directory, 'List of devices attached\nemulator-5554\tdevice');
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
      // The one-time operator cost per runtime version is one copy-pasteable command.
      expect(reason).toContain(
        'cd apps/mobile && npx --yes eas-cli@22.2.0 build --profile beta-apk --platform android --non-interactive --no-wait',
      );
      expect(reason.split('\n')).toHaveLength(1);

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
        '      echo "adb: failed to install cmd: INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package app.usebeeline signatures do not match newer version; ignoring!"',
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

    function runMaestroGate(sdkRoot: string, env: Record<string, string | undefined> = {}) {
      return spawnSync('bash', [join(mobileRoot, 'scripts/maestro-e2e.sh')], {
        cwd: releaseFixtureRoot,
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
      expect(calls.filter((call) => call.includes('uninstall app.usebeeline'))).toHaveLength(1);
      expect(readFileSync(join(stateDir, 'uninstall_call'), 'utf8')).toBe(
        '-s emulator-5554 uninstall app.usebeeline\n',
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
        'could not remove the differently-signed existing app.usebeeline',
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
      const sdkRoot = stubAdbSdk(directory, 'List of devices attached\nemulator-5554\tdevice');
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
      const sdkRoot = stubAdbSdk(directory, 'List of devices attached\nemulator-5554\tdevice');
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
      const sdkRoot = stubAdbSdk(directory, 'List of devices attached\nemulator-5554\tdevice');
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

  it('the final release record relies on bounded component checks, not fleet or Actions device work', () => {
    expect(workflow).toContain('Point production at the exact branch beta got');
    expect(unifiedWorkflow).toContain('unified-release.mjs apply-checkpoints');
    expect(unifiedWorkflow).toContain('unified-release.mjs finalize');
    // The `release_proof` rig gate (see above) is the one bounded component
    // check that touches a device; the retired post-promote rehearsal shapes
    // stay forbidden.
    expect(unifiedWorkflow).not.toMatch(/mobile-ota-post-promote|post_promote_rehearsal/);
    expect(daemonWorkflow).toContain(
      'Record asynchronous fleet uptake without blocking the release',
    );
    expect(unifiedWorkflow).toContain('- uses: ./.github/actions/server-leg');
    expect(serverWorkflow).toContain(
      'Build the exact Fly image and capture the two-Machine rollback plan',
    );
    expect(serverWorkflow).toContain('test "$(git rev-parse HEAD)" = "$RELEASE_SHA"');
    expect(serverWorkflow).toContain('--build-arg "BEELINE_RELEASE_SHA=$RELEASE_SHA"');
    expect(serverWorkflow).toContain(
      'Canary one Machine for ninety seconds, then update its peer',
    );
    expect(serverWorkflow).toContain('trap rollback_canary ERR');
    // The canary's authenticated Room reads are the one server smoke check.
    expect(serverWorkflow).toContain('/v1/auth/review/exchange');
    expect(serverWorkflow).toContain('https://server.usebeeline.app/v1/phone/rooms/$SERVER_CANARY_ROOM_ID');
    expect(unifiedWorkflow).not.toContain('server-release-smoke');
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
    expect(canaryScript).toContain(
      'build --profile ${BUILD_PROFILE} --platform android --non-interactive',
    );
  });

  it('a provisioning-bootstrap death parks self-describingly instead of exiting as a generic smoke failure', () => {
    // The smoke stage is captured to a log...
    expect(canaryScript).toMatch(/maestro-e2e\.sh" 2>&1 \| tee "\$smoke_log"/);
    // ...its failure is classified against bootstrap signatures...
    expect(canaryScript).toMatch(
      /grep -m1 -E 'Cannot find module\|MODULE_NOT_FOUND' "\$smoke_log"/,
    );
    expect(canaryScript).toContain('its provisioning bootstrap failed before Maestro ran');
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

  it('does not repeat the script-level update identity gate in the Maestro flow', () => {
    const canaryFlow = readFileSync(join(mobileRoot, 'e2e', 'ota-canary.yaml'), 'utf8');
    const smoke = canaryFlow.indexOf('runFlow: smoke.yaml');

    expect(smoke).toBeGreaterThan(-1);
    expect(canaryFlow).not.toContain("assertVisible: 'Running update:");
    expect(canaryFlow).not.toContain("assertVisible: 'Channel: beta'");
  });
});
