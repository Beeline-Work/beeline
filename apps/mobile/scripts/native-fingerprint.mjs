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
  return runtimeVersionsFromConfig(exp);
}

// Old release records used one global pin; Expo platform overrides win.
export function runtimeVersionsFromConfig(config) {
  return Object.fromEntries(
    PLATFORMS.map((platform) => {
      const pin = config?.[platform]?.runtimeVersion ?? config?.runtimeVersion;
      if (typeof pin !== 'string' || !pin.trim()) {
        throw new Error(`${platform}.runtimeVersion must be a nonempty literal string`);
      }
      return [platform, pin];
    }),
  );
}

export async function computeNativeFingerprints(projectDir) {
  const require = createRequire(join(projectDir, 'package.json'));
  const { createFingerprintAsync } = require('@expo/fingerprint');
  const computed = {};
  for (const platform of PLATFORMS) {
    // Start with the shared fingerprint policy, then isolate the one plugin
    // whose mods and Kotlin implementation are exclusively Android.
    const config = require(join(projectDir, 'fingerprint.config.js'));
    const iosOnly =
      platform === 'ios'
        ? {
            // This plugin installs Android mods only. Shared plugins still count on
            // both platforms; an Android Kotlin edit must not strand installed iOS.
            ignorePaths: [
              ...(config.ignorePaths ?? []),
              'plugins/room-notifications',
              'plugins/room-notifications/**',
              'plugins/withRoomNotificationGroups.js',
            ],
            fileHookTransform(source, chunk, ...rest) {
              const transformed = config.fileHookTransform?.(source, chunk, ...rest) ?? chunk;
              if (
                source.type !== 'contents' ||
                source.id !== 'expoConfig' ||
                typeof transformed !== 'string'
              )
                return transformed;
              const value = JSON.parse(transformed);
              value.plugins = value.plugins?.filter(
                (plugin) =>
                  (Array.isArray(plugin) ? plugin[0] : plugin) !== 'withRoomNotificationGroups',
              );
              return JSON.stringify(value);
            },
          }
        : {};
    const { hash } = await createFingerprintAsync(projectDir, {
      platforms: [platform],
      ...iosOnly,
    });
    computed[platform] = hash;
  }
  return computed;
}

export function readBaseline(projectDir, baselineFile = baselinePath(projectDir)) {
  const parsed = JSON.parse(readFileSync(baselineFile, 'utf8'));
  runtimeVersionsFromConfig(parsed);
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
  const pins =
    typeof runtimeVersion === 'string'
      ? Object.fromEntries(PLATFORMS.map((platform) => [platform, runtimeVersion]))
      : runtimeVersion;
  const previous = runtimeVersionsFromConfig(baseline);
  const bumped = PLATFORMS.filter((platform) => previous[platform] !== pins[platform]);
  const pinMoved = bumped.length > 0;
  const unbumped = moved.filter((platform) => !bumped.includes(platform));
  if (moved.length === 0 && !pinMoved) return { ok: true, moved, pinMoved, unbumped };
  const detail = describeMove(baseline, computed);
  let message;
  if (unbumped.length) {
    message = unbumped
      .map(
        (platform) =>
          `Native inputs changed but ${platform}.runtimeVersion is still "${pins[platform]}".\n` +
          `Fix: bump ${platform}.runtimeVersion in apps/mobile/app.config.js to "${nextRuntimeSuggestion(pins[platform])}" and ship that platform's new native build.`,
      )
      .join('\n');
  } else if (moved.length) {
    message = 'The runtime pin moved but the committed baseline still records the old stamps.';
  } else {
    message =
      'The runtime pin moved but no native input changed. A bump strands every installed binary on that platform until its new native build ships.';
  }
  return {
    ok: false,
    moved,
    pinMoved,
    unbumped,
    message: `${message}\n${detail}\nRun \`npm run fingerprint:write --prefix apps/mobile\` and commit ${BASELINE_FILENAME}.`,
  };
}

function writeBaseline(baselineFile, runtimeVersion, computed, existing) {
  const record = {
    note: 'Runtime pin plus the Expo native fingerprint it belongs to. Regenerate with `npm run fingerprint:write --prefix apps/mobile`; the NATIVE FINGERPRINT gate compares this to the tree.',
    ...Object.fromEntries(
      PLATFORMS.map((platform) => [platform, { runtimeVersion: runtimeVersion[platform] }]),
    ),
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
      if (verdict.unbumped.length > 0) {
        error(
          `${verdict.message}\n\nIf the stamps moved because fingerprint.config.js changed what it counts, and not\nbecause native code changed, re-record them with \`--write --force\`.`,
        );
        return 1;
      }
    }
    const record = writeBaseline(baselineFile, runtimeVersion, computed, baseline);
    log(
      `Recorded runtime ${JSON.stringify(runtimeVersion)}: android ${record.fingerprints.android}, ios ${record.fingerprints.ios}`,
    );
    return 0;
  }

  const verdict = compareNativeFingerprints({ runtimeVersion, computed, baseline });
  if (!verdict.ok) {
    error(verdict.message);
    return 1;
  }
  log(
    `runtime ${JSON.stringify(runtimeVersion)} still describes this tree: android ${computed.android}, ios ${computed.ios}`,
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
