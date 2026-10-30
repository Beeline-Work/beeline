#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { runtimeVersionsFromConfig } from '../apps/mobile/scripts/native-fingerprint.mjs';
import { nextDesktopVersion, normalizeDesktopVersion } from './desktop-update.mjs';

export const RELEASE_COMPONENTS = ['server', 'helper', 'mobile-ota', 'mobile-native', 'desktop', 'website'];
export const RELEASE_SOFT_LIMIT_SECONDS = 45 * 60;
export const RELEASE_NOTIFY_TIMEOUT_MS = 10_000;
export const RELEASE_NOTIFY_ENDPOINT = 'https://server.usebeeline.app/v1/releases/notify';
// One short canary window: seven samples, fifteen seconds apart. The shell
// loop in .github/actions/server-leg (`seq 0 6`, `sleep 15`) must match.
export const SERVER_CANARY_WINDOW_SECONDS = 90;
export const SERVER_CANARY_SAMPLE_SECONDS = 15;
export const SERVER_CANARY_SAMPLES = SERVER_CANARY_WINDOW_SECONDS / SERVER_CANARY_SAMPLE_SECONDS + 1;
// The desktop app bundles the web export, so shared UI edits reach it only
// when its installers rebuild. Those edits ship at once by OTA and the
// website; desktop catches up once its bundled UI is a week behind.
export const DESKTOP_UI_REFRESH_SECONDS = 7 * 24 * 60 * 60;
const DESKTOP_UI_PREFIXES = [
  'apps/mobile/sources/', 'apps/mobile/assets/',
  'packages/api-contract/', 'packages/buzz-client/', 'packages/nostr/',
];

// Release-affecting paths belong in this inspectable table, beside drift tests,
// rather than in scattered workflow conditionals.
export const COMPONENT_PATH_RULES = [
  { prefix: 'apps/server/', components: ['server'] },
  { prefix: 'apps/auth/', components: ['server'] },
  { prefix: 'apps/body/', components: ['helper'] },
  { prefix: 'packages/usebeeline/', components: ['helper'] },
  // Shared UI and protocol edits do not rebuild the desktop installers on
  // their own; see DESKTOP_UI_REFRESH_SECONDS for when desktop catches up.
  { prefix: 'packages/api-contract/', components: ['server', 'helper', 'mobile-ota'] },
  { prefix: 'packages/buzz-client/', components: ['helper', 'mobile-ota'] },
  { prefix: 'packages/nostr/', components: ['helper', 'mobile-ota'] },
  { prefix: 'apps/mobile/sources/', components: ['mobile-ota', 'website'] },
  { prefix: 'apps/mobile/assets/', components: ['mobile-ota', 'website'] },
  { prefix: 'apps/mobile/src-tauri/', components: ['desktop'] },
  { prefix: 'apps/mobile/android/', components: ['mobile-native'] },
  { prefix: 'apps/mobile/ios/', components: ['mobile-native'] },
  { prefix: 'apps/mobile/plugins/', components: ['mobile-native'] },
  { exact: 'apps/mobile/scripts/ota-release.mjs', components: ['mobile-ota'] },
  { exact: 'apps/mobile/scripts/upload-sentry-sourcemaps.mjs', components: ['mobile-ota', 'website'] },
  { exact: 'apps/mobile/scripts/prepare-web-sourcemaps.mjs', components: ['website'] },
  { exact: 'apps/mobile/scripts/store-runtime-targets.mjs', components: ['mobile-ota'] },
  { exact: 'apps/mobile/store/native-runtime-builds.json', components: ['mobile-ota'] },
  { exact: 'scripts/read-store-runtimes.mjs', components: ['mobile-ota'] },
  { exact: 'apps/mobile/scripts/ota-canary.sh', components: ['mobile-ota'] },
  { exact: 'apps/mobile/app.config.js', components: ['mobile-ota', 'mobile-native', 'desktop', 'website'] },
  { exact: 'apps/mobile/package.json', components: ['mobile-ota', 'mobile-native', 'desktop', 'website'] },
  { exact: 'apps/mobile/package-lock.json', components: ['mobile-ota', 'mobile-native', 'desktop', 'website'] },
  { prefix: 'web/', components: ['website'] },
  { prefix: 'apps/mobile/store/', components: ['website', 'mobile-native'] },
  { prefix: 'scripts/app-associations.', components: ['website'] },
  { prefix: 'scripts/pages-', components: ['website'] },
  { prefix: 'scripts/build-beeline-bundle.', components: ['helper'] },
  { prefix: 'scripts/beeline-archive.', components: ['helper'] },
  { prefix: 'scripts/mac-helper-inputs.', components: ['helper'] },
  { prefix: 'scripts/merge-beeline-bundles.', components: ['helper'] },
  { prefix: 'scripts/build-usebeeline-package.', components: ['helper'] },
  { prefix: 'scripts/install-beeline.', components: ['helper'] },
  { prefix: 'scripts/verify-beeline-install.', components: ['helper'] },
  { prefix: 'scripts/verify-pages-update.', components: ['helper', 'website'] },
  { prefix: '.github/actions/server-leg/', components: ['server'] },
  { prefix: 'infra/free-agent/', components: ['server'] },
  { exact: 'fly.beeline-free-agents.toml', components: ['server'] },
  { prefix: '.github/actions/daemon-leg/', components: ['helper'] },
  { prefix: '.github/actions/mobile-ota-leg/', components: ['mobile-ota'] },
  { prefix: '.github/actions/pages-leg/', components: ['helper', 'website'] },
  { prefix: '.github/actions/web-app-leg/', components: ['website'] },
  { prefix: 'scripts/verify-web-deployment.', components: ['website'] },
  { prefix: 'scripts/desktop-update.', components: ['desktop'] },
  { exact: '.github/workflows/desktop.yml', components: ['desktop'] },
  { exact: '.github/workflows/server-rollback.yml', components: ['server'] },
  // Pipeline edits exercise the fast legs only; they never change the helper
  // or desktop artifacts.
  { exact: '.github/workflows/unified-release.yml', components: ['server', 'mobile-ota', 'website'] },
  { exact: 'scripts/unified-release.mjs', components: ['server', 'mobile-ota', 'website'] },
  { exact: 'scripts/release-record.mjs', components: ['server', 'mobile-ota', 'website'] },
];

