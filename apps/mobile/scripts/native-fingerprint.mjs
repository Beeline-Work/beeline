#!/usr/bin/env node
// The NATIVE FINGERPRINT gate.
//
// `app.config.js` pins `runtimeVersion` by hand, because an installed binary
// carries the stamp it was BUILT with: a stamp that recomputes itself per
// commit orphans every app already on a phone (v0.0.42 shipped that way and no
// installed app could see the update). The safety a computed stamp did give —
// "an OTA can never reach a binary built from different native code" — is kept
// here instead, at review time, where a human can bump the pin and ship a
// build.
//
// `native-fingerprint.json` records the Expo native fingerprint of each
// platform alongside the runtime version it belongs to. This script recomputes
// both fingerprints and fails when the committed record no longer describes
// the tree.
//
//   npm run fingerprint:check   # what CI runs
//   npm run fingerprint:write   # after a deliberate native change + pin bump
//
// `--write` refuses to record moved fingerprints under an unchanged pin: that
// is the case that strands installed binaries, so it must be a deliberate bump.
// `--write --force` records them anyway, for the one case where the stamps move
// without native code moving: an edit to fingerprint.config.js's own skip
// policy. It is a visible line in the PR either way.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_DIR = resolve(scriptDir, '..');
export const BASELINE_FILENAME = 'native-fingerprint.json';
export const PLATFORMS = ['android', 'ios'];

function parseArgs(argv) {
  const options = { write: false, force: false, projectDir: DEFAULT_PROJECT_DIR, baseline: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--write') {
      options.write = true;
      continue;
    }
    if (token === '--force') {
      options.force = true;
      continue;
    }
    if (token === '--project-dir' || token === '--baseline') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${token}`);
      }
      options[token === '--project-dir' ? 'projectDir' : 'baseline'] = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unexpected argument: ${token}`);
  }
  return options;
}

export function baselinePath(projectDir) {
  return join(projectDir, BASELINE_FILENAME);
}

// The pin lives in the real Expo config, not in a regex over the source, so the
// gate reads exactly what EAS Build and `eas update` read.
export function readPinnedRuntimeVersion(projectDir) {
  const require = createRequire(join(projectDir, 'package.json'));
  const { getConfig } = require('@expo/config');
  const { exp } = getConfig(projectDir, {
    skipSDKVersionRequirement: true,
    isPublicConfig: false,
  });
  const runtimeVersion = exp.runtimeVersion;
  if (typeof runtimeVersion !== 'string' || runtimeVersion.length === 0) {
    throw new Error(
      `app.config.js must pin runtimeVersion to a literal string; found ${JSON.stringify(
        runtimeVersion,
      )}. A computed policy re-stamps every commit and cuts installed binaries off from OTA updates.`,
    );
  }
  return runtimeVersion;
}

export async function computeNativeFingerprints(projectDir) {
  const require = createRequire(join(projectDir, 'package.json'));
  const { createFingerprintAsync } = require('@expo/fingerprint');
  const computed = {};
  for (const platform of PLATFORMS) {
    // fingerprint.config.js is read automatically from the project directory,
    // so the gate, `eas update` and EAS Build all skip the same sources.
    const { hash } = await createFingerprintAsync(projectDir, { platforms: [platform] });
    computed[platform] = hash;
  }
  return computed;
}

export function readBaseline(projectDir, baselineFile = baselinePath(projectDir)) {
  const parsed = JSON.parse(readFileSync(baselineFile, 'utf8'));
  if (typeof parsed?.runtimeVersion !== 'string' || !parsed.runtimeVersion) {
    throw new Error(`${baselineFile} records no runtimeVersion`);
  }
  for (const platform of PLATFORMS) {
    if (typeof parsed.fingerprints?.[platform] !== 'string' || !parsed.fingerprints[platform]) {
      throw new Error(`${baselineFile} records no ${platform} fingerprint`);
    }
  }
  return parsed;
}

function describeMove(baseline, computed) {
  return PLATFORMS.map(
    (platform) =>
      `  ${platform}: ${baseline.fingerprints[platform]} -> ${computed[platform]}${
        baseline.fingerprints[platform] === computed[platform] ? ' (unchanged)' : ''
      }`,
  ).join('\n');
}

function nextRuntimeSuggestion(runtimeVersion) {
  const numeric = Number.parseInt(runtimeVersion, 10);
  return Number.isNaN(numeric) ? 'the next runtime version' : String(numeric + 1);
}

