// Download the newest usable map, using its embedded commit rather than the
// dispatch workflow's head SHA (a latest promotion can validate an older SHA).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { staleMapReason } from './test-selection.mjs';

export function trustedMapRun(run, { base, head }) {
  if (run.event !== 'workflow_dispatch') return false;
  if (run.path === '.github/workflows/unified-release.yml') return run.head_branch === 'main';
  return run.path === '.github/workflows/checks.yml' && run.conclusion === 'success'
    && [base, head].filter(Boolean).includes(run.head_branch);
}

export async function newestCoverageMap({ artifacts, run, download, usable, base, head }) {
  for (const artifact of [...artifacts].filter(a => !a.expired && a.workflow_run)
    .sort((a, b) => b.id - a.id)) {
    const source = await run(artifact.workflow_run.id);
    if (!trustedMapRun(source, { base, head })) continue;
    const map = await download(artifact);
    if (source.path === '.github/workflows/unified-release.yml'
      && (map.provenance?.kind !== 'release' || String(map.provenance.runId) !== String(source.id)
        || map.provenance.commit !== map.commit)) continue;
    if (usable(map)) return { artifact, map };
  }
  return undefined;
}

async function main() {
  const directory = process.argv[process.argv.indexOf('--out') + 1];
  if (!process.argv.includes('--out') || !directory) throw new Error('Expected --out directory');
  const repository = process.env.GITHUB_REPOSITORY;
  const api = endpoint => JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${endpoint}`], { encoding: 'utf8' }));
  const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  mkdirSync(directory, { recursive: true });
  const output = join(directory, 'server-coverage-map.json');
  const candidate = join(directory, 'candidate');
  rmSync(output, { force: true });
  let selected;
  // Artifact pages are newest first. Scan the next page only if no map on
  // this one is usable; PR artifacts cannot displace release provenance.
  for (let page = 1; !selected; page++) {
    const { artifacts } = api(`actions/artifacts?name=server-coverage-map&per_page=100&page=${page}`);
    selected = await newestCoverageMap({ artifacts,
      base: process.env.GITHUB_BASE_REF, head: process.env.GITHUB_HEAD_REF,
      run: id => api(`actions/runs/${id}`),
      download: artifact => {
        rmSync(join(candidate, 'server-coverage-map.json'), { force: true });
        execFileSync('gh', ['run', 'download', String(artifact.workflow_run.id), '--repo', repository,
          '--name', 'server-coverage-map', '--dir', candidate], { stdio: 'inherit' });
        return JSON.parse(readFileSync(join(candidate, 'server-coverage-map.json'), 'utf8'));
      },
      usable: map => !staleMapReason(map, {
        isAncestor: commit => { try { git(['merge-base', '--is-ancestor', commit, 'HEAD']); return true; } catch { return false; } },
        distance: commit => Number(git(['rev-list', '--count', `${commit}..HEAD`])),
      }),
    });
    if (artifacts.length < 100) break;
  }
  if (selected) {
    writeFileSync(output, JSON.stringify(selected.map));
    console.log(`Coverage map: ${selected.map.commit}, artifact ${selected.artifact.id}`);
  } else {
    rmSync(output, { force: true });
    console.log('No usable coverage map; run every server test.');
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