const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/;
const SHA = /^[0-9a-f]{7,64}$/;
const FINAL_STATES = new Set(['checked', 'carried']);
const RUNTIME_PIN_PATH = 'apps/mobile/native-fingerprint.json';
export const DESKTOP_VERSION_BASELINE = normalizeDesktopVersion(JSON.parse(readFileSync(
  new URL('../apps/mobile/src-tauri/desktop-version.json', import.meta.url), 'utf8',
)).version);

function fail(message) { throw new Error(message); }
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function writeJson(path, value) {
  if (!path) fail('missing output state path');
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function now() { return new Date().toISOString(); }

// Duration is reported, never judged: a release that shipped every selected
// component is a success however long it took. Only an unfinished component
// fails the attempt.
export function classifyReleaseAttempt({
  triggerEpoch,
  finishedEpoch,
  checkpoints = [],
  incomplete = '',
}) {
  const trigger = Number(triggerEpoch);
  const finished = Number(finishedEpoch);
  if (!Number.isFinite(trigger) || !Number.isFinite(finished)) fail('release timing requires finite epoch seconds');
  const wholeRunElapsedSeconds = Math.max(0, Math.trunc(finished) - Math.trunc(trigger));
  const otaCompletionCandidates = Array.isArray(checkpoints)
    ? checkpoints
      .filter((checkpoint) => checkpoint?.component === 'mobile-ota' && checkpoint.state === 'checked')
      .map((checkpoint) => Number(checkpoint.completedAt))
      .filter((completedAt) => Number.isFinite(completedAt) && completedAt >= trigger && completedAt <= finished)
    : [];
  const otaCompletedAt = otaCompletionCandidates.length ? Math.max(...otaCompletionCandidates) : undefined;
  const otaElapsedSeconds = otaCompletedAt === undefined
    ? wholeRunElapsedSeconds
    : Math.max(0, Math.trunc(otaCompletedAt) - Math.trunc(trigger));
  const unfinished = String(incomplete ?? '').trim();
  const failureClass = unfinished ? `component:${unfinished}` : '';
  const outcome = failureClass ? 'failure' : 'success';
  return {
    outcome,
    failureClass,
    otaElapsedSeconds,
    wholeRunElapsedSeconds,
    softLimitSeconds: RELEASE_SOFT_LIMIT_SECONDS,
    slow: outcome === 'success' && wholeRunElapsedSeconds > RELEASE_SOFT_LIMIT_SECONDS,
    ...(otaCompletedAt === undefined ? {} : { otaCompletedAt: Math.trunc(otaCompletedAt) }),
  };
}

export function planServerCanaryDeployment(machines, newImageRef) {
  if (!Array.isArray(machines) || machines.length !== 2) {
    fail(`server canary requires exactly two Machines, found ${machines?.length ?? 0}`);
  }
  if (!newImageRef?.startsWith('registry.fly.io/')) fail('server image must be an immutable Fly registry ref');
  const normalized = machines.map((machine) => ({
    id: machine.id,
    imageRef: machine.imageRef ?? machine.config?.image,
  })).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  if (normalized.some((machine) => !machine.id || !machine.imageRef)) fail('Machine inventory is missing id or image');
  // A fleet left split by an interrupted release converges on the new image.
  // Each Machine rolls back to the image it ran before this release.
  const split = new Set(normalized.map((machine) => machine.imageRef)).size !== 1;
  const [canary, second] = normalized;
  return {
    previousImageRef: canary.imageRef,
    secondPreviousImageRef: second.imageRef,
    split,
    newImageRef,
    canaryMachineId: canary.id,
    secondMachineId: second.id,
    steps: [
      'migrate',
      `update:${canary.id}:${newImageRef}`,
      `watch:${canary.id}:${SERVER_CANARY_WINDOW_SECONDS}s`,
      `update:${second.id}:${newImageRef}`,
    ],
    rollbackSteps: [
      `update:${canary.id}:${canary.imageRef}`,
      ...(split ? [`update:${second.id}:${second.imageRef}`] : []),
      'fail-release',
    ],
  };
}

function poolSnapshot(health) {
  const pool = health?.database?.pool;
  if (!pool || typeof pool !== 'object') return undefined;
  const snapshot = {
    size: Number(pool.size),
    inUse: Number(pool.inUse),
    waiting: Number(pool.waiting),
    oldestActiveQueryAgeMs: health.database.oldestActiveQueryAgeMs,
  };
  if (
    !Number.isInteger(snapshot.size) || snapshot.size < 0 ||
    !Number.isFinite(snapshot.inUse) || snapshot.inUse < 0 || snapshot.inUse > snapshot.size ||
    !Number.isFinite(snapshot.waiting) || snapshot.waiting < 0 ||
    (snapshot.oldestActiveQueryAgeMs !== null &&
      (!Number.isFinite(snapshot.oldestActiveQueryAgeMs) || snapshot.oldestActiveQueryAgeMs < 0))
  ) return undefined;
  return snapshot;
}

export function evaluateServerCanarySample({ health, roomRead, version, expectedVersion, expectedSha }) {
  const reasons = [];
  if (health?.ok !== true) reasons.push('health endpoint is not ok');
  if (roomRead?.ok !== true) reasons.push(`authenticated Room read returned HTTP ${roomRead?.status ?? 'unknown'}`);
  if (version?.version !== expectedVersion || version?.sourceSha !== expectedSha) reasons.push('canary image identity does not match the release');
  const pool = poolSnapshot(health);
  if (!pool) reasons.push('health response omitted database pool diagnostics');
  else if (pool.waiting !== 0) reasons.push(`database pool has ${pool.waiting} waiter(s)`);
  return { clean: reasons.length === 0, reasons, poolMetricsAvailable: Boolean(pool), ...(pool ? { pool } : {}) };
}

export function evaluateServerCanaryWindow(samples, windowSeconds = SERVER_CANARY_WINDOW_SECONDS) {
  if (!Array.isArray(samples) || samples.length < 2) return { clean: false, reason: 'canary window has too few samples' };
  const elapsed = (Date.parse(samples.at(-1).at) - Date.parse(samples[0].at)) / 1000;
  const failed = samples.find((sample) => sample.verdict?.clean !== true);
  if (failed) return { clean: false, reason: failed.verdict?.reasons?.join('; ') || 'unclean sample' };
  if (elapsed < windowSeconds) return { clean: false, reason: `canary window covered ${elapsed}s, expected ${windowSeconds}s` };
  return { clean: true, elapsedSeconds: elapsed, poolMetricsAvailable: samples.every((sample) => sample.verdict.poolMetricsAvailable) };
}

/** The rolling Machine may promote only after a sustained healthy window.
 * A few isolated warmup failures are tolerated, but a single good sample can
 * never mask pool contention or broken authenticated Room reads. */
export function evaluateServerCanaryPromotion(samples) {
  if (!Array.isArray(samples) || samples.length !== SERVER_CANARY_SAMPLES)
    return { clean: false, reason: `canary requires all ${SERVER_CANARY_SAMPLES} samples` };
  const elapsedSeconds = (Date.parse(samples.at(-1).at) - Date.parse(samples[0].at)) / 1000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < SERVER_CANARY_WINDOW_SECONDS)
    return { clean: false, reason: `canary did not cover the full ${SERVER_CANARY_WINDOW_SECONDS}-second window` };
  const cleanCount = samples.filter((sample) => sample.verdict?.clean === true).length;
  if (cleanCount < SERVER_CANARY_SAMPLES - 2)
    return { clean: false, reason: `only ${cleanCount} of ${SERVER_CANARY_SAMPLES} canary samples were clean` };
  if (samples.slice(-3).some((sample) => sample.verdict?.clean !== true))
    return { clean: false, reason: 'the final three canary samples were not all clean' };
  let degradedStreak = 0;
  for (const sample of samples) {
    const reasons = sample.verdict?.reasons ?? [];
    if (reasons.some((reason) => /database pool has|authenticated Room read/.test(reason)))
      degradedStreak++;
    else degradedStreak = 0;
    if (degradedStreak >= 2)
      return { clean: false, reason: 'sustained pool wait or Room read degradation' };
  }
  return { clean: true, cleanCount, elapsedSeconds };
}

