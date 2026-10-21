// Runs on a hosted runner so an offline release runner cannot hide a failed preflight.
exports.watchRunners = async ({ github, context, core, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 30 }) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      ...context.repo, run_id: context.runId, per_page: 100,
    });
    const probes = jobs.filter(job => job.name.startsWith('Runner probe '));
    if (probes.length === 3 && probes.every(job => job.status === 'completed')) {
      const failed = probes.filter(job => job.conclusion !== 'success');
      if (failed.length) throw new Error(`Release runner probes failed: ${failed.map(job => job.name).join(', ')}`);
      core.info('All release runner labels executed node -v successfully.');
      return;
    }
    if (attempt + 1 < attempts) await wait(10000);
  }
  core.setFailed('Release runner probes did not finish within five minutes. Inspect queued probes for offline/busy labels; inspect running probes for Node setup failures. Cancelling queued work.');
  await github.rest.actions.cancelWorkflowRun({ ...context.repo, run_id: context.runId });
};

exports.triageFailure = async ({ github, context, run = context.payload.workflow_run, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) => {
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
  // Confirm visibility before releasing workflow concurrency: GitHub issue
  // lists can lag creation even with cache-busting headers.
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await listIssues()).some(issue => issue.body?.includes(marker))) return created;
    await wait(2000);
  }
  throw new Error(`Triage issue ${created.data?.number} was created but is not yet visible in listings; inspect it before retrying.`);
};
