#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readPinnedRuntimeVersion } from './native-fingerprint.mjs';
import {
  RELEASE_PLATFORMS,
  classifyFailure,
  confirmDelivery,
  groupIdList,
  groupMapFrom,
  initDelivery,
  isoNow,
  joinGroupIds,
  latestPublishedDelivery,
  listUndelivered,
  markBuilt,
  markPublished,
  mergeReconciliation,
  readJson,
  recordFailure,
  sameGroupSet,
  writeJson,
} from './ota-delivery-index.mjs';

const EAS_CLI_VERSION = '22.2.0';
// During a compatibility rollout the production branch carries more than one
// runtime. Read enough history to resolve every current release target.
const PRODUCTION_LOOKUP_LIMIT = '10';
// Keep this committed rollout switch on until runtime-24 adoption is high
// enough that operators intentionally stop serving the App Store build-8
// runtime. Turning it off removes only the iOS@23 compatibility target.
export const PUBLISH_IOS_RUNTIME_23_DURING_PUSH_ROLLOUT = true;

// Publish android@23 alongside android@24 until the captain's runtime-23
// device adopts a newer store binary. Mirror of the iOS@23 compat target.
export const PUBLISH_ANDROID_RUNTIME_23_DURING_PUSH_ROLLOUT = true;

function targetKey(target) {
  return `${target.platform}@${target.runtimeVersion}`;
}