export function validateReleaseIdentity(version, sourceSha) {
  if (!VERSION.test(version ?? '')) fail(`invalid release version: ${version ?? '<missing>'}`);
  if (!SHA.test(sourceSha ?? '')) fail(`invalid release sha: ${sourceSha ?? '<missing>'}`);
  return { version, sourceSha };
}

function assertComponent(component) {
  if (!RELEASE_COMPONENTS.includes(component)) fail(`unknown release component: ${component}`);
}
function matchesRule(path, rule) { return rule.exact === path || (rule.prefix && path.startsWith(rule.prefix)); }

export function selectReleaseComponents(paths, { selection = 'auto', storeTrack = 'none' } = {}) {
  if (!['none', 'internal', 'beta', 'production'].includes(storeTrack)) fail(`invalid store track: ${storeTrack}`);
  const explicit = selection !== 'auto' && selection !== '';
  // RELEASE POLICY: OTA is the default delivery and never publishes to a
  // store by itself. Store publishing happens only on an explicit
  // --store-track. A runtime-pin change does not change that: the OTA goes to
  // every runtime live in the stores today, and the new runtime waits for a
  // store release the owner chooses.
  let selected;
  if (selection === 'all') selected = new Set(RELEASE_COMPONENTS);
  else if (selection === 'auto' || selection === '') {
    selected = new Set();
    for (const path of paths) {
      for (const rule of COMPONENT_PATH_RULES) {
        if (matchesRule(path, rule)) rule.components.forEach((component) => selected.add(component));
      }
    }
  } else {
    selected = new Set(selection.split(',').map((value) => value.trim()).filter(Boolean));
    for (const component of selected) assertComponent(component);
  }
  // Path changes alone never authorize a routine native build. Explicit
  // component selection remains available for build-only recovery.
  if (!explicit && storeTrack === 'none') selected.delete('mobile-native');
  if (storeTrack !== 'none') selected.add('mobile-native');
  return RELEASE_COMPONENTS.filter((component) => selected.has(component));
}

