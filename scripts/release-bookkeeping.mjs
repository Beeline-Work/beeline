#!/usr/bin/env node
// Release bookkeeping, outside the release path.
//
// After each release attempt this writes one small JSON file to the Loops /
// insights data store (Beeline-Work/beeline-insights, releases/<version>.json):
// the merges the release delivered, the phone OTA branch and runtimes, whether
// the owner's phone reported the update, and how long each job took. It
// replaces the old cumulative delivery index artifact, owner-receipt
// confirmation and stage-timing files.
//
// Nothing in the release reads this file back, so it carries no release
// state. Every failure here (no token, GitHub down, receipt server down) is a
// warning and the script exits 0; the workflow job also sets
// continue-on-error, so bookkeeping never fails a release.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const INSIGHTS_REPOSITORY = 'Beeline-Work/beeline-insights';
const MAX_MERGES = 500;

function warn(message) {
  console.log(`::warning title=Release bookkeeping::${message}`);
}

function readJsonFile(path, fallback) {
  if (!path) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Commits from the previous release (exclusive) to this one, oldest first. */
export function mergesSince(previousSha, sha, git = execFileSync) {
  const range = previousSha ? `${previousSha}..${sha}` : sha;
  const args = ['log', '--reverse', '--format=%H%x09%cI%x09%s', range];
  if (!previousSha) args.splice(1, 0, '-1');
  const lines = git('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
  return lines.slice(-MAX_MERGES).map((line) => {
    const [commit, committedAt, ...subject] = line.split('\t');
    return { sha: commit, committedAt, subject: subject.join('\t') };
  });
}

/** One entry per job of this run attempt, in start order. */
export function stageTimings(jobs) {
  return (jobs ?? [])
    .filter((job) => job.started_at)
    .map((job) => {
      const started = Date.parse(job.started_at);
      const completed = job.completed_at ? Date.parse(job.completed_at) : NaN;
      return {
        job: job.name,
        conclusion: job.conclusion ?? job.status ?? null,
        startedAt: job.started_at,
        completedAt: job.completed_at ?? null,
        seconds: Number.isFinite(completed) ? Math.max(0, Math.round((completed - started) / 1000)) : null,
      };
    })
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

/** The owner's physical phone reporting exactly this release, if it has. */
export function ownerReceipt(payload, { version, sha }) {
  const devices = Array.isArray(payload?.devices) ? payload.devices : [];
  const device = devices.find((entry) =>
    entry?.environment === 'physical' && entry.releaseVersion === version && entry.sourceSha === sha);
  if (!device) return { state: 'not-reported' };
  return {
    state: 'confirmed',
    deviceId: device.deviceId ?? null,
    updateId: device.updateId ?? null,
    channel: device.channel ?? null,
    reportedAt: device.reportedAt ?? null,
  };
}

function otaFromNeeds(needs) {
  const leg = [needs.mobile_ota, needs.mobile_ota_after_proof].find((job) => job?.outputs?.ota_branch);
  if (!leg) return null;
  const targets = String(leg.outputs.ota_targets ?? '').split(',').filter(Boolean);
  return {
    branch: leg.outputs.ota_branch,
    targets,
    promotedAt: leg.outputs.completed_at ? Number(leg.outputs.completed_at) : null,
  };
}

export function buildRecord({ version, sha, previous, needs, runId, attempt, merges, jobs, receipt, triggerEpoch }) {
  const result = needs.release_result ?? {};
  const ota = otaFromNeeds(needs);
  return {
    schemaVersion: 1,
    version,
    sourceSha: sha,
    previousVersion: previous?.version ?? null,
    previousSha: previous?.sourceSha ?? null,
    runId: Number(runId),
    attempt: Number(attempt),
    outcome: result.outputs?.outcome || result.result || 'unknown',
    failureClass: result.outputs?.failure_class || null,
    merges,
    ota: ota && {
      ...ota,
      fixToPhoneSeconds: ota.promotedAt && triggerEpoch ? ota.promotedAt - Number(triggerEpoch) : null,
    },
    ownerReceipt: receipt,
    stages: stageTimings(jobs),
    recordedAt: new Date().toISOString(),
  };
}

async function fetchJson(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${url} returned ${response.status}`);
  return response.json();
}

async function readJobs(fetchImpl, { api, repository, runId, attempt, token }) {
  const url = `${api}/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`;
  const body = await fetchJson(fetchImpl, url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  return body.jobs ?? [];
}

async function readReceipt(fetchImpl, { origin, pubkey, token, version, sha }) {
  if (!pubkey || !token) return { state: 'not-configured' };
  const payload = await fetchJson(fetchImpl, `${origin}/update-receipts/${pubkey}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return ownerReceipt(payload, { version, sha });
}

/** Create or replace releases/<version>.json; retries a concurrent write. */
export async function writeRecord(fetchImpl, { api, token, record }) {
  const url = `${api}/repos/${INSIGHTS_REPOSITORY}/contents/releases/${record.version}.json`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  const content = Buffer.from(`${JSON.stringify(record, null, 2)}\n`).toString('base64');
  for (let tries = 0; tries < 3; tries += 1) {
    const existing = await fetchImpl(`${url}?ref=main`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!existing.ok && existing.status !== 404) throw new Error(`GET ${url} returned ${existing.status}`);
    const current = existing.ok ? await existing.json() : null;
    const response = await fetchImpl(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Record release ${record.version} (attempt ${record.attempt})`,
        content,
        branch: 'main',
        ...(current?.sha ? { sha: current.sha } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return `releases/${record.version}.json`;
    if (response.status !== 409 && response.status !== 422) throw new Error(`PUT ${url} returned ${response.status}`);
  }
  throw new Error(`PUT ${url} conflicted three times`);
}

/** Collect and write; every failure becomes a warning. Returns the record. */
export async function run(env = process.env, { fetchImpl = fetch, git = execFileSync, log = console.log } = {}) {
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  const version = env.RELEASE_VERSION;
  const sha = env.RELEASE_SHA;
  const needs = readJsonFile(env.NEEDS_FILE, {});
  const previous = readJsonFile(env.PREVIOUS_RECORD_FILE, null);

  let merges = [];
  try {
    merges = mergesSince(previous?.sourceSha, sha, git);
  } catch (error) {
    warn(`merge list unavailable: ${error.message}`);
  }
  let jobs = [];
  try {
    jobs = await readJobs(fetchImpl, {
      api, repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT || '1', token: env.GH_TOKEN,
    });
  } catch (error) {
    warn(`stage timings unavailable: ${error.message}`);
  }
  let receipt;
  try {
    receipt = await readReceipt(fetchImpl, {
      origin: env.RECEIPT_ORIGIN || 'https://usebeeline.app/push',
      pubkey: env.OWNER_PUBKEY, token: env.RECEIPT_TOKEN, version, sha,
    });
  } catch (error) {
    receipt = { state: 'unavailable', reason: error.message };
  }

  const record = buildRecord({
    version, sha, previous, needs, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT || '1',
    merges, jobs, receipt, triggerEpoch: env.TRIGGER_EPOCH,
  });
  log(`release bookkeeping: ${record.merges.length} merge(s), ${record.stages.length} stage(s), owner receipt ${record.ownerReceipt.state}`);

  if (!env.INSIGHTS_TOKEN) {
    warn('BEELINE_INSIGHTS_TOKEN is not set; bookkeeping was not written. The release is unaffected.');
    return { record, written: null };
  }
  try {
    const path = await writeRecord(fetchImpl, { api: env.INSIGHTS_API_URL || api, token: env.INSIGHTS_TOKEN, record });
    log(`release bookkeeping written to ${INSIGHTS_REPOSITORY}/${path}`);
    return { record, written: path };
  } catch (error) {
    warn(`bookkeeping write failed: ${error.message}. The release is unaffected.`);
    return { record, written: null };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.RELEASE_VERSION || !process.env.RELEASE_SHA) {
    warn('RELEASE_VERSION and RELEASE_SHA are required; nothing recorded.');
  } else {
    await run().catch((error) => warn(`bookkeeping skipped: ${error.message}`));
  }
}
