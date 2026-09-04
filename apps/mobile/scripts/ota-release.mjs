#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
// A fingerprint runtime gives Android and iOS different runtime versions, so
// the production branch carries one newest update group per platform. Read
// enough of the branch to see both of them, then pick newest-per-platform.
const PRODUCTION_LOOKUP_LIMIT = '10';

function fail(message) {
  console.error(message);
  process.exit(1);
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

function runEas(args, { allowFailure = false, dryRun = false } = {}) {
  const parts = commandParts(args);
  if (dryRun) {
    console.log(parts.map(shellQuote).join(' '));
    return null;
  }
  const result = spawnSync(parts[0], parts.slice(1), {
    encoding: 'utf8',
    env: process.env,
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
    if (id && platform && !seen.has(id)) {
      seen.add(id);
      if (group) {
        updates.push({
          id,
          platform,
          group,
          runtimeVersion:
            typeof value.runtimeVersion === 'string'
              ? value.runtimeVersion
              : typeof value.runtime?.version === 'string'
                ? value.runtime.version
                : null,
        });
      } else {
        groupless.push({ id, platform });
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

// One publish/republish call returns one update group per platform it covered:
// with `runtimeVersion: { policy: "fingerprint" }` Android and iOS have
// different runtime versions and therefore never share a group. A ledger
// written before that change has a single group covering both platforms, which
// still satisfies this check.
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

// A ledger written before the fingerprint runtime carries one candidate group
// that covered every published platform; read it as that group for each.
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
    { allowFailure: true, dryRun: options.dryRun },
  );
  const message = `ota candidate: ${options.sha.slice(0, 12)} ${options.ref}`;
  const candidate = runEas(
    [
      'update',
      '--branch',
      'beta',
      '--environment',
      'production',
      '--platform',
      'all',
      '--message',
      message,
      '--json',
      '--non-interactive',
    ],
    { dryRun: options.dryRun },
  );

  if (options.dryRun) return;
  // `--platform all` builds every release platform, so the publish must come
  // back covering exactly those, in one group per platform.
  const published = requirePublishedGroups(candidate, 'Beta publish', RELEASE_PLATFORMS);
  const android = published.updates.find((update) => update.platform === 'android');
  if (!android) fail('Beta publish did not return an Android update.');
  const previousProduction = newestGroupByPlatform(previous);
  const existing = existsSync(options.ledger) ? readLedger(options.ledger) : {};
  const ledger = {
    ...existing,
    schemaVersion: 3,
    status: 'beta',
    sourceSha: options.sha,
    ...(options.releaseVersion ? { releaseVersion: options.releaseVersion } : {}),
    sourceRef: options.ref,
    candidateGroupIds: published.groupByPlatform,
    candidateGroupId: joinGroupIds(published.groupIds),
    candidateUpdates: published.updates,
    androidUpdateId: android.id,
    runtimeVersions: [
      ...new Set(published.updates.map((update) => update.runtimeVersion).filter(Boolean)),
    ],
    previousProductionGroupIds: previousProduction,
    previousProductionGroupId: joinGroupIds(previousProduction) || null,
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
    fail(`Refusing production promotion without a passed or explicitly post-promote canary.${parked}`);
  }
  const candidates = candidateGroupMap(ledger);
  const promoted = republishGroups(republishEntries(candidates), {
    label: 'Production promotion',
    describe: (group) => `promote beta ${group} (${ledger.sourceSha.slice(0, 12)})`,
    dryRun: options.dryRun,
    expectedPlatforms: Object.keys(candidates),
  });
  if (options.dryRun) return;
  ledger.status = 'production';
  ledger.production = {
    sourceGroupIds: candidates,
    sourceGroupId: joinGroupIds(candidates),
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
  const candidates = groupMapFrom(ledger.candidateGroupIds ?? ledger.candidateGroupId);
  const sources = groupMapFrom(
    ledger.production?.sourceGroupIds ?? ledger.production?.sourceGroupId,
  );
  const produced = groupMapFrom(ledger.production?.groupIds ?? ledger.production?.groupId);
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
    if (!produced[platform]) {
      fail(`Production promotion proof names no ${platform} production update group.`);
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
    `production_groups=${RELEASE_PLATFORMS.map((platform) => `${platform}=${produced[platform]}`).join(',')}`,
  );
  console.log(`source_sha=${ledger.sourceSha}`);
  if (ledger.releaseVersion) console.log(`release_version=${ledger.releaseVersion}`);
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
  const sourceIds = groupIdList(options.group);
  if (sourceIds.length === 0) fail('rollback requires --group');
  if (sourceIds.length > RELEASE_PLATFORMS.length) {
    fail(
      `rollback --group names ${sourceIds.length} update groups; production carries at most one per platform (${describePlatforms(RELEASE_PLATFORMS)}).`,
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
      const observed = newestGroupByPlatform(current);
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
    }
  }
  const rolledBack = republishGroups(
    sourceIds.map((group) => [group, null]),
    {
      label: 'Production rollback',
      describe: (group) => `rollback production to ${group}`,
      dryRun: options.dryRun,
      expectedPlatforms: RELEASE_PLATFORMS,
    },
  );
  if (options.dryRun) return;
  writeLedger(options.ledger, {
    schemaVersion: 2,
    status: 'rolled-back',
    sourceGroupIds: sourceIds,
    sourceGroupId: joinGroupIds(sourceIds),
    productionGroupIds: rolledBack.groupByPlatform,
    productionGroupId: joinGroupIds(rolledBack.groupIds),
    productionUpdates: rolledBack.updates,
    rolledBackAt: isoNow(),
  });
}

const options = parseArgs(process.argv.slice(2));
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
        'Usage: ota-release.mjs <init-delivery|publish|mark-canary|promote|assert-promotion|rollback|record-failure|confirm|list-undelivered|classify-failure|delivery-target|merge-reconciliation> [options]',
      );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
