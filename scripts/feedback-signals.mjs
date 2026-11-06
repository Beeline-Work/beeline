import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function normalizeError(text) {
  return String(text ?? '').toLowerCase()
    .replace(/https?:\/\/[^\s]+/g, '<url>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, '<id>')
    .replace(/\b[0-9a-f]{16,}\b/g, '<id>')
    .replace(/\b\d{4}-\d\d-\d\d[t\s][\d:.+z-]+/g, '<time>')
    .replace(/\s+/g, ' ').trim();
}

export function versionReport(row) {
  const later = Array.isArray(row.occurrences) ? row.occurrences.flatMap((item) => (
    item && typeof item === 'object' && ('helperVersion' in item || 'appVersion' in item || 'harness' in item)
      ? [{
        helperVersion: item.helperVersion ?? null,
        harness: item.harness ?? null,
        harnessVersion: item.harnessVersion ?? null,
        ...(item.sourceKind ? {itemId:item.itemId,sourceKind:item.sourceKind,
          reporterIdentityId:item.reporterIdentityId ?? null,
          appVersion:item.appVersion ?? null,appPlatform:item.appPlatform ?? null} : {}),
      }]
      : []
  )) : [];
  return {
    id: row.id,
    helperVersion: row.helper_version ?? null,
    appVersion: row.app_version ?? null,
    appPlatform: row.app_platform ?? null,
    harness: row.harness ?? null,
    harnessVersion: row.harness_version ?? null,
    helperIsLatest: row.helper_is_latest ?? null,
    appIsLatest: row.app_is_latest ?? null,
    latestReleasedVersion: row.latest_released_version ?? null,
    ...(later.length ? { later } : {}),
  };
}

function latestReleasedVersion(row) {
  return typeof row.latest_released_version === 'string' && row.latest_released_version
    ? row.latest_released_version
    : null;
}

/** Original filing plus later occurrences on the delivered release. Older evidence stays on the row. */
function latestEvidence(row) {
  const evidence = reportIsLatest(row) ? [{sourceKind:row.source_kind,
    reporterIdentityId:row.reporter_identity_id,affectedHumanIds:row.affected_human_ids ?? []}] : [];
  const released = latestReleasedVersion(row);
  if (!released || !Array.isArray(row.occurrences)) return evidence;
  for (const item of row.occurrences) {
    if (!item || typeof item !== 'object') continue;
    const sourceKind = item.sourceKind ?? 'agent';
    const version = sourceKind === 'human' ? item.appVersion : item.helperVersion;
    if (version === released) evidence.push({sourceKind,
      reporterIdentityId:item.reporterIdentityId ?? item.agentId,
      affectedHumanIds:item.affectedHumanIds ?? []});
  }
  return evidence;
}

function reportIsLatest(row) {
  return row.source_kind === 'human' ? row.app_is_latest === true : row.helper_is_latest === true;
}

export function signature(row) {
  // Human descriptions without an error stay separate until a cause is traced.
  const error = normalizeError(row.error_excerpt || row.summary);
  return createHash('sha256').update(JSON.stringify([
    (row.tool_name ?? '').trim().toLowerCase(), error, row.category,
  ])).digest('hex');
}

export function groupFeedback(rows) {
  const groups = new Map();
  for (const row of rows) {
    const createdAt = new Date(row.created_at).toISOString();
    const lastAt = new Date(row.last_occurrence_at || row.created_at).toISOString();
    const key = row.source_kind === 'human' ? `human:${row.id}` : signature(row);
    const group = groups.get(key) ?? { signature: key, itemIds: [], count: 0,
      agentCount: 0, humans: new Set(), firstSeen: createdAt, lastSeen: createdAt,
      versionReports: [] };
    group.itemIds.push(row.id);
    group.versionReports.push(versionReport(row));
    const evidence = latestEvidence(row);
    group.count += evidence.length;
    for (const occurrence of evidence) {
      if (occurrence.sourceKind === 'human') group.humans.add(occurrence.reporterIdentityId);
      else group.agentCount += 1;
      // An agent's owner never establishes that a person experienced the problem.
      for (const id of occurrence.affectedHumanIds) group.humans.add(id);
    }
    group.firstSeen = [group.firstSeen, createdAt].sort()[0];
    group.lastSeen = [group.lastSeen, lastAt].sort().at(-1);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ humans, ...group }) => ({ ...group,
    humanCount: humans.size, eligible: humans.size > 0 || group.count > 1,
  })).sort((a, b) => b.humanCount - a.humanCount || b.agentCount - a.agentCount || a.signature.localeCompare(b.signature));
}

// Silence only proves a fix when the signal was readable for the whole window
// and the fixed path actually ran. `coverageComplete: false` (an unreadable
// source, a log-walk gap) and `exposure: 0` (no traffic on the path) are not
// "fixed"; omitting them keeps the original behavior.
export function followUp({ releasedAt, observedThrough, occurrences, coverageComplete, exposure }) {
  if (!releasedAt) return 'not yet released';
  const release = Date.parse(releasedAt);
  const through = Date.parse(observedThrough);
  if (!Number.isFinite(release) || !Number.isFinite(through)) throw new Error('release and observation timestamps are required');
  if (through <= release) return 'not yet released';
  if (occurrences.some(time => Date.parse(time) > release && Date.parse(time) <= through)) return 'still occurring (reopen)';
  if (coverageComplete === false) return 'incomplete coverage';
  if (through - release < 86_400_000) throw new Error('next-day observation window is incomplete');
  if (exposure === 0) return 'insufficient exposure';
  return 'stopped after release (fixed)';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = JSON.parse(readFileSync(0, 'utf8'));
  const groups = groupFeedback(rows);
  process.stdout.write(JSON.stringify({ before: rows.length, after: groups.length, groups }, null, 2) + '\n');
}