// The one comparison the gate makes. `computed` is this tree's fingerprints,
// `baseline` the committed record, `runtimeVersion` the pin in app.config.js.
export function compareNativeFingerprints({ runtimeVersion, computed, baseline }) {
  const moved = PLATFORMS.filter(
    (platform) => baseline.fingerprints[platform] !== computed[platform],
  );
  const pinMoved = baseline.runtimeVersion !== runtimeVersion;

  if (moved.length === 0 && !pinMoved) return { ok: true, moved, pinMoved };

  if (moved.length > 0 && !pinMoved) {
    return {
      ok: false,
      moved,
      pinMoved,
      message: [
        `Native inputs changed but runtimeVersion is still "${runtimeVersion}".`,
        describeMove(baseline, computed),
        '',
        'An installed app only accepts an update whose runtime version matches the one',
        'it was built with, and it was built from different native code than this tree.',
        'Shipping an OTA on the same pin would deliver JS that its native side cannot run.',
        '',
        `Fix: bump runtimeVersion in apps/mobile/app.config.js to "${nextRuntimeSuggestion(
          runtimeVersion,
        )}", run`,
        '`npm run fingerprint:write --prefix apps/mobile` to record the new stamps, and ship a',
        'new native build (store + `eas build --profile beta-apk`) before the next OTA release.',
        '',
        'If nothing native actually changed, `npm ci` in apps/mobile first: the fingerprint',
        'covers the installed native dependency tree.',
      ].join('\n'),
    };
  }

  if (moved.length > 0 && pinMoved) {
    return {
      ok: false,
      moved,
      pinMoved,
      message: [
        `runtimeVersion moved from "${baseline.runtimeVersion}" to "${runtimeVersion}" and native inputs changed with it,`,
        `but ${BASELINE_FILENAME} still records the old stamps.`,
        describeMove(baseline, computed),
        '',
        'Fix: run `npm run fingerprint:write --prefix apps/mobile` and commit the result.',
      ].join('\n'),
    };
  }

  return {
    ok: false,
    moved,
    pinMoved,
    message: [
      `runtimeVersion moved from "${baseline.runtimeVersion}" to "${runtimeVersion}" but no native input changed.`,
      describeMove(baseline, computed),
      '',
      'A bump strands every installed binary until a new native build ships, so it is never a',
      'free change. If the bump is deliberate, run `npm run fingerprint:write --prefix apps/mobile`',
      `and commit the ${BASELINE_FILENAME} diff so review sees the new pin.`,
    ].join('\n'),
  };
}

function writeBaseline(baselineFile, runtimeVersion, computed, existing) {
  const record = {
    note: 'Runtime pin plus the Expo native fingerprint it belongs to. Regenerate with `npm run fingerprint:write --prefix apps/mobile`; the NATIVE FINGERPRINT gate compares this to the tree.',
    runtimeVersion,
    fingerprints: Object.fromEntries(PLATFORMS.map((platform) => [platform, computed[platform]])),
  };
  if (existing?.note && typeof existing.note === 'string') record.note = existing.note;
  writeFileSync(baselineFile, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function run(argv, { log = console.log, error = console.error } = {}) {
  const options = parseArgs(argv);
  const baselineFile = options.baseline ?? baselinePath(options.projectDir);
  const runtimeVersion = readPinnedRuntimeVersion(options.projectDir);
  const computed = await computeNativeFingerprints(options.projectDir);

  let baseline = null;
  try {
    baseline = readBaseline(options.projectDir, baselineFile);
  } catch (cause) {
    if (!options.write) {
      error(
        `${baselineFile} is missing or unreadable (${cause.message}). Run \`npm run fingerprint:write --prefix apps/mobile\` and commit it.`,
      );
      return 1;
    }
  }

  if (options.write) {
    if (baseline && !options.force) {
      const verdict = compareNativeFingerprints({ runtimeVersion, computed, baseline });
      if (verdict.moved.length > 0 && !verdict.pinMoved) {
        error(
          `${verdict.message}\n\nIf the stamps moved because fingerprint.config.js changed what it counts, and not\nbecause native code changed, re-record them with \`--write --force\`.`,
        );
        return 1;
      }
    }
    const record = writeBaseline(baselineFile, runtimeVersion, computed, baseline);
    log(
      `Recorded runtime ${record.runtimeVersion}: android ${record.fingerprints.android}, ios ${record.fingerprints.ios}`,
    );
    return 0;
  }

  const verdict = compareNativeFingerprints({ runtimeVersion, computed, baseline });
  if (!verdict.ok) {
    error(verdict.message);
    return 1;
  }
  log(
    `runtime ${runtimeVersion} still describes this tree: android ${computed.android}, ios ${computed.ios}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((cause) => {
      console.error(cause.message);
      process.exit(1);
    });
}