export function selectReleaseComponentsFromPublishedInputs(
  pathsByComponent,
  { selection = 'auto', storeTrack = 'none', desktopLagSeconds = 0 } = {},
) {
  if (selection !== 'auto' && selection !== '') {
    return selectReleaseComponents([], { selection, storeTrack });
  }
  const selected = new Set(selectReleaseComponents([], { storeTrack }));
  for (const component of RELEASE_COMPONENTS) {
    const paths = pathsByComponent?.[component];
    if (!Array.isArray(paths)) fail(`missing changed paths for ${component}`);
    if (selectReleaseComponents(paths, { storeTrack }).includes(component)) selected.add(component);
  }
  if (desktopLagSeconds >= DESKTOP_UI_REFRESH_SECONDS &&
      pathsByComponent.desktop.some((path) => DESKTOP_UI_PREFIXES.some((prefix) => path.startsWith(prefix)))) {
    selected.add('desktop');
  }
  return RELEASE_COMPONENTS.filter((component) => selected.has(component));
}

/** Seconds between the commit desktop last shipped and the release commit. */
export function desktopLagFromPublishedInputs(previous, releaseSha, {
  commitTime = (sha) => Number(execFileSync('git', ['show', '-s', '--format=%ct', sha], {
    encoding: 'utf8', timeout: 30_000,
  }).trim()),
} = {}) {
  validateReleaseIdentity(previous?.version, previous?.sourceSha);
  const publishedSha = previous.components?.desktop?.sourceSha ?? previous.sourceSha;
  return Math.max(0, commitTime(releaseSha) - commitTime(publishedSha));
}

export function runtimePinChangeFromPublishedInputs(previous, releaseSha, {
  gitShow = (sha) => execFileSync('git', ['show', `${sha}:${RUNTIME_PIN_PATH}`], {
    encoding: 'utf8', timeout: 30_000,
  }),
} = {}) {
  validateReleaseIdentity(previous?.version, previous?.sourceSha);
  validateReleaseIdentity(previous.version, releaseSha);
  const readPin = (sha) => runtimeVersionsFromConfig(JSON.parse(gitShow(sha)));
  const previousPin = readPin(previous.sourceSha);
  const nextPin = readPin(releaseSha);
  const changedPlatforms = ['android', 'ios'].filter((platform) => previousPin[platform] !== nextPin[platform]);
  return { changed: changedPlatforms.length > 0, changedPlatforms, previous: previousPin, next: nextPin };
}

export function changedPathsFromPublishedInputs(previous, releaseSha, {
  gitDiff = (publishedSha, targetSha) => execFileSync(
    'git', ['diff', '--name-only', publishedSha, targetSha],
    { encoding: 'utf8', timeout: 30_000 },
  ),
} = {}) {
  validateReleaseIdentity(previous?.version, previous?.sourceSha);
  validateReleaseIdentity(previous.version, releaseSha);
  return Object.fromEntries(RELEASE_COMPONENTS.map((component) => {
    const publishedSha = previous.components?.[component]?.sourceSha ?? previous.sourceSha;
    validateReleaseIdentity(previous.version, publishedSha);
    const output = gitDiff(publishedSha, releaseSha);
    return [component, output.split(/\r?\n/).map((path) => path.trim()).filter(Boolean)];
  }));
}

export function artifactReference(component, { version, sourceSha }) {
  assertComponent(component);
  validateReleaseIdentity(version, sourceSha);
  return `${component}-${version}-${sourceSha}`;
}

// What a carried component still serves: the server image, the phone OTA
// branch and its targets. Rollbacks read these from the newest release.
const CARRIED_FACTS = ['imageRef', 'previousImageRef', 'otaBranch', 'previousOtaBranch', 'otaTargets'];

function previousComponent(previous, component) {
  const legacyName = component === 'helper' ? 'daemon' : component === 'mobile-ota' ? 'app' : component;
  const entry = previous?.components?.[component] ?? previous?.artifacts?.[legacyName];
  if (!entry && previous?.schemaVersion !== 1) fail(`previous release has no ${component} artifact to carry forward`);
  // Schema 1 recorded only the old three core legs. The first schema-2 release
  // migrates the already-live stable desktop/site/store references once; every
  // later release requires the explicit component entry above.
  if (!entry) {
    validateReleaseIdentity(previous.version, previous.sourceSha);
    return {
      state: 'carried', selected: false, version: previous.version, sourceSha: previous.sourceSha,
      artifactRef: `legacy-${component}-${previous.version}-${previous.sourceSha}`,
      ...(component === 'desktop' ? { desktopVersion: DESKTOP_VERSION_BASELINE } : {}),
    };
  }
  const version = entry.version ?? previous.version;
  const sourceSha = entry.sourceSha ?? entry.sourceCommit ?? previous.sourceSha;
  validateReleaseIdentity(version, sourceSha);
  const facts = Object.fromEntries(CARRIED_FACTS.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]));
  return {
    ...facts,
    state: 'carried', selected: false, version, sourceSha,
    artifactRef: entry.artifactRef ?? artifactReference(component, { version, sourceSha }),
    ...(component === 'desktop' ? {
      desktopVersion: normalizeDesktopVersion(entry.desktopVersion ?? DESKTOP_VERSION_BASELINE),
    } : {}),
  };
}

