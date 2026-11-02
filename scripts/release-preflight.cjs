// Runs on a hosted runner so an offline release runner cannot hide a failed preflight.
exports.validateRunnerResults = async ({ github, context, core }) => {
  // The workflow dependency is the completion signal. Inspect its result once.
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo, run_id: context.runId, per_page: 100,
  });
  const probes = jobs.filter(job => job.name.startsWith('Runner probe '));
  if (probes.length !== 3 || probes.some(job => job.status !== 'completed'))
    throw new Error('Release runner completion is unavailable; inspect queued/offline labels before proceeding.');
  const failed = probes.filter(job => job.conclusion !== 'success');
  if (failed.length) throw new Error(`Release runner probes failed: ${failed.map(job => job.name).join(', ')}`);
  core.info('All release runner labels executed node -v successfully.');
};

exports.triageFailure = async ({ github, context, run = context.payload.workflow_run }) => {
  if (!['failure', 'cancelled'].includes(run.conclusion)) return;
  if (!['.github/workflows/unified-release.yml', '.github/workflows/release-preflight.yml'].includes(run.path)) return;
  const marker = `<!-- release-failure:${run.id} -->`;
  // Serial workflow concurrency plus an all-state listing prevents duplicates on redelivery or rerun.
  const listIssues = () => github.paginate(github.rest.issues.listForRepo, {
    ...context.repo, state: 'all', per_page: 100,
    ...(run.created_at ? { since: run.created_at } : {}),
    headers: { 'cache-control': 'no-cache' },
    // GitHub may serve a cached issue listing immediately after create.
    cache_bust: `${Date.now()}-${Math.random()}`,
  });
  const issues = await listIssues();
  const existing = issues.filter(issue => !issue.pull_request).sort((a, b) => a.number - b.number).find(issue => issue.body?.includes(marker));
  if (existing) return existing;
  try {
    await github.rest.issues.getLabel({ ...context.repo, name: 'release-failure' });
  } catch (error) {
    if (error.status !== 404) throw error;
    await github.rest.issues.createLabel({ ...context.repo, name: 'release-failure', color: 'b60205', description: 'Failed or cancelled release/preflight runs for daily triage' });
  }
  const created = await github.rest.issues.create({
    ...context.repo,
    title: `${run.name}: ${run.conclusion} (run ${run.id})`,
    labels: ['release-failure'],
    body: `${marker}\n\n${run.html_url}\n\nConclusion: ${run.conclusion}\nSource: ${run.head_sha}\nAttempt: ${run.run_attempt}\n\nInspect failed jobs and queued runner labels. Repair the cause before the next release; this item does not authorize a deployment.`,
  });
  // The mutation response is its receipt. A stale list cannot improve that
  // receipt; ambiguous API failures propagate without a retry or second create.
  return created;
};
