#!/usr/bin/env node
// Phone OTA delivery by channel pointer (Expo's branch promotion pattern).
//
// Every release publishes one EAS branch, `release-<version>`, holding one
// update per live store runtime. The `beta` channel points at that branch
// first; promotion points the `production` channel at the SAME branch, so
// production serves the exact bundles beta tested. Rollback points production
// back at the previous release's branch.
//
// Nothing here reads or writes a file that carries state between jobs or
// runs. Every decision asks EAS itself: which updates the branch already has
// (a rerun publishes only what is missing) and which branch a channel points
// at (a rerun that already promoted does nothing).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { readPinnedRuntimeVersion } from './native-fingerprint.mjs';
import { queueSentrySourcemaps } from './upload-sentry-sourcemaps.mjs';
import { storeRuntimeTargets, runtimeKey } from './store-runtime-targets.mjs';

export const RELEASE_PLATFORMS = ['android', 'ios'];
const EAS_CLI_VERSION = '22.2.0';
// `eas update:list` pages at most 50 update groups. One release branch holds
// one group per target, so a page always covers it.
const BRANCH_LOOKUP_LIMIT = '50';
const RELEASE_BRANCH = /^release-(?:proof-)?[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/;

export class OtaReleaseError extends Error {}
function fail(message) {
  throw new OtaReleaseError(message);
}

export function targetKey(target) {
  return `${target.platform}@${target.runtimeVersion}`;
}

export function releaseBranchName(version) {
  if (!/^v\d+\.\d+\.\d+$/.test(version ?? '')) fail(`invalid release version: ${version}`);
  return `release-${version}`;
}

export function updateMessage(sha, target) {
  return `release ${sha.slice(0, 12)} ${targetKey(target)}`;
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function commandParts(args) {
  if (process.env.EAS_CLI_PATH) return [process.env.EAS_CLI_PATH, ...args];
  return ['npx', '--yes', `eas-cli@${EAS_CLI_VERSION}`, ...args];
}

// Runs one eas-cli command and returns its parsed JSON. `missing` names a
// stderr pattern that means "this does not exist yet"; that case returns
// null, and every other failure stops the release.
export function runEas(args, { dryRun = false, env = {}, missing } = {}) {
  const parts = commandParts(args);
  if (dryRun) {
    const prefix = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
    console.log([...prefix, ...parts.map(shellQuote)].join(' '));
    return null;
  }
  const result = spawnSync(parts[0], parts.slice(1), {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = (result.stdout ?? '').trim();
  const errors = result.stderr ?? '';
  if (result.status !== 0) {
    if (missing && missing.test(`${errors}\n${output}`)) return null;
    if (errors) console.error(errors.trim());
    if (output) console.error(output);
    fail(`EAS command failed (${result.status ?? 'signal'}): ${parts.map(shellQuote).join(' ')}`);
  }
  if (errors.trim()) console.error(errors.trim());
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(`EAS command did not return JSON: ${error.message}`);
  }
}

function groupIdOf(value) {
  if (typeof value.group === 'string') return value.group;
  if (typeof value.group?.id === 'string') return value.group.id;
  if (typeof value.groupId === 'string') return value.groupId;
  return null;
}

function runtimeVersionOf(value) {
  if (typeof value.runtimeVersion === 'string') return value.runtimeVersion;
  if (typeof value.runtime?.version === 'string') return value.runtime.version;
  return null;
}

// `update:list --json` returns update-group descriptions (comma-separated
// `platforms`, no update ids); `update --json` returns individual updates.
// Both resolve to (platform, runtime, group, message) rows, newest first.
export function collectUpdates(payload) {
  const updates = [];
  const seen = new Set();
  const walk = (value, inheritedGroup = null, inheritedMessage = null) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, inheritedGroup, inheritedMessage);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const group = groupIdOf(value) ?? inheritedGroup;
    const message = typeof value.message === 'string' ? value.message : inheritedMessage;
    const runtimeVersion = runtimeVersionOf(value);
    const platforms = typeof value.platform === 'string'
      ? [value.platform]
      : typeof value.platforms === 'string' ? value.platforms.split(',').map((item) => item.trim()) : [];
    if (group && runtimeVersion) {
      for (const platform of platforms) {
        if (!RELEASE_PLATFORMS.includes(platform)) continue;
        const id = typeof value.id === 'string' ? value.id : `${group}:${platform}:${runtimeVersion}`;
        if (seen.has(id)) continue;
        seen.add(id);
        updates.push({
          id, platform, runtimeVersion, group, message,
          rollBackToEmbedded: value.isRollBackToEmbedded === true,
        });
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'group' && typeof child === 'string') continue;
      walk(child, group, message);
    }
  };
  walk(payload);
  return updates;
}

// eas-cli prints a list message as `"<message>" (5 minutes ago by <actor>)`.
export function messageText(message) {
  const display = /^"([^"\r\n]*)" \([^\r\n]*\)$/.exec(message ?? '');
  return display ? display[1] : message ?? '';
}