function desktopVersionForRelease(previous) {
  return nextDesktopVersion(previous?.components?.desktop?.desktopVersion ?? DESKTOP_VERSION_BASELINE);
}

// A rerun of an identity plans exactly what a first attempt would: there is
// no attempt file. Each leg asks its own system whether its output already
// shipped and skips what did.
export function initializeRelease({ version, sourceSha, previous, selectedComponents = RELEASE_COMPONENTS, runtimePin, startedAt = now() }) {
  validateReleaseIdentity(version, sourceSha);
  const selected = new Set(selectedComponents);
  selected.forEach(assertComponent);
  if (previous?.sourceSha === sourceSha) {
    if (previous.version !== version) fail(`sha ${sourceSha} is already assigned to ${previous.version}, not ${version}`);
    const supplemental = previous.state === 'delivered' ? RELEASE_COMPONENTS.filter((component) => {
      const entry = previous.components?.[component];
      return selected.has(component) && entry?.state === 'carried' && entry.sourceSha !== sourceSha;
    }) : [];
    if (supplemental.length === 0) return structuredClone(previous);
    const state = structuredClone(previous);
    for (const component of supplemental) {
      state.components[component] = {
        state: 'pending', selected: true, version, sourceSha,
        artifactRef: artifactReference(component, { version, sourceSha }),
        ...(component === 'desktop' ? { desktopVersion: desktopVersionForRelease(previous) } : {}),
      };
    }
    state.state = 'planned';
    state.startedAt = startedAt;
    state.updatedAt = startedAt;
    state.plan = {
      selected: supplemental,
      carried: RELEASE_COMPONENTS.filter((component) => !supplemental.includes(component)),
      nativePlatforms: runtimePin?.changed ? (runtimePin.changedPlatforms ?? ['android', 'ios']) : ['android', 'ios'],
      ...(runtimePin ? { runtimePinChanged: runtimePin.changed, previousRuntimeVersion: runtimePin.previous, nextRuntimeVersion: runtimePin.next } : {}),
    };
    state.delivery = { state: 'pending' };
    return state;
  }
  if (selected.size !== RELEASE_COMPONENTS.length && !previous) fail('a selective release requires a previous successful release index');
  const components = {};
  for (const component of RELEASE_COMPONENTS) {
    components[component] = selected.has(component)
      ? {
          state: 'pending', selected: true, version, sourceSha,
          artifactRef: artifactReference(component, { version, sourceSha }),
          ...(component === 'desktop' ? { desktopVersion: desktopVersionForRelease(previous) } : {}),
        }
      : previousComponent(previous, component);
  }
  return {
    schemaVersion: 2, version, sourceSha, state: 'planned', startedAt, updatedAt: startedAt,
    ...(previous ? { supersedes: { version: previous.version, sourceSha: previous.sourceSha } } : {}),
    plan: {
      selected: RELEASE_COMPONENTS.filter((component) => selected.has(component)),
      carried: RELEASE_COMPONENTS.filter((component) => !selected.has(component)),
      nativePlatforms: runtimePin?.changed ? (runtimePin.changedPlatforms ?? ['android', 'ios']) : ['android', 'ios'],
      ...(runtimePin ? { runtimePinChanged: runtimePin.changed, previousRuntimeVersion: runtimePin.previous, nextRuntimeVersion: runtimePin.next } : {}),
    },
    components, delivery: { state: 'pending' },
  };
}

function currentRelease(state) {
  if (state?.schemaVersion !== 2) fail('unsupported unified release state');
  validateReleaseIdentity(state.version, state.sourceSha);
  return state;
}
function componentEntry(state, component) {
  assertComponent(component);
  return state.components?.[component] ?? fail(`release state has no ${component} component`);
}

export function markComponentStage(state, component, stage, identity = state, artifactRef) {
  currentRelease(state);
  const entry = componentEntry(state, component);
  if (!entry.selected) fail(`${component} is carried forward and cannot run`);
  validateReleaseIdentity(identity.version, identity.sourceSha);
  if (identity.version !== state.version || identity.sourceSha !== state.sourceSha) fail(`mixed release identity for ${component}`);
  const allowed = { built: ['pending', 'built'], promoted: ['built', 'promoted'], checked: ['promoted', 'checked'] };
  if (!allowed[stage]?.includes(entry.state)) fail(`${component} cannot move from ${entry.state} to ${stage}`);
  state.components[component] = { ...entry, state: stage, artifactRef: artifactRef ?? entry.artifactRef, [`${stage}At`]: now() };
  state.updatedAt = now();
  return state;
}

export function pendingComponents(state) {
  currentRelease(state);
  return Object.fromEntries(RELEASE_COMPONENTS.map((component) => {
    const entry = componentEntry(state, component);
    return [component, entry.selected && entry.state !== 'checked'];
  }));
}

export function applyComponentCheckpoints(state, checkpoints) {
  currentRelease(state);
  const rank = { pending: 0, built: 1, promoted: 2, checked: 3 };
  for (const checkpoint of checkpoints) {
    const { component, version, sourceSha, state: stage, artifactRef } = checkpoint ?? {};
    assertComponent(component);
    if (version !== state.version || sourceSha !== state.sourceSha) {
      fail(`checkpoint identity for ${component} does not match release`);
    }
    const entry = componentEntry(state, component);
    if (!entry.selected) fail(`checkpoint supplied for carried component ${component}`);
    if (!['built', 'promoted', 'checked'].includes(stage) || !artifactRef) fail(`invalid ${component} checkpoint`);
    if (rank[stage] < rank[entry.state]) continue;
    state.components[component] = { ...entry, state: stage, artifactRef, [`${stage}At`]: checkpoint[`${stage}At`] ?? now() };
  }
  state.updatedAt = now();
  return state;
}

