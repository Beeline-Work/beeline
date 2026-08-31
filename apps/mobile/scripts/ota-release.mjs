#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  classifyFailure,
  confirmDelivery,
  initDelivery,
  isoNow,
  latestPublishedDelivery,
  listUndelivered,
  markBuilt,
  markPublished,
  mergeReconciliation,
  readJson,
  recordFailure,
  writeJson,
} from './ota-delivery-index.mjs';

const EAS_CLI_VERSION = '22.2.0';

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
  if (result.status !== 0) {
    if (allowFailure) return null;
    fail(`EAS command failed (${result.status ?? 'signal'}): ${parts.map(shellQuote).join(' ')}`);
  }
  const output = result.stdout.trim();
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(`EAS command did not return JSON: ${error.message}`);
  }
}

function visit(value, callback) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
    return;
  }
  if (!value || typeof value !== 'object') return;
  callback(value);
  for (const child of Object.values(value)) visit(child, callback);
}

function normalizeUpdates(payload) {
  const updates = [];
  const seen = new Set();
  visit(payload, (value) => {
    const id = typeof value.id === 'string' ? value.id : null;
    const platform = typeof value.platform === 'string' ? value.platform : null;
    const group =
      typeof value.group === 'string'
        ? value.group
        : typeof value.group?.id === 'string'
          ? value.group.id
          : typeof value.groupId === 'string'
            ? value.groupId
            : null;
    if (!id || !platform || !group || seen.has(id)) return;
    seen.add(id);
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
  });
  return updates;
}

function firstGroupId(payload) {
  let groupId = null;
  visit(payload, (value) => {
    if (groupId) return;
    if (typeof value.group === 'string') groupId = value.group;
    else if (typeof value.group?.id === 'string') groupId = value.group.id;
    else if (typeof value.groupId === 'string') groupId = value.groupId;
  });
  return groupId;
}

function requirePublishedGroup(payload, label) {
  const updates = normalizeUpdates(payload);
  const groups = new Set(updates.map((update) => update.group));
  if (groups.size !== 1) {
    fail(`${label} must return one update group; received ${groups.size}.`);
  }
  return { groupId: [...groups][0], updates };
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
    ['update:list', '--branch', 'production', '--limit', '1', '--json', '--non-interactive'],
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
  const published = requirePublishedGroup(candidate, 'Beta publish');
  const android = published.updates.find((update) => update.platform === 'android');
  if (!android) fail('Beta publish did not return an Android update.');
  const existing = existsSync(options.ledger) ? readLedger(options.ledger) : {};
  const ledger = {
    ...existing,
    schemaVersion: 2,
    status: 'beta',
    sourceSha: options.sha,
    sourceRef: options.ref,
    candidateGroupId: published.groupId,
    candidateUpdates: published.updates,
    androidUpdateId: android.id,
    runtimeVersions: [
      ...new Set(published.updates.map((update) => update.runtimeVersion).filter(Boolean)),
    ],
    previousProductionGroupId: firstGroupId(previous),
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
  const message = `promote beta ${ledger.candidateGroupId} (${ledger.sourceSha.slice(0, 12)})`;
  const result = runEas(
    [
      'update:republish',
      '--group',
      ledger.candidateGroupId,
      '--destination-branch',
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
  const promoted = requirePublishedGroup(result, 'Production promotion');
  ledger.status = 'production';
  ledger.production = {
    sourceGroupId: ledger.candidateGroupId,
    groupId: promoted.groupId,
    updates: promoted.updates,
    promotedAt: isoNow(),
  };
  ledger.delivery = {
    ...ledger.delivery,
    state: 'published',
    groupId: promoted.groupId,
    publishedAt: ledger.production.promotedAt,
  };
  writeLedger(options.ledger, ledger);
  if (options.index) {
    markPublished(options.index, {
      groupId: promoted.groupId,
      updateIds: promoted.updates.map((update) => update.id),
      headSha: ledger.sourceSha,
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
  if (
    !ledger.candidateGroupId ||
    !ledger.production?.groupId ||
    ledger.production.sourceGroupId !== ledger.candidateGroupId ||
    !Array.isArray(ledger.production.updates) ||
    ledger.production.updates.length === 0
  ) {
    fail('Production promotion proof is incomplete or does not name the exact beta source group.');
  }
  const platforms = new Set(ledger.production.updates.map((update) => update.platform));
  if (!platforms.has('android') || !platforms.has('ios')) {
    fail('Production promotion proof must contain both Android and iOS updates.');
  }

  if (options.index) {
    const index = readJson(options.index);
    const head = index.merges?.find((merge) => merge.sha === ledger.sourceSha);
    if (
      !head ||
      !['published', 'confirmed'].includes(head.state) ||
      head.published?.groupId !== ledger.production.groupId
    ) {
      fail('Delivery index does not prove that the current main head was published to production.');
    }
  }

  console.log(`production_group_id=${ledger.production.groupId}`);
  console.log(`source_group_id=${ledger.production.sourceGroupId}`);
  console.log(`source_sha=${ledger.sourceSha}`);
}

function deliveryTarget(options) {
  const delivery = latestPublishedDelivery(options.index) ?? { groupId: '', updateIds: [] };
  const lines = [`group_id=${delivery.groupId}`, `update_ids=${delivery.updateIds.join(',')}`];
  console.log(lines.join('\n'));
}

function rollback(options) {
  if (!options.group) fail('rollback requires --group');
  if (options.expectedCurrentGroup) {
    const current = runEas(
      ['update:list', '--branch', 'production', '--limit', '1', '--json', '--non-interactive'],
      { dryRun: options.dryRun },
    );
    if (!options.dryRun) {
      const currentGroup = firstGroupId(current);
      if (currentGroup !== options.expectedCurrentGroup) {
        writeLedger(options.ledger, {
          schemaVersion: 1,
          status: 'rollback-skipped-superseded',
          sourceGroupId: options.group,
          expectedCurrentGroupId: options.expectedCurrentGroup,
          observedCurrentGroupId: currentGroup,
          recordedAt: isoNow(),
        });
        console.log(
          `Rollback skipped: production moved from ${options.expectedCurrentGroup} to ${currentGroup ?? 'unknown'}.`,
        );
        return;
      }
    }
  }
  const message = `rollback production to ${options.group}`;
  const result = runEas(
    [
      'update:republish',
      '--group',
      options.group,
      '--destination-branch',
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
  const rolledBack = requirePublishedGroup(result, 'Production rollback');
  writeLedger(options.ledger, {
    schemaVersion: 1,
    status: 'rolled-back',
    sourceGroupId: options.group,
    productionGroupId: rolledBack.groupId,
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