// The newest update per runtime on a branch, with the source it came from.
export function branchState(payload) {
  const newest = new Map();
  for (const update of collectUpdates(payload)) {
    const key = targetKey(update);
    if (!newest.has(key)) newest.set(key, { ...update, message: messageText(update.message) });
  }
  return [...newest.values()];
}

// Which targets this release still owes the branch. A branch holding updates
// from any other source is refused: one version is one source commit.
export function planBranchPublish({ targets, branchUpdates, sha }) {
  if (!SHA.test(sha ?? '')) fail(`invalid release sha: ${sha}`);
  const marker = ` ${sha.slice(0, 12)} `;
  const foreign = branchUpdates.filter((update) => !`${update.message} `.includes(marker));
  if (foreign.length > 0) {
    fail(
      `branch already holds updates from another source (${foreign.map((update) => `${targetKey(update)}: ${update.message}`).join('; ')}); ` +
        'refusing to mix two source commits in one release branch',
    );
  }
  const present = new Set(branchUpdates.map(targetKey));
  return {
    present: targets.filter((target) => present.has(targetKey(target))),
    missing: targets.filter((target) => !present.has(targetKey(target))),
  };
}

export function assertBranchCovers({ branch, targets, branchUpdates, sha }) {
  const { missing } = planBranchPublish({ targets, branchUpdates, sha });
  if (missing.length > 0) {
    fail(`${branch} is missing ${missing.map(targetKey).join(', ')}; phones on those runtimes would get no update`);
  }
  return targets.map((target) => branchUpdates.find((update) => targetKey(update) === targetKey(target)));
}

// `channel:view --json` prints the channel with its branch mapping. Only a
// plain one-branch mapping is a pointer this pipeline may read or move.
export function channelBranchName(payload) {
  const channel = payload?.currentPage ?? payload;
  if (!channel || typeof channel !== 'object') fail('channel view returned no channel');
  let mapping;
  try {
    mapping = typeof channel.branchMapping === 'string' ? JSON.parse(channel.branchMapping) : channel.branchMapping;
  } catch {
    fail(`channel ${channel.name} has an unreadable branch mapping`);
  }
  const entries = mapping?.data ?? [];
  if (entries.length !== 1 || entries[0].branchMappingLogic !== 'true') {
    fail(`channel ${channel.name} is not a plain one-branch pointer (rollout in progress?)`);
  }
  const branch = (channel.updateBranches ?? []).find((candidate) => candidate.id === entries[0].branchId);
  if (!branch?.name) fail(`channel ${channel.name} points at a branch the view did not name`);
  return branch.name;
}