export function finalizeRelease(state, { outcome = 'success', finishedAt = now(), failureClass, unproven } = {}) {
  currentRelease(state);
  if (!['success', 'failure'].includes(outcome)) fail(`invalid release outcome: ${outcome}`);
  if (outcome === 'success') {
    for (const component of RELEASE_COMPONENTS) {
      const entry = componentEntry(state, component);
      if (!FINAL_STATES.has(entry.state) || !entry.artifactRef) fail(`${component} has no delivered or carried artifact`);
    }
  } else if (!failureClass) fail('failed releases require a failure class');
  const durationSeconds = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(state.startedAt)) / 1000));
  state.state = outcome === 'success' ? 'delivered' : 'failed';
  state.delivery = {
    state: outcome,
    finishedAt,
    durationSeconds,
    ...(failureClass ? { failureClass } : {}),
    // Escape-hatch audit: a release promoted while the release proof was
    // bypassed (skipped or failed) carries the reason on the record forever.
    ...(outcome === 'success' && unproven ? { unproven: String(unproven) } : {}),
  };
  state.updatedAt = finishedAt;
  return state;
}

export function releasePlanSummary(state) {
  currentRelease(state);
  return {
    identity: `${state.version}@${state.sourceSha}`,
    selected: state.plan.selected,
    carried: Object.fromEntries(state.plan.carried.map((component) => {
      const entry = componentEntry(state, component);
      return [component, `${entry.version}@${entry.sourceSha} (${entry.artifactRef})`];
    })),
    run: pendingComponents(state),
  };
}

// Each component's job result is its checkpoint: a job that succeeded checked
// its component. Keys are the workflow job ids in unified-release.yml.
const COMPONENT_JOBS = {
  server: ['server'],
  helper: ['helper'],
  'mobile-ota': ['mobile_ota', 'mobile_ota_after_proof'],
  desktop: ['desktop_installers'],
  website: ['website'],
};
const ARTIFACT_PREFIX = {
  server: 'server-artifact', helper: 'daemon-artifact', 'mobile-ota': 'mobile-ota-release',
  'mobile-native': 'mobile-native', desktop: 'beeline-desktop-release', website: 'website',
};

export function checkpointsFromJobs(needs, { version, sourceSha, releaseId }) {
  validateReleaseIdentity(version, sourceSha);
  const plan = needs?.initialize?.outputs ?? fail('job results need the initialize outputs');
  const succeeded = (job) => needs[job]?.result === 'success';
  const checkpoint = (component, extra = {}) => ({
    component, version, sourceSha, state: 'checked',
    artifactRef: `${ARTIFACT_PREFIX[component]}-${releaseId}${component === 'desktop' ? '-*' : ''}`, ...extra,
  });
  const checkpoints = [];
  for (const [component, jobs] of Object.entries(COMPONENT_JOBS)) {
    if (plan[`run_${component.replace('-', '_')}`] !== 'true') continue;
    const job = jobs.find(succeeded);
    if (!job) continue;
    const completedAt = Number(needs[job].outputs?.completed_at);
    checkpoints.push(checkpoint(component, Number.isFinite(completedAt) && completedAt > 0 ? { completedAt } : {}));
  }
  const native = ['android', 'ios'].every((platform) =>
    plan[`native_${platform}`] !== 'true' || succeeded(`mobile_native_${platform}`));
  if (plan.run_mobile_native === 'true' && native) checkpoints.push(checkpoint('mobile-native'));
  return checkpoints;
}

const FLY_IMAGE = /^registry\.fly\.io\/[a-z0-9-]+:[A-Za-z0-9._-]+$/;
const OTA_BRANCH = /^(?:release-[A-Za-z0-9._-]+|production)$/;

function parseJsonOutput(value, label) {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { fail(`${label} is not JSON`); }
}

/**
 * Folds what each finished job reported through its job outputs into the
 * release record: the server image (and the image it replaced), the phone OTA
 * branch, and any store build numbers. Job outputs live only inside this run;
 * the record is the one thing the next run reads.
 */
