#!/usr/bin/env node
/**
 * Weekly: compares Reason Network's per-app adapter files with the commit Beeline copied
 * (apps/body/src/session-join/UPSTREAM.json). When any changed, it opens one GitHub issue titled
 * "Port Reason adapter changes …"; Ruby's repository subscription turns that issue into a port corner.
 *
 *   node scripts/reason-upstream-check.mjs            # print what changed, as JSON
 *   node scripts/reason-upstream-check.mjs --open-issue
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TITLE_PREFIX = 'Port Reason adapter changes';

export function readUpstream(path = resolve(ROOT, 'apps/body/src/session-join/UPSTREAM.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The recorded files that a GitHub compare (recorded commit...upstream head) touched. */
export function upstreamChanges(recorded, compare) {
  const tracked = new Set(recorded.files);
  const files = (compare.files ?? [])
    .filter(file => tracked.has(file.filename) || tracked.has(file.previous_filename))
    .map(file => ({ filename: file.filename, status: file.status, additions: file.additions ?? 0, deletions: file.deletions ?? 0,
      ...(file.previous_filename ? { previous: file.previous_filename } : {}) }));
  const head = compare.commits?.at(-1)?.sha ?? compare.merge_base_commit?.sha ?? null;
  return { changed: files.length > 0, from: recorded.commit, head, files };
}

/** The issue that becomes the port corner's brief. */
export function portIssue(recorded, result) {
  const head = result.head ? result.head.slice(0, 12) : 'upstream';
  const lines = result.files.map(f => `- \`${f.filename}\` ${f.status} (+${f.additions} −${f.deletions})${f.previous ? `, was \`${f.previous}\`` : ''}`);
  return {
    title: `${TITLE_PREFIX} ${recorded.commit.slice(0, 12)}..${head}`,
    body: [
      `Reason Network changed ${result.files.length} of the adapter files Beeline ported.`,
      '',
      ...lines,
      '',
      `Compare: https://github.com/${recorded.repository}/compare/${recorded.commit}...${result.head ?? 'main'}`,
      '',
      '## Port brief',
      '- Port each change that affects detection, delivery or setup into `apps/body/src/session-join/`, keeping the source note and NOTICE.',
      `- Update \`UPSTREAM.json\` to commit \`${result.head ?? '<head>'}\`.`,
      '- Keep the no-Reason-service lint test passing; add or update the unit test for each app touched.',
      '- Re-run SESSION-JOIN-1 for Claude Code or Codex when their files changed.',
    ].join('\n'),
  };
}

async function github(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, { ...init, signal: AbortSignal.timeout(30_000), headers: {
    accept: 'application/vnd.github+json', 'user-agent': 'beeline-reason-upstream-check',
    ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}), ...init.headers } });
  if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const recorded = readUpstream();
  const compare = await github(`/repos/${recorded.repository}/compare/${recorded.commit}...main`);
  const result = upstreamChanges(recorded, compare);
  console.log(JSON.stringify(result, null, 2));
  if (!result.changed || !process.argv.includes('--open-issue')) return;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('GITHUB_REPOSITORY is required to open the port issue');
  const issue = portIssue(recorded, result);
  const open = await github(`/repos/${repository}/issues?state=open&per_page=100`);
  // One open port issue at a time: a newer upstream head waits for the open one to land.
  if (open.some(item => typeof item.title === 'string' && item.title.startsWith(TITLE_PREFIX))) {
    console.log('A port issue is already open.');
    return;
  }
  const created = await github(`/repos/${repository}/issues`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(issue) });
  console.log(`Opened ${created.html_url}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