// Runtimes the current branch serves that the rollback branch does not.
// Phones on those runtimes would keep the bad update, so each one gets a
// roll-back-to-embedded directive on the rollback branch first.
export function rollbackGaps({ currentUpdates, targetUpdates }) {
  const covered = new Set(targetUpdates.map(targetKey));
  return currentUpdates
    .filter((update) => !covered.has(targetKey(update)))
    .map(({ platform, runtimeVersion }) => ({ platform, runtimeVersion }));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, dryRun: false };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (!token.startsWith('--')) fail(`Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`Missing value for ${token}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  if (path) writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function listBranch(branch, { dryRun } = {}) {
  if (!RELEASE_BRANCH.test(branch) && branch !== 'production') fail(`refusing to read unexpected branch ${branch}`);
  const payload = runEas(
    ['update:list', '--branch', branch, '--limit', BRANCH_LOOKUP_LIMIT, '--json', '--non-interactive'],
    { dryRun, missing: /Could not find (?:a )?branch/i },
  );
  return payload ? branchState(payload) : [];
}

export function readChannelBranch(channel, { dryRun } = {}) {
  const payload = runEas(['channel:view', channel, '--json', '--non-interactive'], {
    dryRun, missing: /Could not find (?:a )?channel/i,
  });
  if (dryRun) return null;
  return payload ? channelBranchName(payload) : null;
}

function pointChannel(channel, branch, { dryRun } = {}) {
  const current = readChannelBranch(channel, { dryRun });
  if (!dryRun && current === branch) {
    console.log(`${channel} already points at ${branch}`);
    return { channel, branch, previousBranch: current, changed: false };
  }
  if (!dryRun && current === null) {
    // channel:create also creates (or reuses) a branch of the channel's name;
    // the edit below moves the new pointer to the release branch at once.
    runEas(['channel:create', channel, '--json', '--non-interactive']);
  }
  runEas(['channel:edit', channel, '--branch', branch, '--json', '--non-interactive'], { dryRun });
  if (dryRun) return { channel, branch, previousBranch: null, changed: true };
  const observed = readChannelBranch(channel);
  if (observed !== branch) fail(`${channel} reads back ${observed} after pointing it at ${branch}`);
  console.log(`${channel}: ${current ?? '(new channel)'} -> ${branch}`);
  return { channel, branch, previousBranch: current, changed: true };
}

// Live store runtimes are read from Google Play and App Store Connect. The
// previous release record supplies identities of store builds this pipeline
// uploaded and the runtimes it last served (used only if a store is
// unreadable). No guess replaces a store answer.
export function computeTargets({ memory = {}, stores, pins }) {
  const observedLive = RELEASE_PLATFORMS.flatMap((platform) =>
    stores?.[platform]?.status === 'readable'
      ? [...stores[platform].live, ...(stores[platform].historical ?? [])]
      : []);
  const previouslyLive = [...new Map(
    [...(memory.previouslyLive ?? []), ...observedLive].map((target) => [runtimeKey(target), target]),
  ).values()];
  const targets = storeRuntimeTargets({
    pins,
    stores,
    previouslyLive,
    previousTargets: memory.previousTargets ?? [],
  });
  if (targets.length === 0) fail('no live store runtime is known; refusing to publish an OTA nobody can receive');
  for (const platform of RELEASE_PLATFORMS) {
    if (!targets.some((target) => target.platform === platform)) fail(`no live ${platform} runtime is known; refusing a one-platform release`);
  }
  return { targets, previouslyLive };
}

function readStoreState(memory) {
  const input = join(mkdtempSync(join(tmpdir(), 'beeline-store-status-')), 'memory.json');
  writeJson(input, memory);
  const observed = spawnSync(process.execPath, [
    fileURLToPath(new URL('../../../scripts/read-store-runtimes.mjs', import.meta.url)), input,
  ], { encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  if (observed.status !== 0) {
    console.log(`store runtime lookup failed; using the previous release's targets: ${observed.stderr?.trim()}`);
    return { stores: {}, builds: memory.builds ?? [] };
  }
  try {
    return JSON.parse(observed.stdout);
  } catch {
    return { stores: {}, builds: memory.builds ?? [] };
  }
}

// The runtimes the newest release on a branch served: every update carrying
// the same 12-hex source marker as the branch's newest update.
export function latestSourceTargets(branchUpdates) {
  const source = branchUpdates[0]?.message?.match(/\b([0-9a-f]{12})\b/)?.[1];
  return branchUpdates
    .filter((update) => !source || update.message?.includes(source))
    .map(({ platform, runtimeVersion }) => ({ platform, runtimeVersion }));
}

function targetsCommand(options) {
  const memory = options.memory ? readJson(options.memory) : {};
  const status = options.storeStatus ? readJson(options.storeStatus) : readStoreState(memory);
  const unreadable = RELEASE_PLATFORMS.filter((platform) => status.stores?.[platform]?.status !== 'readable');
  for (const platform of unreadable) {
    console.log(`${platform} store status unavailable (${status.stores?.[platform]?.reason ?? 'not read'}); keeping the previous release's ${platform} targets`);
  }
  if (unreadable.length > 0 && !(memory.previousTargets?.length > 0) && !options.storeStatus) {
    // First release on this scheme: what production serves now is the
    // previous release's target set.
    const current = readChannelBranch('production');
    memory.previousTargets = current ? latestSourceTargets(listBranch(current)) : [];
  }
  memory.previouslyLive = [...(memory.previouslyLive ?? []), ...(status.previouslyLive ?? [])];
  const { targets, previouslyLive } = computeTargets({
    memory, stores: status.stores, pins: readPinnedRuntimeVersion(process.cwd()),
  });
  console.log(`ota_targets=${targets.map(targetKey).join(',')}`);
  const result = { targets, storeRuntime: { builds: status.builds ?? memory.builds ?? [], previouslyLive } };
  writeJson(options.output, result);
  return result;
}

function publish(options) {
  if (!SHA.test(options.sha ?? '')) fail('publish requires --sha <40-hex release sha>');
  const branch = options.branch ?? releaseBranchName(options.releaseVersion);
  const channel = options.channel ?? 'beta';
  const plan = options.targets ? readJson(options.targets) : targetsCommand({ memory: options.memory });
  const targets = plan.targets;
  const before = listBranch(branch, options);
  const { present, missing } = planBranchPublish({ targets, branchUpdates: before, sha: options.sha });
  if (present.length > 0) console.log(`${branch} already has ${present.map(targetKey).join(', ')} from this source; not republishing them`);
  // One JS export per platform. EXPO_RUNTIME_OVERRIDE only changes the
  // runtimeVersion eas-cli writes into each manifest, so later targets of a
  // platform upload the same export with --skip-bundler.
  const exportRoot = mkdtempSync(join(tmpdir(), 'beeline-ota-export-'));
  const exported = new Set();
  for (const target of missing) {
    const reuse = exported.has(target.platform);
    exported.add(target.platform);
    console.log(`${targetKey(target)}: ${reuse ? 'uploading the existing' : 'bundling the'} ${target.platform} export to ${branch}`);
    const result = runEas([
      'update', '--branch', branch, '--environment', 'production', '--platform', target.platform,
      '--message', updateMessage(options.sha, target), '--input-dir', join(exportRoot, target.platform),
      '--source-maps', ...(reuse ? ['--skip-bundler'] : []), '--json', '--non-interactive',
    ], {
      dryRun: options.dryRun,
      env: {
        EXPO_RUNTIME_OVERRIDE: target.runtimeVersion,
        EXPO_PUBLIC_BEELINE_RELEASE_SHA: options.sha,
        ...(options.releaseVersion ? { EXPO_PUBLIC_BEELINE_RELEASE_VERSION: options.releaseVersion } : {}),
      },
    });
    if (options.dryRun) continue;
    const published = collectUpdates(result);
    if (published.length !== 1 || targetKey(published[0]) !== targetKey(target)) {
      fail(`publish of ${targetKey(target)} returned ${published.map(targetKey).join(', ') || 'no update'}`);
    }
    if (!reuse) queueSentrySourcemaps(join(exportRoot, target.platform), options.sha);
  }
  if (options.dryRun) return null;
  const after = listBranch(branch);
  const updates = assertBranchCovers({ branch, targets, branchUpdates: after, sha: options.sha });
  console.log(`branch_targets=${updates.map((update) => `${targetKey(update)}:${update.group}`).join(',')}`);
  // Every live runtime is on the branch before any channel moves.
  const pointer = pointChannel(channel, branch);
  const facts = {
    branch, channel, sourceSha: options.sha, targets,
    groups: Object.fromEntries(updates.map((update) => [targetKey(update), update.group])),
    published: missing.map(targetKey), alreadyPresent: present.map(targetKey),
    storeRuntime: plan.storeRuntime, previousChannelBranch: pointer.previousBranch,
  };
  writeJson(options.output, facts);
  return facts;
}

function promote(options) {
  if (!SHA.test(options.sha ?? '')) fail('promote requires --sha <40-hex release sha>');
  const branch = options.branch ?? releaseBranchName(options.releaseVersion);
  const channel = options.channel ?? 'production';
  const targets = options.targets ? readJson(options.targets).targets : null;
  if (!Array.isArray(targets) || targets.length === 0) fail('promote requires --targets naming every runtime the branch must serve');
  const updates = assertBranchCovers({ branch, targets, branchUpdates: listBranch(branch), sha: options.sha });
  const pointer = pointChannel(channel, branch, options);
  const facts = {
    branch, channel, sourceSha: options.sha, targets,
    groups: Object.fromEntries(updates.map((update) => [targetKey(update), update.group])),
    changed: pointer.changed, observedPreviousBranch: pointer.previousBranch, promotedAt: new Date().toISOString(),
  };
  console.log(`promoted ${channel} -> ${branch} (${targets.map(targetKey).join(', ')})`);
  writeJson(options.output, facts);
  return facts;
}

function rollback(options) {
  const channel = options.channel ?? 'production';
  const target = options.toBranch;
  if (!target) fail('rollback requires --to-branch');
  const current = readChannelBranch(channel);
  if (!current) fail(`channel ${channel} does not exist`);
  if (options.expectedCurrent && current !== options.expectedCurrent) {
    fail(`${channel} points at ${current}, not ${options.expectedCurrent}; refusing to roll back a release that is no longer current`);
  }
  if (current === target) {
    console.log(`${channel} already points at ${target}; nothing to roll back`);
    writeJson(options.output, { channel, branch: target, changed: false });
    return;
  }
  const currentUpdates = listBranch(current);
  const targetUpdates = listBranch(target);
  if (targetUpdates.length === 0) fail(`${target} has no updates; refusing to point ${channel} at an empty branch`);
  const gaps = rollbackGaps({ currentUpdates, targetUpdates });
  for (const gap of gaps) {
    console.log(`${targetKey(gap)} is not on ${target}; phones on it roll back to their embedded update`);
    runEas([
      'update:roll-back-to-embedded', '--branch', target, '--runtime-version', gap.runtimeVersion,
      '--platform', gap.platform, '--message', `rollback ${targetKey(gap)} to embedded update`,
      '--json', '--non-interactive',
    ], { dryRun: options.dryRun, env: { EXPO_RUNTIME_OVERRIDE: gap.runtimeVersion } });
  }
  const pointer = pointChannel(channel, target, options);
  writeJson(options.output, {
    channel, branch: target, previousBranch: current, embeddedRollbacks: gaps.map(targetKey),
    changed: pointer.changed, dryRun: options.dryRun, at: new Date().toISOString(),
  });
}

function verifyBranch(options) {
  const branch = options.branch;
  const targets = options.targets ? readJson(options.targets).targets : null;
  if (!branch || !Array.isArray(targets)) fail('verify-branch requires --branch and --targets');
  const updates = assertBranchCovers({ branch, targets, branchUpdates: listBranch(branch), sha: options.sha });
  for (const update of updates) console.log(`${targetKey(update)} group=${update.group} message="${update.message}"`);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (process.env.EXPO_RUNTIME_OVERRIDE) {
    fail('EXPO_RUNTIME_OVERRIDE is reserved for ota-release.mjs child processes.');
  }
  switch (options.command) {
    case 'targets':
      return targetsCommand(options);
    case 'publish':
      return publish(options);
    case 'promote':
      return promote(options);
    case 'rollback':
      return rollback(options);
    case 'verify-branch':
      return verifyBranch(options);
    case 'channel-branch':
      console.log(readChannelBranch(options.channel ?? 'production') ?? '');
      return undefined;
    default:
      fail('Usage: ota-release.mjs <targets|publish|promote|rollback|verify-branch|channel-branch> [options]');
  }
  return undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
