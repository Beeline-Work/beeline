import { execFileSync } from 'node:child_process';
const api = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
const queued = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp',
  'repos/Beeline-Work/beeline/actions/runs?status=queued&per_page=100'], { encoding: 'utf8' }));
const completed = api('repos/Beeline-Work/beeline/actions/workflows/checks.yml/runs?status=success&per_page=30');
const durations = completed.workflow_runs.map(run => (Date.parse(run.updated_at) - Date.parse(run.created_at)) / 1000).sort((a, b) => a - b);
const middle = Math.floor(durations.length / 2);
console.log(JSON.stringify({ measuredAt: new Date().toISOString(),
  queuedRuns: queued.flatMap(page => page.workflow_runs).length,
  queuedChecks: queued.flatMap(page => page.workflow_runs).filter(run => run.name === 'Checks').length,
  successfulChecksSample: durations.length,
  medianWallClockSeconds: durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2,
  runIds: completed.workflow_runs.map(run => run.id),
}, null, 2));