export function applyJobFacts(state, needs, { previous, runtimePins = {} } = {}) {
  currentRelease(state);
  const server = state.components.server;
  const serverOutputs = needs?.server?.outputs ?? {};
  if (server.selected && server.state === 'checked') {
    if (!FLY_IMAGE.test(serverOutputs.image_ref ?? '')) fail('the server job reported no image');
    server.imageRef = serverOutputs.image_ref;
    // Rollback returns to the previous published release's image, never to
    // whatever the fleet ran before: that may be an attempt that deployed and
    // then failed elsewhere. Only a migrated record, which names no image,
    // falls back to the image the fleet replaced.
    const usable = (ref) => (FLY_IMAGE.test(ref ?? '') && ref !== server.imageRef ? ref : undefined);
    server.previousImageRef = usable(previous?.components?.server?.imageRef)
      ?? usable(serverOutputs.previous_image_ref)
      ?? usable(previous?.components?.server?.previousImageRef);
  }
  const ota = state.components['mobile-ota'];
  if (ota.selected && ota.state === 'checked') {
    const job = ['mobile_ota', 'mobile_ota_after_proof'].find((name) => needs?.[name]?.result === 'success');
    const outputs = needs[job].outputs ?? {};
    if (!OTA_BRANCH.test(outputs.ota_branch ?? '')) fail('the mobile OTA job reported no branch');
    ota.otaBranch = outputs.ota_branch;
    ota.previousOtaBranch = previous?.components?.['mobile-ota']?.otaBranch ?? 'production';
    if (ota.previousOtaBranch === ota.otaBranch) ota.previousOtaBranch = previous?.components?.['mobile-ota']?.previousOtaBranch;
    ota.otaTargets = (outputs.ota_targets ?? '').split(',').filter(Boolean);
    const storeRuntime = parseJsonOutput(outputs.store_runtime, 'store_runtime');
    if (storeRuntime) state.storeRuntime = { ...state.storeRuntime, previouslyLive: storeRuntime.previouslyLive ?? [] };
  }
  // Store builds this release uploaded become known OTA runtimes once live.
  const builds = [...(previous?.storeRuntime?.builds ?? [])];
  for (const [platform, job, key] of [['android', 'mobile_native_android', 'version_code'], ['ios', 'mobile_native_ios', 'build_number']]) {
    const buildNumber = needs?.[job]?.result === 'success' ? needs[job].outputs?.[key] : '';
    if (!buildNumber || !/^\d+$/.test(runtimePins[platform] ?? '')) continue;
    if (!builds.some((build) => build.platform === platform && String(build.buildNumber) === String(buildNumber))) {
      builds.push({ platform, buildNumber: String(buildNumber), runtimeVersion: runtimePins[platform], evidence: `${state.version} (${state.sourceSha})` });
    }
  }
  state.storeRuntime = {
    builds,
    previouslyLive: state.storeRuntime?.previouslyLive ?? previous?.storeRuntime?.previouslyLive ?? [],
  };
  state.updatedAt = now();
  return state;
}

/** The state without its changed-path lists, small enough for a job output. */
export function compactState(state) {
  const compact = structuredClone(state);
  if (compact.plan) {
    delete compact.plan.paths;
    delete compact.plan.componentPaths;
  }
  return compact;
}

/** The initialize job's outputs: one line each, the state as compact JSON. */
export function planOutputs(state, previous) {
  const plan = state.plan;
  const lines = [
    `release_state=${JSON.stringify(compactState(state))}`,
    `ota_memory=${JSON.stringify(otaMemory(previous))}`,
    `previous_record=${previous ? JSON.stringify(compactState(previous)) : ''}`,
    `no_op=${state.state === 'delivered'}`,
    `runtime_pin_changed=${plan.runtimePinChanged ?? false}`,
    `desktop_version=${state.components.desktop.desktopVersion}`,
    ...['android', 'ios'].map((platform) => `native_${platform}=${(plan.nativePlatforms ?? ['android', 'ios']).includes(platform)}`),
    ...Object.entries(pendingComponents(state)).map(([component, run]) => `run_${component.replace('-', '_')}=${run}`),
  ];
  return `${lines.join('\n')}\n`;
}

/** What the OTA leg needs from the previous release: no file, a job output. */
export function otaMemory(previous) {
  const ota = previous?.components?.['mobile-ota'];
  return {
    builds: previous?.storeRuntime?.builds ?? [],
    previouslyLive: previous?.storeRuntime?.previouslyLive ?? [],
    ...(ota?.otaTargets?.length ? {
      previousTargets: ota.otaTargets.map((key) => {
        const [platform, runtimeVersion] = key.split('@');
        return { platform, runtimeVersion };
      }),
    } : {}),
    previousBranch: ota?.otaBranch ?? 'production',
  };
}

export async function notifyRelease({
  version,
  sourceSha,
  repository,
  secret,
  timeoutMs = RELEASE_NOTIFY_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  validateReleaseIdentity(version, sourceSha);
  if (!secret) return { state: 'skipped', detail: 'notification secret is not configured' };
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(RELEASE_NOTIFY_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        version,
        sha: sourceSha,
        changelogUrl: `https://github.com/${repository}/releases/tag/${version}`,
      }),
      signal,
    });
    if (!response.ok) return { state: 'warning', detail: `server returned HTTP ${response.status}` };
    return { state: 'sent', detail: `server returned HTTP ${response.status}` };
  } catch (error) {
    if (signal.aborted) return { state: 'warning', detail: `timed out after ${timeoutMs}ms` };
    const detail = error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : String(error);
    return { state: 'warning', detail: `delivery failed: ${detail}` };
  }
}

function options(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) parsed._.push(value);
    else parsed[value.slice(2)] = argv[++index];
  }
  return parsed;
}
function identityFromOptions(args) { return { version: args.version, sourceSha: args.sha }; }

