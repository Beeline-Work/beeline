import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

function invalid(message) {
  throw new Error(message);
}

export function isoNow() {
  return new Date().toISOString();
}

export function writeJson(path, value) {
  if (!path) invalid('A JSON output path is required.');
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readJson(path) {
  if (!path) invalid('A JSON input path is required.');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function emptyDeliveryIndex() {
  return { schemaVersion: 1, updatedAt: isoNow(), merges: [] };
}

export function readDeliveryIndex(path) {
  if (!path) invalid('--index is required');
  if (!existsSync(path)) return emptyDeliveryIndex();
  const index = readJson(path);
  if (index.schemaVersion !== 1 || !Array.isArray(index.merges)) {
    invalid('Unsupported mobile OTA delivery index.');
  }
  return index;
}

export function writeDeliveryIndex(path, index) {
  index.updatedAt = isoNow();
  writeJson(path, index);
}

function currentMerge(index, sha) {
  const merge = index.merges.find((entry) => entry.sha === sha);
  if (!merge) invalid(`Delivery index does not contain ${sha}.`);
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

function discoverCommitList(options, index) {
  if (options.commits) {
    const commits = readJson(options.commits);
    if (!Array.isArray(commits)) invalid('--commits must name a JSON array');
    return commits;
  }

  const head = options.sha;
  const lastTracked = index.merges.at(-1)?.sha;
  let rangeStart = options.before && !/^0+$/.test(options.before) ? options.before : null;
  if (lastTracked) {
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', lastTracked, head]);
    if (ancestor.status === 0) rangeStart = lastTracked;
  }
  if (!rangeStart) return [{ sha: head, ref: options.ref }];

  const shas = execFileSync('git', ['rev-list', '--reverse', `${rangeStart}..${head}`], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return (shas.length === 0 ? [head] : shas).map((sha) => ({ sha, ref: options.ref }));
}

export function initDelivery(options) {
  if (!options.sha || !options.ref || !options.runId) {
    invalid('init-delivery requires --sha, --ref, and --run-id');
  }
  const attempt = Number(options.attempt ?? '1');
  if (!Number.isInteger(attempt) || attempt < 1) invalid('--attempt must be a positive integer');
  const index = readDeliveryIndex(options.index);
  for (const commit of discoverCommitList(options, index)) {
    if (!commit || typeof commit.sha !== 'string' || !/^[0-9a-f]{7,64}$/.test(commit.sha)) {
      invalid('commit list contains an invalid sha');
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
  writeJson(options.ledger, {
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

export function markBuilt(indexPath, sha) {
  const index = readDeliveryIndex(indexPath);
  const merge = currentMerge(index, sha);
  if (merge.state !== 'confirmed' && merge.state !== 'published') merge.state = 'built';
  merge.builtAt = isoNow();
  writeDeliveryIndex(indexPath, index);
}

export function markPublished(indexPath, publication) {
  const index = readDeliveryIndex(indexPath);
  for (const merge of index.merges) {
    if (merge.state === 'confirmed') continue;
    merge.state = 'published';
    merge.published = {
      groupId: publication.groupId,
      updateIds: publication.updateIds,
      headSha: publication.headSha,
      publishedAt: publication.publishedAt,
    };
  }
  const merge = currentMerge(index, publication.headSha);
  const attempt = runAttempt(merge, publication.runId, publication.attempt);
  Object.assign(attempt, { status: 'published', finishedAt: isoNow() });
  writeDeliveryIndex(indexPath, index);
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

export function recordFailure(options) {
  if (!options.sha || !options.runId) invalid('record-failure requires --sha and --run-id');
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
    const ledger = readJson(options.ledger);
    ledger.failure = failure;
    ledger.delivery = { ...ledger.delivery, state: merge.state };
    writeJson(options.ledger, ledger);
  }
}

export function confirmDelivery(options) {
  if (!options.receipt || !options.group) invalid('confirm requires --receipt and --group');
  const payload = readJson(options.receipt);
  const updateIds = new Set(
    String(options.updateIds ?? '')
      .split(',')
      .filter(Boolean),
  );
  const devices = Array.isArray(payload.devices) ? payload.devices : [];
  const receipt = devices.find(
    (device) =>
      device?.environment === 'physical' &&
      (device.group === options.group || (device.updateId && updateIds.has(device.updateId))),
  );
  if (!receipt) return { confirmed: false, groupId: options.group };

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
    const ledger = readJson(options.ledger);
    ledger.delivery = {
      ...ledger.delivery,
      state: 'confirmed',
      deviceId: receipt.deviceId,
      updateId: receipt.updateId ?? null,
      confirmedAt: isoNow(),
    };
    writeJson(options.ledger, ledger);
  }
  return { confirmed: true, groupId: options.group, merges: count };
}

export function listUndelivered(options) {
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

export function latestPublishedDelivery(indexPath) {
  const merge = readDeliveryIndex(indexPath)
    .merges.filter((entry) => entry.state === 'published')
    .at(-1);
  if (!merge) return null;
  return { groupId: merge.published.groupId, updateIds: merge.published.updateIds };
}

export function mergeReconciliation(options) {
  if (!options.base || !options.overlay || !options.output) {
    invalid('merge-reconciliation requires --base, --overlay, and --output');
  }
  const base = readDeliveryIndex(options.base);
  const overlay = readDeliveryIndex(options.overlay);
  const bySha = new Map(base.merges.map((merge) => [merge.sha, merge]));
  const overlayOnly = [];

  for (const observed of overlay.merges) {
    const current = bySha.get(observed.sha);
    if (!current) {
      overlayOnly.push(observed);
      bySha.set(observed.sha, observed);
      continue;
    }
    if (
      observed.state === 'confirmed' &&
      current.state === 'published' &&
      observed.confirmed?.groupId === current.published?.groupId
    ) {
      current.state = 'confirmed';
      current.confirmed = observed.confirmed;
    }
  }

  // Reconciliation starts from an older index, so any overlay-only entries
  // precede the latest production index. Keep the newest merge last because
  // initDelivery uses that entry as its Git discovery boundary.
  base.merges = [...overlayOnly, ...base.merges];
  writeDeliveryIndex(options.output, base);
}
