#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { runtimeVersionsFromConfig } from '../apps/mobile/scripts/native-fingerprint.mjs';
import { nextDesktopVersion, normalizeDesktopVersion } from './desktop-update.mjs';

export const RELEASE_COMPONENTS = ['server', 'helper', 'mobile-ota', 'mobile-native', 'desktop', 'website'];
export const RELEASE_BUDGET_MINUTES = 20;
export const RELEASE_NOTIFY_TIMEOUT_MS = 10_000;
export const RELEASE_NOTIFY_ENDPOINT = 'https://server.usebeeline.app/v1/releases/notify';
export const SERVER_CANARY_WINDOW_SECONDS = 300;
export const SERVER_CANARY_SAMPLE_SECONDS = 15;

// Release-affecting paths belong in this inspectable table, beside drift tests,
// rather than in scattered workflow conditionals.
export const COMPONENT_PATH_RULES = [
  { prefix: 'apps/server/', components: ['server'] },
  { prefix: 'apps/auth/', components: ['server'] },
  { prefix: 'apps/push-gateway/', components: ['server'] },
  { prefix: 'apps/body/', components: ['helper'] },
  { prefix: 'packages/usebeeline/', components: ['helper'] },
  { prefix: 'packages/gate/', components: ['helper'] },
  { prefix: 'packages/api-contract/', components: ['server', 'helper', 'mobile-ota', 'desktop'] },
  { prefix: 'packages/buzz-client/', components: ['helper', 'mobile-ota', 'desktop'] },
  { prefix: 'packages/nostr/', components: ['helper', 'mobile-ota', 'desktop'] },
  { prefix: 'apps/mobile/sources/', components: ['mobile-ota', 'desktop', 'website'] },
  { prefix: 'apps/mobile/assets/', components: ['mobile-ota', 'desktop', 'website'] },
  { prefix: 'apps/mobile/src-tauri/', components: ['desktop'] },
  { prefix: 'apps/mobile/android/', components: ['mobile-native'] },
  { prefix: 'apps/mobile/ios/', components: ['mobile-native'] },
  { prefix: 'apps/mobile/plugins/', components: ['mobile-native'] },
  { exact: 'apps/mobile/scripts/ota-release.mjs', components: ['mobile-ota'] },
  { exact: 'apps/mobile/scripts/ota-delivery-index.mjs', components: ['mobile-ota'] },
  { exact: 'apps/mobile/scripts/ota-canary.sh', components: ['mobile-ota'] },
  { exact: 'apps/mobile/app.config.js', components: ['mobile-ota', 'mobile-native', 'desktop', 'website'] },
  { exact: 'apps/mobile/package.json', components: ['mobile-ota', 'mobile-native', 'desktop', 'website'] },
  { exact: 'apps/mobile/package-lock.json', components: ['mobile-ota', 'mobile-native', 'desktop', 'website'] },
  { prefix: 'relay-stack/web/', components: ['website'] },
  { prefix: 'apps/mobile/store/', components: ['website', 'mobile-native'] },
  { prefix: 'scripts/app-associations.', components: ['website'] },
  { prefix: 'scripts/pages-', components: ['website'] },
  { prefix: 'scripts/build-beeline-bundle.', components: ['helper'] },
  { prefix: 'scripts/merge-beeline-bundles.', components: ['helper'] },
  { prefix: 'scripts/build-usebeeline-package.', components: ['helper'] },
  { prefix: 'scripts/install-beeline.', components: ['helper'] },
  { prefix: 'scripts/verify-beeline-install.', components: ['helper'] },
  { prefix: 'scripts/verify-pages-update.', components: ['helper', 'website'] },
  { prefix: '.github/actions/server-leg/', components: ['server'] },
  { prefix: '.github/actions/daemon-leg/', components: ['helper'] },
  { prefix: '.github/actions/mobile-ota-leg/', components: ['mobile-ota'] },
  { prefix: '.github/actions/pages-leg/', components: ['helper', 'website'] },
  { prefix: '.github/actions/web-app-leg/', components: ['website'] },
  { prefix: 'scripts/verify-web-deployment.', components: ['website'] },
  { prefix: 'scripts/desktop-update.', components: ['desktop'] },
  { exact: '.github/workflows/desktop.yml', components: ['desktop'] },
  { exact: '.github/workflows/server-rollback.yml', components: ['server'] },
  { exact: '.github/workflows/unified-release.yml', components: ['server', 'helper', 'mobile-ota', 'desktop', 'website'] },
  { exact: 'scripts/unified-release.mjs', components: ['server', 'helper', 'mobile-ota', 'desktop', 'website'] },
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
  const previous = new Set(normalized.map((machine) => machine.imageRef));
  if (previous.size !== 1) fail('server fleet is already split across images; refuse an ambiguous rollback');
  const [canary, second] = normalized;
  return {
    previousImageRef: canary.imageRef,
    newImageRef,
    canaryMachineId: canary.id,
    secondMachineId: second.id,
    steps: [
      'migrate',
      `update:${canary.id}:${newImageRef}`,
      `watch:${canary.id}:${SERVER_CANARY_WINDOW_SECONDS}s`,
      `update:${second.id}:${newImageRef}`,
    ],
    rollbackSteps: [`update:${canary.id}:${canary.imageRef}`, 'fail-release'],
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

export function createServerImageLedger({ version, sourceSha, plan, state = 'prepared' }) {
  validateReleaseIdentity(version, sourceSha);
  if (!['prepared', 'deployed', 'rolled-back'].includes(state)) fail(`invalid server ledger state: ${state}`);
  return {
    schemaVersion: 1,
    version,
    sourceSha,
    previousImageRef: plan.previousImageRef,
    imageRef: plan.newImageRef,
    canaryMachineId: plan.canaryMachineId,
    secondMachineId: plan.secondMachineId,
    state,
  };
}

export function selectServerRollbackImage({ explicitImageRef, ledger } = {}) {
  const imageRef = explicitImageRef || ledger?.previousImageRef;
  if (!imageRef?.startsWith('registry.fly.io/')) fail('no valid previous server image ref was supplied or recorded');
  return imageRef;
}

export function validateReleaseIdentity(version, sourceSha) {
  if (!VERSION.test(version ?? '')) fail(`invalid release version: ${version ?? '<missing>'}`);
  if (!SHA.test(sourceSha ?? '')) fail(`invalid release sha: ${sourceSha ?? '<missing>'}`);
  return { version, sourceSha };
}

export function nextReleaseVersion(previous) {
  if (!previous) return 'v0.0.1';
  const match = VERSION.exec(previous);
  if (!match) fail(`cannot increment invalid release version: ${previous}`);
  return `v${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function releaseVersionForSource(previous, sourceSha) {
  validateReleaseIdentity(previous?.version, previous?.sourceSha);
  validateReleaseIdentity(previous.version, sourceSha);
  return previous.sourceSha === sourceSha ? previous.version : nextReleaseVersion(previous.version);
}

function assertComponent(component) {
  if (!RELEASE_COMPONENTS.includes(component)) fail(`unknown release component: ${component}`);
}
function matchesRule(path, rule) { return rule.exact === path || (rule.prefix && path.startsWith(rule.prefix)); }

function runtimePinChangeMessage(runtimePin, requirement) {
  const changes = runtimePin.changedPlatforms?.map((platform) =>
    `${platform} ${runtimePin.previous[platform]} -> ${runtimePin.next[platform]}`).join(', ')
    ?? `${runtimePin.previous} -> ${runtimePin.next}`;
  return `runtime pin changed ${changes}: ${requirement}`;
}

export function selectReleaseComponents(paths, { selection = 'auto', storeTrack = 'none', runtimePin, allowPinRestore = false } = {}) {
  if (!['none', 'internal', 'beta', 'production'].includes(storeTrack)) fail(`invalid store track: ${storeTrack}`);
  const explicit = selection !== 'auto' && selection !== '';
  if (runtimePin?.changed && explicit && selection !== 'all'
      && !selection.split(',').map((value) => value.trim()).includes('mobile-native')) {
    fail(runtimePinChangeMessage(runtimePin, 'mobile-native (store binaries) must ship in this release; add it or revert the pin'));
  }
  // RELEASE POLICY: OTA is the default delivery and never publishes to a
  // store by itself. A runtime-pin change is the one case the planner treats
  // as store-necessary (a new runtime needs a new store binary as its anchor),
  // and that store submission is a deliberate operator choice via --store-track
  // that requires the project owner's explicit consent. It is never inferred.
  if (runtimePin?.changed && storeTrack === 'none' && !allowPinRestore) {
    fail(runtimePinChangeMessage(runtimePin, '--store-track must name the store submission track (internal, beta, or production; store publishing is explicit, consent-gated) or pass --allow-pin-restore to assert this is an OTA-only pin RESTORE whose runtime already has store binaries'));
  }
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
  if (runtimePin?.changed && !(storeTrack === 'none' && allowPinRestore)) selected.add('mobile-native');
  if (storeTrack !== 'none') selected.add('mobile-native');
  return RELEASE_COMPONENTS.filter((component) => selected.has(component));
}

export function selectReleaseComponentsFromPublishedInputs(
  pathsByComponent,
  { selection = 'auto', storeTrack = 'none', runtimePin, allowPinRestore = false } = {},
) {
  if (selection !== 'auto' && selection !== '') {
    return selectReleaseComponents([], { selection, storeTrack, runtimePin, allowPinRestore });
  }
  const selected = new Set(selectReleaseComponents([], { storeTrack, runtimePin, allowPinRestore }));
  for (const component of RELEASE_COMPONENTS) {
    const paths = pathsByComponent?.[component];
    if (!Array.isArray(paths)) fail(`missing changed paths for ${component}`);
    if (selectReleaseComponents(paths).includes(component)) selected.add(component);
  }
  return RELEASE_COMPONENTS.filter((component) => selected.has(component));
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
  return {
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

export function initializeRelease({ version, sourceSha, previous, selectedComponents = RELEASE_COMPONENTS, runtimePin, retry, startedAt = now() }) {
  validateReleaseIdentity(version, sourceSha);
  const selected = new Set(selectedComponents);
  selected.forEach(assertComponent);
  if (retry) {
    validateReleaseIdentity(retry.version, retry.sourceSha);
    if (retry.version !== version || retry.sourceSha !== sourceSha) fail(`retry identity ${retry.version}@${retry.sourceSha} does not match ${version}@${sourceSha}`);
    const resumed = structuredClone(retry);
    resumed.firstStartedAt ??= resumed.startedAt;
    resumed.startedAt = startedAt;
    resumed.state = 'planned';
    resumed.delivery = { state: 'pending' };
    resumed.updatedAt = startedAt;
    return resumed;
  }
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

export function retryPlan(state) {
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
    retry: retryPlan(state), budgetMinutes: RELEASE_BUDGET_MINUTES,
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
  if (command === 'next-version') {
    const previous = args.previous ? readJson(args.previous) : undefined;
    process.stdout.write(`${nextReleaseVersion(previous?.version)}\n`);
    return;
  }
  if (command === 'release-version') {
    const previous = args.previous ? readJson(args.previous) : undefined;
    process.stdout.write(`${previous ? releaseVersionForSource(previous, args.sha) : 'v0.0.1'}\n`);
    return;
  }
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
  if (command === 'plan' || command === 'init') {
    const previous = args.previous ? readJson(args.previous) : undefined;
    const retry = args.retry ? readJson(args.retry) : undefined;
    const paths = args.paths ? readFileSync(args.paths, 'utf8').split(/\r?\n/).map((path) => path.trim()).filter(Boolean) : [];
    const componentPaths = args['component-paths'] ? readJson(args['component-paths']) : undefined;
    const selection = args.selection ?? (command === 'init' && !args.paths ? 'all' : 'auto');
    const runtimePin = previous ? runtimePinChangeFromPublishedInputs(previous, args.sha) : undefined;
    const allowPinRestore = args['allow-pin-restore'] === 'true';
    const selectOptions = { selection, storeTrack: args['store-track'] ?? 'none', runtimePin, allowPinRestore };
    const selectedComponents = componentPaths
      ? selectReleaseComponentsFromPublishedInputs(componentPaths, selectOptions)
      : selectReleaseComponents(paths, selectOptions);
    const state = initializeRelease({ ...identityFromOptions(args), previous, retry, selectedComponents, runtimePin });
    state.plan.paths = paths;
    if (componentPaths) state.plan.componentPaths = componentPaths;
    state.plan.selection = selection;
    if (allowPinRestore && runtimePin?.changed) state.plan.pinRestore = true;
    writeJson(args.state, state);
    if (args.summary) writeJson(args.summary, releasePlanSummary(state));
    else if (command === 'plan') console.log(JSON.stringify(releasePlanSummary(state)));
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
  if (command === 'server-deploy-plan') {
    const plan = planServerCanaryDeployment(readJson(args.machines), args.image);
    if (args.output) writeJson(args.output, plan);
    console.log('[dry-run] ' + plan.steps.join(' -> '));
    if (args['simulate-failure'] === 'true') {
      console.log('[dry-run] canary failed -> ' + plan.rollbackSteps.join(' -> '));
    }
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
  if (command === 'server-ledger') {
    const plan = readJson(args.plan);
    writeJson(args.output, createServerImageLedger({
      ...identityFromOptions(args), plan, state: args['ledger-state'] ?? 'prepared',
    }));
    return;
  }
  if (command === 'server-rollback-image') {
    const imageRef = selectServerRollbackImage({
      explicitImageRef: args.image,
      ledger: args.ledger ? readJson(args.ledger) : undefined,
    });
    process.stdout.write(`${imageRef}\n`);
    return;
  }
  const state = readJson(args.state);
  if (command === 'mark-stage') {
    markComponentStage(state, args.component, args.stage, identityFromOptions(args), args.artifact);
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
  if (command === 'report') {
    validateReleaseIdentity(args.version, args.sha);
    if (args.version !== state.version || args.sha !== state.sourceSha) fail('mixed-version delivery report refused');
    if (state.state !== 'delivered') fail(`NOT DELIVERED: ${state.version}@${state.sourceSha}`);
    console.log(`DELIVERED ${state.version} (${state.sourceSha}) in ${state.delivery.durationSeconds}s` +
      (state.delivery.unproven ? ` · UNPROVEN: ${state.delivery.unproven}` : ''));
    return;
  }
  fail('Usage: unified-release.mjs <next-version|release-version|component-paths|plan|init|server-deploy-plan|server-canary-sample|server-ledger|server-rollback-image|mark-stage|apply-checkpoints|finalize|notify|report>');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
