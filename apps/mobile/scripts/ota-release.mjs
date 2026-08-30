#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

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
    if (!value || value.startsWith('--')) fail(`Missing value for ${token}`);
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
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readLedger(path) {
  if (!path) fail('--ledger is required');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function emptyDeliveryIndex() {
  return { schemaVersion: 1, updatedAt: isoNow(), merges: [] };
}

function readDeliveryIndex(path) {
  if (!path) fail('--index is required');
  if (!existsSync(path)) return emptyDeliveryIndex();
  const index = JSON.parse(readFileSync(path, 'utf8'));
  if (index.schemaVersion !== 1 || !Array.isArray(index.merges)) {
    fail('Unsupported mobile OTA delivery index.');
  }
  return index;
}

function writeDeliveryIndex(path, index) {
  index.updatedAt = isoNow();
  writeLedger(path, index);
}

function currentMerge(index, sha) {
  const merge = index.merges.find((entry) => entry.sha === sha);
  if (!merge) fail(`Delivery index does not contain ${sha}.`);
  return merge;
}

function runAttempt(merge, runId, attempt) {
  merge.attempts ??= [];
  let run = merge.attempts.find((entry) => entry.runId === runId);
  if (!run) {
    run = { runId, attempt, status: 'running', startedAt: isoNow() };
    merge.attempts.push(run);
  }
  return run;
}

function readCommitList(options) {
  if (!options.commits) return [{ sha: options.sha, ref: options.ref }];
  const commits = JSON.parse(readFileSync(options.commits, 'utf8'));
  if (!Array.isArray(commits)) fail('--commits must name a JSON array');
  return commits;
}

function initDelivery(options) {
  if (!options.sha || !options.ref || !options.runId) {
    fail('init-delivery requires --sha, --ref, and --run-id');
  }
  const attempt = Number(options.attempt ?? '1');
  if (!Number.isInteger(attempt) || attempt < 1) fail('--attempt must be a positive integer');
  const index = readDeliveryIndex(options.index);
  for (const commit of readCommitList(options)) {
    if (!commit || typeof commit.sha !== 'string' || !/^[0-9a-f]{7,64}$/.test(commit.sha)) {
      fail('commit list contains an invalid sha');
    }
    if (index.merges.some((entry) => entry.sha === commit.sha)) continue;
    index.merges.push({
      sha: commit.sha,
      ref: typeof commit.ref === 'string' ? commit.ref : options.ref,
      state: 'pending',
      firstSeenAt: isoNow(),
      attempts: [],
      failures: [],
    });
  }
  const merge = currentMerge(index, options.sha);
  runAttempt(merge, options.runId, attempt);
  writeDeliveryIndex(options.index, index);
  writeLedger(options.ledger, {
    schemaVersion: 2,
    status: 'pending',
    sourceSha: options.sha,
    sourceRef: options.ref,
    createdAt: isoNow(),
    delivery: { state: 'pending', runId: options.runId, attempt },
    canary: { status: 'pending' },
    production: null,
  });
}

export function classifyFailure(exitCode, reason) {
  const code = Number(exitCode);
  const detail = String(reason ?? '').toLowerCase();
  if (code === 2) return 'environment-setup';
  if (code === 124) return 'deadline';
  if (
    (detail.includes('smoke') || detail.includes('room send')) &&
    (detail.includes('timeout') || detail.includes('timed out'))
  ) {
    return 'smoke-timeout';
  }
  return 'app-side';
}

function recordFailure(options) {
  if (!options.sha || !options.runId) fail('record-failure requires --sha and --run-id');
  const index = readDeliveryIndex(options.index);
  const merge = currentMerge(index, options.sha);
  const attempt = Number(options.attempt ?? '1');
  const reason = String(options.reason ?? 'governor step failed').slice(0, 800);
  const failureClass = options.class ?? classifyFailure(options.exitCode, reason);
  const failure = {
    runId: options.runId,
    attempt,
    class: failureClass,
    exitCode: Number(options.exitCode ?? '1'),
    reason,
    recordedAt: isoNow(),
  };
  merge.failures ??= [];
  const prior = merge.failures.find((entry) => entry.runId === options.runId);
  if (prior) Object.assign(prior, failure);
  else merge.failures.push(failure);
  Object.assign(runAttempt(merge, options.runId, attempt), {
    status: 'failed',
    failureClass,
    reason,
    finishedAt: isoNow(),
  });
  writeDeliveryIndex(options.index, index);
  if (options.ledger && existsSync(options.ledger)) {
    const ledger = readLedger(options.ledger);
    ledger.failure = failure;
    ledger.delivery = { ...ledger.delivery, state: merge.state };
    writeLedger(options.ledger, ledger);
  }
}

function isoNow() {
  return new Date().toISOString();
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
    const index = readDeliveryIndex(options.index);
    const merge = currentMerge(index, options.sha);
    if (merge.state !== 'confirmed' && merge.state !== 'published') merge.state = 'built';
    merge.builtAt = isoNow();
    writeDeliveryIndex(options.index, index);
  }
}

