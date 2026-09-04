import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  PLATFORMS,
  compareNativeFingerprints,
} from '../../scripts/native-fingerprint.mjs';

const mobileRoot = resolve(__dirname, '../..');
const gateScript = join(mobileRoot, 'scripts/native-fingerprint.mjs');
const appConfig = readFileSync(join(mobileRoot, 'app.config.js'), 'utf8');
const fingerprintConfig = readFileSync(join(mobileRoot, 'fingerprint.config.js'), 'utf8');
const baseline = JSON.parse(
  readFileSync(join(mobileRoot, 'native-fingerprint.json'), 'utf8'),
) as { runtimeVersion: string; fingerprints: Record<string, string> };
const checksWorkflow = readFileSync(
  resolve(mobileRoot, '../../.github/workflows/checks.yml'),
  'utf8',
);

const execFileAsync = promisify(execFile);

// A real fingerprint run takes tens of seconds, so the gate is spawned
// asynchronously: a synchronous spawn would block this worker's event loop long
// enough for vitest's own progress RPC to time out.
async function runGate(args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [gateScript, ...args], {
      cwd: mobileRoot,
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr };
  } catch (failure) {
    const result = failure as { code?: number; stdout?: string; stderr?: string };
    return { status: result.code ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
}

// A fixture baseline standing in for "the committed record", so the pure
// comparison can be driven through every verdict without paying for a real
// fingerprint run.
const recorded = {
  runtimeVersion: '21',
  fingerprints: { android: 'android-old', ios: 'ios-old' },
};

describe('native fingerprint gate', () => {
  it('pins the runtime version by hand, because a computed stamp orphans installed binaries', () => {
    // v0.0.42 shipped `runtimeVersion: { policy: "fingerprint" }`. Every app
    // already installed carried the literal "21" it was built with, so it could
    // never match the published updates and reported NoUpdatesAvailable.
    expect(appConfig).toContain('runtimeVersion: "21"');
    expect(appConfig).not.toContain('policy: "fingerprint"');
    expect(baseline.runtimeVersion).toBe('21');
  });

  it('records one committed fingerprint per platform beside the runtime it belongs to', () => {
    for (const platform of PLATFORMS) {
      expect(baseline.fingerprints[platform]).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(baseline.fingerprints.android).not.toBe(baseline.fingerprints.ios);
  });

  it('keeps the runtime pin out of its own fingerprint, so bumping it settles the gate', () => {
    // Otherwise the answer to a failing gate would move the very number the
    // gate compares, and no bump could ever settle it.
    // The rest of the skip policy (the JS-only `extra` block, release/EAS
    // versions, the baked update channel) is behaviourally pinned by
    // appBranding.test.ts; only this skip exists for the gate's sake.
    expect(fingerprintConfig).toContain('ExpoConfigRuntimeVersionIfString');
  });

  it('runs as a named PR gate over exactly the inputs that can move the stamp', () => {
    expect(checksWorkflow).toContain('name: NATIVE FINGERPRINT');
    expect(checksWorkflow).toContain('run: npm run fingerprint:check');
    for (const path of [
      'apps/mobile/package.json',
      'apps/mobile/package-lock.json',
      'apps/mobile/app.config.js',
      'apps/mobile/fingerprint.config.js',
      'apps/mobile/native-fingerprint.json',
      'apps/mobile/plugins/**',
      'apps/mobile/patches/**',
    ]) {
      expect(checksWorkflow).toContain(`- '${path}'`);
    }
  });

  it('passes when the committed record still describes the tree', () => {
    expect(
      compareNativeFingerprints({
        runtimeVersion: '21',
        computed: { android: 'android-old', ios: 'ios-old' },
        baseline: recorded,
      }),
    ).toMatchObject({ ok: true });
  });

  it('fails a native change on an unchanged pin with the bump instruction', () => {
    const verdict = compareNativeFingerprints({
      runtimeVersion: '21',
      computed: { android: 'android-new', ios: 'ios-new' },
      baseline: recorded,
    });

    expect(verdict.ok).toBe(false);
    // Both platforms' old and new stamps are named, so the author can see what
    // moved without re-running anything.
    expect(verdict.message).toContain('android: android-old -> android-new');
    expect(verdict.message).toContain('ios: ios-old -> ios-new');
    expect(verdict.message).toContain('bump runtimeVersion in apps/mobile/app.config.js to "22"');
    expect(verdict.message).toContain('npm run fingerprint:write');
    expect(verdict.message).toContain('new native build');
  });

  it('names the platform that did not move, so a one-sided change is still legible', () => {
    const verdict = compareNativeFingerprints({
      runtimeVersion: '21',
      computed: { android: 'android-new', ios: 'ios-old' },
      baseline: recorded,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('android: android-old -> android-new');
    expect(verdict.message).toContain('ios: ios-old -> ios-old (unchanged)');
  });

  it('fails a bumped pin whose stamps were never re-recorded', () => {
    const verdict = compareNativeFingerprints({
      runtimeVersion: '22',
      computed: { android: 'android-new', ios: 'ios-new' },
      baseline: recorded,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('still records the old stamps');
    expect(verdict.message).toContain('npm run fingerprint:write');
  });

  it('fails a pin that moved with no native change, because a bump alone strands binaries', () => {
    const verdict = compareNativeFingerprints({
      runtimeVersion: '22',
      computed: { android: 'android-old', ios: 'ios-old' },
      baseline: recorded,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('no native input changed');
    expect(verdict.message).toContain('strands every installed binary');
  });

  it(
    'accepts this tree and rejects a real native edit, end to end',
    async () => {
      // The committed record must describe THIS tree: run the gate exactly as
      // the NATIVE FINGERPRINT job does.
      const clean = await runGate([]);
      expect(clean.stderr).toBe('');
      expect(clean.status).toBe(0);

      // Then a real altered fingerprint input. A config plugin is hashed by
      // @expo/fingerprint on both platforms, so editing one in an isolated copy
      // of the project is a genuine native change — no stubbing of the
      // fingerprint itself, which is the thing under test.
      const project = mkdtempSync(join(tmpdir(), 'beeline-native-fingerprint-'));
      for (const file of ['package.json', 'app.config.js', 'fingerprint.config.js']) {
        cpSync(join(mobileRoot, file), join(project, file));
      }
      cpSync(join(mobileRoot, 'plugins'), join(project, 'plugins'), { recursive: true });
      // node_modules is the expensive part and is not what the edit touches.
      for (const shared of ['node_modules', 'patches']) {
        symlinkSync(join(mobileRoot, shared), join(project, shared));
      }
      const baselineFile = join(project, 'native-fingerprint.json');

      const fixture = ['--project-dir', project, '--baseline', baselineFile];
      const recordedRun = await runGate(['--write', ...fixture]);
      expect(recordedRun.stderr).toBe('');
      expect(recordedRun.status).toBe(0);
      const before = JSON.parse(readFileSync(baselineFile, 'utf8'));
      expect(before.runtimeVersion).toBe('21');

      appendFileSync(join(project, 'plugins/withEinkCompatibility.js'), '\n// native change\n');
      const dirty = await runGate(fixture);

      expect(dirty.status).toBe(1);
      expect(dirty.stderr).toContain('Native inputs changed but runtimeVersion is still "21"');
      expect(dirty.stderr).toContain(
        `android: ${before.fingerprints.android} -> `,
      );
      expect(dirty.stderr).toContain(`ios: ${before.fingerprints.ios} -> `);
      expect(dirty.stderr).toContain('bump runtimeVersion in apps/mobile/app.config.js to "22"');
      expect(dirty.stderr).toContain('new native build');

      // `--write` will not quietly re-record a native change under the old pin:
      // that is the move that strands installed binaries.
      const refused = await runGate(['--write', ...fixture]);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('Native inputs changed but runtimeVersion is still "21"');
      expect(JSON.parse(readFileSync(baselineFile, 'utf8'))).toEqual(before);
    },
    240_000,
  );
});