// Current runtimes come from the same resolved Expo config that EAS reads.
// The compatibility runtimes are the exceptional, explicitly temporary
// targets. Keep this list ordered so the release log is deterministic.
export function releaseUpdateTargets(projectDir = process.cwd()) {
  if (process.env.EXPO_RUNTIME_OVERRIDE) {
    throw new Error('EXPO_RUNTIME_OVERRIDE is reserved for ota-release.mjs child processes.');
  }
  const pins = readPinnedRuntimeVersion(projectDir);
  const targets = [
    { platform: 'android', runtimeVersion: pins.android },
    ...(PUBLISH_ANDROID_RUNTIME_23_DURING_PUSH_ROLLOUT
      ? [{ platform: 'android', runtimeVersion: '23' }]
      : []),
    ...(PUBLISH_IOS_RUNTIME_23_DURING_PUSH_ROLLOUT
      ? [{ platform: 'ios', runtimeVersion: '23' }]
      : []),
    { platform: 'ios', runtimeVersion: pins.ios },
  ];
  return targets.filter(
    (target, index) =>
      targets.findIndex((candidate) => targetKey(candidate) === targetKey(target)) === index,
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, dryRun: false, embedded: false };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (token === '--embedded') {
      options.embedded = true;
      continue;
    }
    if (!token.startsWith('--')) fail(`Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--') || (!value && token !== '--before')) {
      fail(`Missing value for ${token}`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function commandParts(args) {
  if (process.env.EAS_CLI_PATH) return [process.env.EAS_CLI_PATH, ...args];
  return ['npx', '--yes', `eas-cli@${EAS_CLI_VERSION}`, ...args];
}

function runEas(args, { allowFailure = false, dryRun = false, env = {} } = {}) {
  const parts = commandParts(args);
  if (dryRun) {
    const prefix = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
    console.log([...prefix, ...parts.map(shellQuote)].join(' '));
    return null;
  }
  const result = spawnSync(parts[0], parts.slice(1), {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const output = result.stdout.trim();
  if (result.status !== 0) {
    if (allowFailure) return null;
    if (output) console.error(output);
    fail(
      `EAS command failed (${result.status ?? 'signal'}; captured EAS stdout printed above): ${parts.map(shellQuote).join(' ')}`,
    );
  }
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

// Every EAS update belongs to exactly one update group, named either on the
// update itself or on the group object enclosing it. Anything update-shaped
// (an id plus a platform) that resolves to no group is an unusable publish
// proof, so collect those separately instead of silently dropping them.
function collectUpdates(payload) {
  const updates = [];
  const groupless = [];
  const seen = new Set();
  const walk = (value, inherited) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, inherited);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const group = groupIdOf(value) ?? inherited;
    const id = typeof value.id === 'string' ? value.id : null;
    const platform = typeof value.platform === 'string' ? value.platform : null;
    const runtimeVersion = runtimeVersionOf(value);
    if (id && platform && !seen.has(id)) {
      seen.add(id);
      if (group) {
        updates.push({
          id,
          platform,
          group,
          runtimeVersion,
        });
      } else {
        groupless.push({ id, platform });
      }
    }
    // eas-cli@22.2.0 renders `update:list --json` as update-group
    // descriptions. Those rows deliberately omit individual update IDs and
    // use a comma-separated `platforms` field, but still prove the exact
    // (platform, runtime, group) tuple needed by the rollout governor.
    if (group && runtimeVersion && typeof value.platforms === 'string') {
      for (const listedPlatform of value.platforms.split(',').map((item) => item.trim())) {
        if (!RELEASE_PLATFORMS.includes(listedPlatform)) continue;
        const syntheticId = `${group}:${listedPlatform}:${runtimeVersion}`;
        if (seen.has(syntheticId)) continue;
        seen.add(syntheticId);
        updates.push({
          id: syntheticId,
          platform: listedPlatform,
          group,
          runtimeVersion,
        });
      }
    }
    for (const child of Object.values(value)) walk(child, group);
  };
  walk(payload, null);
  return { updates, groupless };
}

function groupByPlatform(updates, label) {
  const map = {};
  for (const update of updates) {
    const existing = map[update.platform];
    if (existing && existing !== update.group) {
      fail(
        `${label} returned two update groups for ${update.platform}: ${existing} and ${update.group}.`,
      );
    }
    map[update.platform] = update.group;
  }
  return map;
}

function describePlatforms(platforms) {
  return platforms.length > 0 ? [...platforms].sort().join(', ') : 'no platform';
}

// One publish/republish call returns at most one update group per platform it
// covered: platforms on the same runtime version (the hand-pinned runtime in
// `app.config.js`) share a single group, platforms on different runtime
// versions get one each. Both shapes satisfy this check.
function requirePublishedGroups(payload, label, expectedPlatforms) {
  const { updates, groupless } = collectUpdates(payload);
  if (groupless.length > 0) {
    const orphans = groupless.map((update) => `${update.platform}/${update.id}`).join(', ');
    fail(`${label} returned updates that belong to no update group: ${orphans}.`);
  }
  const map = groupByPlatform(updates, label);
  const platforms = Object.keys(map);
  const expected = expectedPlatforms ? [...new Set(expectedPlatforms)] : null;
  const groups = [...new Set(updates.map((update) => update.group))];
  const ceiling = expected ? expected.length : RELEASE_PLATFORMS.length;
  if (groups.length < 1 || groups.length > ceiling) {
    fail(
      `${label} must return between one and ${ceiling} update groups (one per platform in ${describePlatforms(expected ?? RELEASE_PLATFORMS)}); received ${groups.length} for ${describePlatforms(platforms)}.`,
    );
  }
  if (expected && describePlatforms(platforms) !== describePlatforms(expected)) {
    fail(
      `${label} must cover exactly ${describePlatforms(expected)}; received ${describePlatforms(platforms)}.`,
    );
  }
  return { groupIds: groups, groupByPlatform: map, updates };
}

// `eas update:list` returns the branch newest-first, so the first group seen
// for a platform is that platform's current group.
function newestGroupByPlatform(payload) {
  const map = {};
  for (const update of collectUpdates(payload).updates) {
    map[update.platform] ??= update.group;
  }
  return map;
}

function newestTargets(payload, expectedTargets) {
  const expected = new Set(expectedTargets.map(targetKey));
  const newest = new Map();
  for (const update of collectUpdates(payload).updates) {
    const key = targetKey(update);
    if (!expected.has(key) || newest.has(key)) continue;
    newest.set(key, {
      platform: update.platform,
      runtimeVersion: update.runtimeVersion,
      group: update.group,
      updateId: update.id,
    });
  }
  return expectedTargets.flatMap((target) => {
    const found = newest.get(targetKey(target));
    return found ? [found] : [];
  });
}

function requireTargetUpdate(payload, label, target) {
  const published = requirePublishedGroups(payload, label, [target.platform]);
  const matches = published.updates.filter(
    (update) =>
      update.platform === target.platform && update.runtimeVersion === target.runtimeVersion,
  );
  if (matches.length !== 1 || published.updates.length !== 1) {
    fail(
      `${label} must return exactly ${targetKey(target)}; received ${
        published.updates.map((update) => targetKey(update)).join(', ') || 'no target'
      }.`,
    );
  }
  return {
    ...target,
    group: matches[0].group,
    updateId: matches[0].id,
    update: matches[0],
  };
}

function platformGroupSummary(targets, configuredPins) {
  return Object.fromEntries(
    RELEASE_PLATFORMS.flatMap((platform) => {
      const exact = targets.find(
        (target) =>
          target.platform === platform && target.runtimeVersion === configuredPins[platform],
      );
      const fallback = targets.find((target) => target.platform === platform);
      const selected = exact ?? fallback;
      return selected?.group ? [[platform, selected.group]] : [];
    }),
  );
}

// Republish each distinct source group once, carrying only the platforms that
// group owns, then prove the combined result covers every expected platform.
// `platforms: null` means the caller knows the group but not its platforms (a
// rollback anchor), so only the combined coverage is checked.
function republishGroups(entries, { label, describe, dryRun, expectedPlatforms }) {
  if (entries.length === 0) fail(`${label} has no source update group to republish.`);

  const updates = [];
  const map = {};
  for (const [group, platforms] of entries) {
    const result = runEas(
      [
        'update:republish',
        '--group',
        group,
        '--destination-branch',
        'production',
        '--platform',
        'all',
        '--message',
        describe(group),
        '--json',
        '--non-interactive',
      ],
      { dryRun },
    );
    if (dryRun) continue;
    const republished = requirePublishedGroups(result, `${label} of ${group}`, platforms);
    updates.push(...republished.updates);
    Object.assign(map, republished.groupByPlatform);
  }
  if (dryRun) return null;
  const covered = Object.keys(map);
  if (describePlatforms(covered) !== describePlatforms(expectedPlatforms)) {
    fail(
      `${label} must restore ${describePlatforms(expectedPlatforms)}; production received ${describePlatforms(covered)}.`,
    );
  }
  return {
    groupByPlatform: map,
    groupIds: [...new Set(updates.map((update) => update.group))],
    updates,
  };
}

// A ledger that names one candidate group covering every published platform
// (the shape a shared runtime version produces) reads as that group for each.
function candidateGroupMap(ledger) {
  const published = Array.isArray(ledger.candidateUpdates)
    ? [...new Set(ledger.candidateUpdates.map((update) => update.platform).filter(Boolean))]
    : [];
  const map = groupMapFrom(
    ledger.candidateGroupIds ?? ledger.candidateGroupId,
    published.length > 0 ? published : RELEASE_PLATFORMS,
  );
  if (Object.keys(map).length === 0) {
    fail('Ledger names no beta candidate update group to promote.');
  }
  return map;
}

function republishEntries(groupMap) {
  const byGroup = new Map();
  for (const [platform, group] of Object.entries(groupMap)) {
    byGroup.set(group, [...(byGroup.get(group) ?? []), platform]);
  }
  return [...byGroup];
}

function writeLedger(path, ledger) {
  if (!path) fail('--ledger is required');
  writeJson(path, ledger);
}

function readLedger(path) {
  if (!path) fail('--ledger is required');
  return readJson(path);
}

function publish(options) {
  if (!options.sha || !options.ref) fail('publish requires --sha and --ref');
  const configuredPins = readPinnedRuntimeVersion(process.cwd());
  const targets = releaseUpdateTargets(process.cwd());

  const channel = runEas(['channel:view', 'beta', '--json', '--non-interactive'], {
    allowFailure: true,
    dryRun: options.dryRun,
  });
  if (!channel) {
    runEas(['channel:create', 'beta', '--json', '--non-interactive'], {
      dryRun: options.dryRun,
    });
  }
  runEas(['channel:edit', 'beta', '--branch', 'beta', '--json', '--non-interactive'], {
    dryRun: options.dryRun,
  });

  const previous = runEas(
    [
      'update:list',
      '--branch',
      'production',
      '--limit',
      PRODUCTION_LOOKUP_LIMIT,
      '--json',
      '--non-interactive',
    ],
    { dryRun: options.dryRun },
  );
  const previousProductionTargets = options.dryRun ? [] : newestTargets(previous, targets);
  const requiredRollbackTargets = targets.filter(
    (target) =>
      target.platform === 'android' ||
      !PUBLISH_IOS_RUNTIME_23_DURING_PUSH_ROLLOUT ||
      target.runtimeVersion === '23',
  );
  const previousTargetKeys = new Set(previousProductionTargets.map(targetKey));
  // A runtime's FIRST production release has no earlier update to roll back to,
  // but the store binary built for it in this same release carries an embedded
  // bundle, and `rollback` already falls back to update:roll-back-to-embedded
  // for such targets. The release leg names those platforms in
  // OTA_EMBEDDED_ANCHOR_PLATFORMS (only when its native build succeeded), so the
  // embedded update counts as the anchor for the current pin of that platform.
  const embeddedAnchorPlatforms = new Set(
    (process.env.OTA_EMBEDDED_ANCHOR_PLATFORMS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const pins = readPinnedRuntimeVersion(process.cwd());
  const embeddedAnchorTargets = requiredRollbackTargets.filter(
    (target) =>
      !previousTargetKeys.has(targetKey(target)) &&
      embeddedAnchorPlatforms.has(target.platform) &&
      target.runtimeVersion === pins[target.platform],
  );
  for (const target of embeddedAnchorTargets)
    console.log(`${targetKey(target)}: first production release on this runtime; rollback anchor = embedded update of this release's store binary`);
  const embeddedAnchorKeys = new Set(embeddedAnchorTargets.map(targetKey));
  const missingRollbackTargets = requiredRollbackTargets.filter(
    (target) => !previousTargetKeys.has(targetKey(target)) && !embeddedAnchorKeys.has(targetKey(target)),
  );
  if (!options.dryRun && missingRollbackTargets.length > 0) {
    fail(
      'Production has no rollback anchor for ' +
        missingRollbackTargets.map(targetKey).join(', ') +
        '; refusing to publish rollout candidates.',
    );
  }
  const publishedTargets = targets.map((target) => {
    const message = `ota candidate: ${options.sha.slice(0, 12)} ${options.ref} ${targetKey(target)}`;
    const candidate = runEas(
      [
        'update',
        '--branch',
        'beta',
        '--environment',
        'production',
        '--platform',
        target.platform,
        '--message',
        message,
        '--json',
        '--non-interactive',
      ],
      {
        dryRun: options.dryRun,
        env: { EXPO_RUNTIME_OVERRIDE: target.runtimeVersion },
      },
    );
    return options.dryRun
      ? null
      : requireTargetUpdate(candidate, `Beta publish ${targetKey(target)}`, target);
  });

  if (options.dryRun) return;
  const candidateTargets = publishedTargets.filter(Boolean);
  const candidateUpdates = candidateTargets.map((target) => target.update);
  const candidateGroups = [...new Set(candidateTargets.map((target) => target.group))];
  const candidateGroupIds = platformGroupSummary(candidateTargets, configuredPins);
  const android = candidateUpdates.find((update) => update.platform === 'android');
  if (!android) fail('Beta publish did not return an Android update.');
  const previousProduction = platformGroupSummary(previousProductionTargets, configuredPins);
  const existing = existsSync(options.ledger) ? readLedger(options.ledger) : {};
  const ledger = {
    ...existing,
    schemaVersion: 4,
    status: 'beta',
    sourceSha: options.sha,
    ...(options.releaseVersion ? { releaseVersion: options.releaseVersion } : {}),
    sourceRef: options.ref,
    updateTargets: targets,
    candidateTargets: candidateTargets.map(({ update: _update, ...target }) => target),
    candidateGroupIds,
    candidateGroupId: joinGroupIds(candidateGroups),
    candidateUpdates,
    androidUpdateId: android.id,
    runtimeVersions: [
      ...new Set(candidateUpdates.map((update) => update.runtimeVersion).filter(Boolean)),
    ],
    previousProductionTargets,
    previousProductionGroupIds: previousProduction,
    previousProductionGroupId:
      joinGroupIds(previousProductionTargets.map((target) => target.group)) || null,
    createdAt: existing.createdAt ?? isoNow(),
    delivery: { ...existing.delivery, state: 'built', builtAt: isoNow() },
    canary: { status: 'pending' },
    production: null,
  };
  writeLedger(options.ledger, ledger);
  if (options.index) {
    markBuilt(options.index, options.sha);
  }
}

function markCanary(options) {
  if (!['passed', 'post-promote', 'blocked'].includes(options.status)) {
    fail('mark-canary --status must be passed, post-promote, or blocked');
  }
  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
  if (options.status === 'blocked' && !reason) {
    fail('mark-canary --status blocked requires --reason naming why promotion is parked');
  }
  const ledger = readLedger(options.ledger);
  if (ledger.status !== 'beta') fail(`Cannot mark canary from ledger status ${ledger.status}.`);
  ledger.canary = {
    status: options.status,
    recordedAt: isoNow(),
    ...(reason ? { reason } : {}),
  };
  writeLedger(options.ledger, ledger);
}

function promote(options) {
  const ledger = readLedger(options.ledger);
  if (ledger.status !== 'beta') fail(`Cannot promote ledger status ${ledger.status}.`);
  if (!['passed', 'post-promote'].includes(ledger.canary?.status)) {
    const parked =
      ledger.canary?.status === 'blocked' && ledger.canary.reason
        ? ` Promotion is parked: ${ledger.canary.reason}`
        : '';
    fail(
      `Refusing production promotion without a passed or explicitly post-promote canary.${parked}`,
    );
  }
  const configuredPins = readPinnedRuntimeVersion(process.cwd());
  const targetCandidates = Array.isArray(ledger.candidateTargets) ? ledger.candidateTargets : null;
  let candidates;
  let promoted;
  let productionTargets;
  if (targetCandidates) {
    const promotedTargets = targetCandidates.map((target) => {
      const result = runEas(
        [
          'update:republish',
          '--group',
          target.group,
          '--destination-branch',
          'production',
          '--platform',
          target.platform,
          '--message',
          `promote beta ${target.group} (${ledger.sourceSha.slice(0, 12)})`,
          '--json',
          '--non-interactive',
        ],
        { dryRun: options.dryRun },
      );
      return options.dryRun
        ? null
        : requireTargetUpdate(result, `Production promotion of ${targetKey(target)}`, target);
    });
    if (options.dryRun) return;
    productionTargets = promotedTargets.filter(Boolean);
    const updates = productionTargets.map((target) => target.update);
    promoted = {
      groupByPlatform: platformGroupSummary(productionTargets, configuredPins),
      groupIds: [...new Set(productionTargets.map((target) => target.group))],
      updates,
    };
    candidates = targetCandidates.map((target) => target.group);
  } else {
    candidates = candidateGroupMap(ledger);
    promoted = republishGroups(republishEntries(candidates), {
      label: 'Production promotion',
      describe: (group) => `promote beta ${group} (${ledger.sourceSha.slice(0, 12)})`,
      dryRun: options.dryRun,
      expectedPlatforms: Object.keys(candidates),
    });
  }
  if (options.dryRun) return;
  ledger.status = 'production';
  ledger.production = {
    ...(targetCandidates ? { sourceTargets: targetCandidates } : {}),
    sourceGroupIds: targetCandidates
      ? platformGroupSummary(targetCandidates, configuredPins)
      : candidates,
    sourceGroupId: joinGroupIds(candidates),
    ...(productionTargets
      ? { targets: productionTargets.map(({ update: _update, ...target }) => target) }
      : {}),
    groupIds: promoted.groupByPlatform,
    groupId: joinGroupIds(promoted.groupIds),
    updates: promoted.updates,
    promotedAt: isoNow(),
  };
  ledger.delivery = {
    ...ledger.delivery,
    state: 'published',
    groupIds: promoted.groupIds,
    groupId: joinGroupIds(promoted.groupIds),
    publishedAt: ledger.production.promotedAt,
  };
  writeLedger(options.ledger, ledger);
  if (options.index) {
    markPublished(options.index, {
      groupIds: promoted.groupIds,
      updateIds: promoted.updates.map((update) => update.id),
      headSha: ledger.sourceSha,
      releaseVersion: ledger.releaseVersion,
      publishedAt: ledger.production.promotedAt,
      runId: String(ledger.delivery?.runId ?? options.runId ?? 'unknown'),
      attempt: Number(ledger.delivery?.attempt ?? options.attempt ?? 1),
    });
  }
}

function assertPromotion(options) {
  const ledger = readLedger(options.ledger);
  if (ledger.status !== 'production') {
    fail(`Production promotion did not complete; ledger status is ${ledger.status}.`);
  }
  const candidates =
    ledger.candidateTargets?.map((target) => target.group) ??
    groupMapFrom(ledger.candidateGroupIds ?? ledger.candidateGroupId);
  const sources =
    ledger.production?.sourceTargets?.map((target) => target.group) ??
    groupMapFrom(ledger.production?.sourceGroupIds ?? ledger.production?.sourceGroupId);
  const producedTargets = ledger.production?.targets;
  const produced =
    producedTargets?.map((target) => target.group) ??
    groupMapFrom(ledger.production?.groupIds ?? ledger.production?.groupId);
  const producedByPlatform = groupMapFrom(
    ledger.production?.groupIds ?? ledger.production?.groupId,
  );
  if (
    groupIdList(candidates).length === 0 ||
    groupIdList(produced).length === 0 ||
    !sameGroupSet(sources, candidates) ||
    !Array.isArray(ledger.production.updates) ||
    ledger.production.updates.length === 0
  ) {
    fail('Production promotion proof is incomplete or does not name the exact beta source group.');
  }
  const platforms = new Set(ledger.production.updates.map((update) => update.platform));
  for (const platform of RELEASE_PLATFORMS) {
    if (!platforms.has(platform)) {
      fail('Production promotion proof must contain both Android and iOS updates.');
    }
    if (!producedByPlatform[platform]) {
      fail(`Production promotion proof names no ${platform} production update group.`);
    }
  }
  if (Array.isArray(ledger.updateTargets)) {
    const expected = ledger.updateTargets.map(targetKey).sort();
    const actual = (producedTargets ?? []).map(targetKey).sort();
    if (
      expected.length !== actual.length ||
      expected.some((target, index) => target !== actual[index])
    ) {
      fail(`Production promotion targets do not match the release target list.`);
    }
  }

  if (options.index) {
    const index = readJson(options.index);
    const head = index.merges?.find((merge) => merge.sha === ledger.sourceSha);
    if (
      !head ||
      !['published', 'confirmed'].includes(head.state) ||
      !sameGroupSet(head.published?.groupIds ?? head.published?.groupId, produced)
    ) {
      fail('Delivery index does not prove that the current main head was published to production.');
    }
  }

  console.log(`production_group_id=${joinGroupIds(produced)}`);
  console.log(`source_group_id=${joinGroupIds(sources)}`);
  console.log(
    `production_groups=${RELEASE_PLATFORMS.map((platform) => `${platform}=${ledger.production.groupIds?.[platform] ?? ''}`).join(',')}`,
  );
  if (producedTargets)
    console.log(`production_targets=${producedTargets.map(targetKey).join(',')}`);
  console.log(`source_sha=${ledger.sourceSha}`);
  if (ledger.releaseVersion) console.log(`release_version=${ledger.releaseVersion}`);
}

function assertProductionList(options) {
  const ledger = readLedger(options.ledger);
  if (!Array.isArray(ledger.updateTargets) || !Array.isArray(ledger.production?.targets)) {
    fail('Production target-list proof requires a target-aware release ledger.');
  }
  const listed = runEas(
    [
      'update:list',
      '--branch',
      'production',
      '--limit',
      PRODUCTION_LOOKUP_LIMIT,
      '--json',
      '--non-interactive',
    ],
    { dryRun: options.dryRun },
  );
  if (options.dryRun) return;
  const observed = newestTargets(listed, ledger.updateTargets);
  const expected = new Map(
    ledger.production.targets.map((target) => [targetKey(target), target.group]),
  );
  if (
    observed.length !== expected.size ||
    observed.some((target) => expected.get(targetKey(target)) !== target.group)
  ) {
    const description = [...expected.entries()]
      .map(([target, group]) => target + '=' + group)
      .join(', ');
    fail(
      'eas update:list does not show the exact production targets: expected ' + description + '.',
    );
  }
  console.log('listed_production_targets=' + observed.map(targetKey).join(','));
  console.log('listed_production_groups=' + observed.map((target) => target.group).join(','));
}

function deliveryTarget(options) {
  const delivery = latestPublishedDelivery(options.index) ?? {
    groupId: '',
    updateIds: [],
    releaseVersion: '',
    sourceSha: '',
  };
  const lines = [
    `group_id=${delivery.groupId}`,
    `update_ids=${delivery.updateIds.join(',')}`,
    `release_version=${delivery.releaseVersion}`,
    `source_sha=${delivery.sourceSha}`,
  ];
  console.log(lines.join('\n'));
}

function rollback(options) {
  // Embedded-only mode serves the runtime's FIRST production release: its
  // ledger carries no previousProductionGroupId because no earlier update
  // group exists to republish, and the only known-good bundle is the one
  // embedded in that release's store binary. Every current production target
  // is rolled back through update:roll-back-to-embedded instead.
  const embeddedOnly = options.embedded === true;
  const sourceIds = groupIdList(options.group);
  let currentTargets = [];
  if (embeddedOnly && sourceIds.length > 0) {
    fail('rollback --embedded rolls back to the embedded update and takes no --group');
  }
  if (!embeddedOnly && sourceIds.length === 0) fail('rollback requires --group');
  if (embeddedOnly && !options.expectedCurrentGroup) {
    fail(
      'rollback --embedded requires --expected-current-group naming the production group being rolled back',
    );
  }
  if (!embeddedOnly && sourceIds.length > releaseUpdateTargets(process.cwd()).length) {
    fail(
      `rollback --group names ${sourceIds.length} update groups; production carries at most one per release target.`,
    );
  }
  if (options.expectedCurrentGroup) {
    const current = runEas(
      [
        'update:list',
        '--branch',
        'production',
        '--limit',
        PRODUCTION_LOOKUP_LIMIT,
        '--json',
        '--non-interactive',
      ],
      { dryRun: options.dryRun },
    );
    if (!options.dryRun) {
      const expectedCurrentIds = groupIdList(options.expectedCurrentGroup);
      currentTargets =
        expectedCurrentIds.length > RELEASE_PLATFORMS.length
          ? newestTargets(current, releaseUpdateTargets(process.cwd()))
          : [];
      const observed =
        currentTargets.length > 0
          ? currentTargets.map((target) => target.group)
          : newestGroupByPlatform(current);
      if (!sameGroupSet(observed, options.expectedCurrentGroup)) {
        writeLedger(options.ledger, {
          schemaVersion: 2,
          status: 'rollback-skipped-superseded',
          sourceGroupIds: sourceIds,
          sourceGroupId: joinGroupIds(sourceIds),
          expectedCurrentGroupId: joinGroupIds(options.expectedCurrentGroup),
          observedCurrentGroupIds: observed,
          observedCurrentGroupId: joinGroupIds(observed) || null,
          recordedAt: isoNow(),
        });
        console.log(
          `Rollback skipped: production moved from ${joinGroupIds(options.expectedCurrentGroup)} to ${joinGroupIds(observed) || 'unknown'}.`,
        );
        return;
      }
    } else if (embeddedOnly && options.dryRun) {
      // A dry run has no production payload to read; name the configured
      // release targets so the printed plan shows one embedded rollback per
      // target, mirroring what a real run would query from production.
      currentTargets = releaseUpdateTargets(process.cwd());
    }
  }
  const rolledBack = embeddedOnly
    ? { updates: [] }
    : republishGroups(
        sourceIds.map((group) => [group, null]),
        {
          label: 'Production rollback',
          describe: (group) => `rollback production to ${group}`,
          dryRun: options.dryRun,
          expectedPlatforms: RELEASE_PLATFORMS,
        },
      );
  if (options.dryRun && !embeddedOnly) return;
  const restoredTargetKeys = new Set(rolledBack.updates.map(targetKey));
  const missingTargets = currentTargets.filter(
    (target) => !restoredTargetKeys.has(targetKey(target)),
  );
  const embeddedRollbackTargets = missingTargets.map((target) => {
    const result = runEas(
      [
        'update:roll-back-to-embedded',
        '--branch',
        'production',
        '--runtime-version',
        target.runtimeVersion,
        '--platform',
        target.platform,
        '--message',
        `rollback ${targetKey(target)} to embedded update`,
        '--json',
        '--non-interactive',
      ],
      { env: { EXPO_RUNTIME_OVERRIDE: target.runtimeVersion }, dryRun: options.dryRun },
    );
    if (options.dryRun) return { ...target, update: null };
    return requireTargetUpdate(result, `Embedded rollback of ${targetKey(target)}`, target);
  });
  if (options.dryRun) return;
  const restoredTargets = [
    ...rolledBack.updates.map((update) => ({ ...update, update })),
    ...embeddedRollbackTargets,
  ];
  const restoredKeys = new Set(restoredTargets.map(targetKey));
  const stillMissing = currentTargets.filter((target) => !restoredKeys.has(targetKey(target)));
  if (stillMissing.length > 0) {
    fail(
      `Rollback did not contain ${stillMissing.map(targetKey).join(', ')}; refusing to record success.`,
    );
  }
  const productionUpdates = restoredTargets.map((target) => target.update);
  const productionGroups = [...new Set(productionUpdates.map((update) => update.group))];
  const configuredPins = readPinnedRuntimeVersion(process.cwd());
  writeLedger(options.ledger, {
    schemaVersion: 2,
    status: 'rolled-back',
    ...(embeddedOnly ? { embeddedOnly: true } : {}),
    sourceGroupIds: sourceIds,
    sourceGroupId: joinGroupIds(sourceIds),
    productionGroupIds: platformGroupSummary(restoredTargets, configuredPins),
    productionGroupId: joinGroupIds(productionGroups),
    productionUpdates,
    ...(embeddedRollbackTargets.length > 0
      ? {
          embeddedRollbackTargets: embeddedRollbackTargets.map(
            ({ platform, runtimeVersion, group }) => ({ platform, runtimeVersion, group }),
          ),
        }
      : {}),
    rolledBackAt: isoNow(),
  });
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  try {
    switch (options.command) {
      case 'init-delivery':
        initDelivery(options);
        break;
      case 'publish':
        publish(options);
        break;
      case 'mark-canary':
        markCanary(options);
        break;
      case 'promote':
        promote(options);
        break;
      case 'assert-promotion':
        assertPromotion(options);
        break;
      case 'assert-production-list':
        assertProductionList(options);
        break;
      case 'rollback':
        rollback(options);
        break;
      case 'record-failure':
        recordFailure(options);
        break;
      case 'confirm':
        console.log(JSON.stringify(confirmDelivery(options)));
        break;
      case 'list-undelivered':
        listUndelivered(options);
        break;
      case 'classify-failure':
        console.log(classifyFailure(options.exitCode, options.reason));
        break;
      case 'delivery-target':
        deliveryTarget(options);
        break;
      case 'merge-reconciliation':
        mergeReconciliation(options);
        break;
      default:
        fail(
          'Usage: ota-release.mjs <init-delivery|publish|mark-canary|promote|assert-promotion|assert-production-list|rollback|record-failure|confirm|list-undelivered|classify-failure|delivery-target|merge-reconciliation> [options]',
        );
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