function markCanary(options) {
  if (!['passed', 'skipped', 'blocked'].includes(options.status)) {
    fail('mark-canary --status must be passed, skipped, or blocked');
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
  if (!['passed', 'skipped'].includes(ledger.canary?.status)) {
    const parked =
      ledger.canary?.status === 'blocked' && ledger.canary.reason
        ? ` Promotion is parked: ${ledger.canary.reason}`
        : '';
    fail(
      `Refusing production promotion before a passed or explicitly skipped canary.${parked}`,
    );
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
    const index = readDeliveryIndex(options.index);
    for (const merge of index.merges) {
      if (merge.state === 'confirmed') continue;
      merge.state = 'published';
      merge.published = {
        groupId: promoted.groupId,
        updateIds: promoted.updates.map((update) => update.id),
        headSha: ledger.sourceSha,
        publishedAt: ledger.production.promotedAt,
      };
    }
    const merge = currentMerge(index, ledger.sourceSha);
    const attempt = runAttempt(
      merge,
      String(ledger.delivery?.runId ?? options.runId ?? 'unknown'),
      Number(ledger.delivery?.attempt ?? options.attempt ?? 1),
    );
    Object.assign(attempt, { status: 'published', finishedAt: isoNow() });
    writeDeliveryIndex(options.index, index);
  }
}

function confirmDelivery(options) {
  if (!options.receipt || !options.group) fail('confirm requires --receipt and --group');
  const payload = JSON.parse(readFileSync(options.receipt, 'utf8'));
  const updateIds = new Set(String(options.updateIds ?? '').split(',').filter(Boolean));
  const devices = Array.isArray(payload.devices) ? payload.devices : [];
  const receipt = devices.find(
    (device) =>
      device?.environment === 'physical' &&
      (device.group === options.group || (device.updateId && updateIds.has(device.updateId))),
  );
  if (!receipt) {
    console.log(JSON.stringify({ confirmed: false, groupId: options.group }));
    return;
  }
  const index = readDeliveryIndex(options.index);
  let count = 0;
  for (const merge of index.merges) {
    if (merge.state !== 'published' || merge.published?.groupId !== options.group) continue;
    merge.state = 'confirmed';
    merge.confirmed = {
      groupId: options.group,
      updateId: receipt.updateId ?? null,
      channel: receipt.channel ?? null,
      deviceId: receipt.deviceId,
      reportedAt: receipt.reportedAt,
      confirmedAt: isoNow(),
    };
    count += 1;
  }
  writeDeliveryIndex(options.index, index);
  if (options.ledger && existsSync(options.ledger)) {
    const ledger = readLedger(options.ledger);
    ledger.delivery = {
      ...ledger.delivery,
      state: 'confirmed',
      deviceId: receipt.deviceId,
      updateId: receipt.updateId ?? null,
      confirmedAt: isoNow(),
    };
    writeLedger(options.ledger, ledger);
  }
  console.log(JSON.stringify({ confirmed: true, groupId: options.group, merges: count }));
}

function listUndelivered(options) {
  const index = readDeliveryIndex(options.index);
  const output = {
    schemaVersion: index.schemaVersion,
    updatedAt: index.updatedAt,
    undelivered: index.merges.filter((merge) => merge.state !== 'confirmed'),
  };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (options.output) writeFileSync(options.output, serialized);
  else process.stdout.write(serialized);
}

function rollback(options) {
  if (!options.group) fail('rollback requires --group');
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
  case 'rollback':
    rollback(options);
    break;
  case 'record-failure':
    recordFailure(options);
    break;
  case 'confirm':
    confirmDelivery(options);
    break;
  case 'list-undelivered':
    listUndelivered(options);
    break;
  case 'classify-failure':
    console.log(classifyFailure(options.exitCode, options.reason));
    break;
  default:
    fail('Usage: ota-release.mjs <init-delivery|publish|mark-canary|promote|rollback|record-failure|confirm|list-undelivered|classify-failure> [options]');
}