async function main(argv) {
  const args = options(argv);
  const command = args._[0];
  if (command === 'component-paths') {
    const previous = args.previous ? readJson(args.previous) : fail('missing previous release');
    const componentPaths = changedPathsFromPublishedInputs(previous, args.sha);
    writeJson(args.output, componentPaths);
    if (args['paths-output']) {
      const paths = [...new Set(Object.values(componentPaths).flat())].sort();
      writeFileSync(args['paths-output'], paths.length ? `${paths.join('\n')}\n` : '');
    }
    return;
  }
  if (command === 'plan') {
    const previous = args.previous ? readJson(args.previous) : undefined;
    const paths = args.paths ? readFileSync(args.paths, 'utf8').split(/\r?\n/).map((path) => path.trim()).filter(Boolean) : [];
    const componentPaths = args['component-paths'] ? readJson(args['component-paths']) : undefined;
    const selection = args.selection ?? 'auto';
    const runtimePin = previous ? runtimePinChangeFromPublishedInputs(previous, args.sha) : undefined;
    const desktopLagSeconds = previous && componentPaths ? desktopLagFromPublishedInputs(previous, args.sha) : 0;
    const selectOptions = { selection, storeTrack: args['store-track'] ?? 'none', desktopLagSeconds };
    const selectedComponents = componentPaths
      ? selectReleaseComponentsFromPublishedInputs(componentPaths, selectOptions)
      : selectReleaseComponents(paths, selectOptions);
    const state = initializeRelease({ ...identityFromOptions(args), previous, selectedComponents, runtimePin });
    state.plan.paths = paths;
    if (componentPaths) state.plan.componentPaths = componentPaths;
    state.plan.selection = selection;
    if (runtimePin?.changed && !selectedComponents.includes('mobile-native')) {
      // The new runtime has no store binary yet; the OTA still reaches every
      // runtime live in the stores, and the new one waits for a store release.
      console.log(`::notice title=Runtime pin changed without a store release::${runtimePin.changedPlatforms.map((platform) => `${platform} ${runtimePin.previous[platform]} -> ${runtimePin.next[platform]}`).join(', ')}; the OTA targets the live store runtimes and the new runtime waits for a store release`);
    }
    writeJson(args.state, state);
    if (args.summary) writeJson(args.summary, releasePlanSummary(state));
    else console.log(JSON.stringify(releasePlanSummary(state)));
    if (args.outputs) appendFileSync(args.outputs, planOutputs(state, previous));
    return;
  }
  if (command === 'notify') {
    const result = await notifyRelease({
      ...identityFromOptions(args),
      repository: args.repository,
      secret: process.env.BEELINE_RELEASE_NOTIFY_SECRET,
    });
    if (args.output) writeJson(args.output, result);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `state=${result.state}\ndetail=${result.detail}\n`);
    }
    if (result.state === 'warning') console.error(`::warning title=Release notification not delivered::${result.detail}`);
    else console.log(`Release notification ${result.state}: ${result.detail}`);
    return;
  }
  if (command === 'classify-attempt') {
    const checkpoints = args.checkpoints ? readJson(args.checkpoints) : [];
    const result = classifyReleaseAttempt({
      triggerEpoch: args['trigger-epoch'],
      finishedEpoch: args['finished-epoch'],
      checkpoints,
      incomplete: args.incomplete,
    });
    if (args.output) writeJson(args.output, result);
    else console.log(JSON.stringify(result));
    return;
  }
  if (command === 'server-deploy-plan') {
    const plan = planServerCanaryDeployment(readJson(args.machines), args.image);
    if (args.output) writeJson(args.output, plan);
    console.log(`${plan.split ? 'converge split fleet: ' : ''}${plan.steps.join(' -> ')}`);
    console.log(`on failure: ${plan.rollbackSteps.join(' -> ')}`);
    return;
  }
  if (command === 'server-canary-sample') {
    const verdict = evaluateServerCanarySample({
      health: readJson(args.health),
      roomRead: { ok: args['room-status'] === '200', status: Number(args['room-status']) },
      version: readJson(args.version),
      expectedVersion: args['expected-version'],
      expectedSha: args['expected-sha'],
    });
    if (args.output) writeJson(args.output, verdict);
    console.log(JSON.stringify(verdict));
    if (!verdict.clean) process.exitCode = 1;
    return;
  }
  if (command === 'server-canary-promotion') {
    const samples = readFileSync(args.samples, 'utf8').trim().split('\n').map(JSON.parse);
    const verdict = evaluateServerCanaryPromotion(samples);
    console.log(JSON.stringify(verdict));
    if (!verdict.clean) process.exitCode = 1;
    return;
  }
  if (command === 'job-checkpoints') {
    const checkpoints = checkpointsFromJobs(readJson(args.needs), {
      ...identityFromOptions(args), releaseId: args['release-id'],
    });
    writeJson(args.output, checkpoints);
    return;
  }
  const state = readJson(args.state);
  if (command === 'apply-facts') {
    applyJobFacts(state, readJson(args.needs), {
      previous: args.previous ? readJson(args.previous) : undefined,
      runtimePins: args.pins ? runtimeVersionsFromConfig(readJson(args.pins)) : {},
    });
    writeJson(args.state, state);
    return;
  }
  if (command === 'apply-checkpoints') {
    const checkpoints = args.checkpoints ? readJson(args.checkpoints) : fail('missing checkpoints file');
    if (!Array.isArray(checkpoints)) fail('checkpoints file must contain an array');
    applyComponentCheckpoints(state, checkpoints);
    writeJson(args.state, state);
    if (args.summary) writeJson(args.summary, releasePlanSummary(state));
    return;
  }
  if (command === 'finalize') {
    if (args.unproven && args.outcome !== 'success') fail('--unproven only applies to successful releases');
    finalizeRelease(state, { outcome: args.outcome, failureClass: args['failure-class'], unproven: args.unproven });
    writeJson(args.state, state);
    return;
  }
  fail('Usage: unified-release.mjs <component-paths|plan|job-checkpoints|classify-attempt|server-deploy-plan|server-canary-sample|server-canary-promotion|apply-facts|apply-checkpoints|finalize|notify>');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
