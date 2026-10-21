#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

// Query failures stop dispatch. GitHub concurrency covers races after this check.
try {
  const output = execFileSync('gh-axi', [
    'api', '--paginate', '--slurp',
    'repos/Beeline-Work/beeline/actions/workflows/unified-release.yml/runs?per_page=100',
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const pages = JSON.parse(output);
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page.workflow_runs))) {
    throw new Error('GitHub returned an invalid release run listing');
  }
  const active = pages.flatMap(page => page.workflow_runs).find(run => run.status !== 'completed');
  if (active) {
    throw new Error(`Production release ${active.id} is already ${active.status}. Wait for it to finish, or cancel it in GitHub Actions before dispatching another release.`);
  }
  execFileSync('gh-axi', ['workflow', 'run', 'unified-release.yml', '--ref', 'main', ...process.argv.slice(2)], { stdio: 'inherit' });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
