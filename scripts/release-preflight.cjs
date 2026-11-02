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
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo, run_id: run.id, filter: 'latest', per_page: 100,
  });
  const failedJobs = jobs.filter(job => !['success', 'skipped'].includes(job.conclusion)).map(job => job.name);
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
    body: `${marker}\n<!-- release-failed-jobs:${JSON.stringify(failedJobs)} -->\n\n${run.html_url}\n\nConclusion: ${run.conclusion}\nSource: ${run.head_sha}\nAttempt: ${run.run_attempt}\nFailed jobs: ${failedJobs.join(', ') || 'none reported'}\n\nInspect failed jobs and queued runner labels. Repair the cause before the next release; this item does not authorize a deployment.`,
  });
  // The mutation response is its receipt. A stale list cannot improve that
  // receipt; ambiguous API failures propagate without a retry or second create.
  return created;
};

exports.recoverFailures = async ({ github, context, run = context.payload.workflow_run }) => {
  if (run.conclusion !== 'success') return;
  const preflight = run.path === '.github/workflows/release-preflight.yml';
  if (!preflight && run.path !== '.github/workflows/unified-release.yml') return;
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...context.repo, state: 'open', labels: 'release-failure', per_page: 100,
  });
  const jobs = preflight ? [] : await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo, run_id: run.id, filter: 'latest', per_page: 100,
  });
  for (const issue of issues) {
    if (issue.pull_request || issue.state !== 'open' || !(Date.parse(issue.created_at) < Date.parse(run.run_started_at))) continue;
    if (preflight) {
      if (!issue.title.startsWith('Release preflight:')) continue;
    } else {
      // The dispatch attribution is the unified workflow's run name in newer issues.
      if (!issue.title.startsWith('Unified production release:') && !issue.title.startsWith('Production release ·')) continue;
      const record = issue.body?.match(/<!-- release-failed-jobs:(.*?) -->/);
      if (record) {
        const failedJobs = JSON.parse(record[1]);
        if (!failedJobs.length || !failedJobs.every(name => jobs.some(job => job.name === name && job.conclusion === 'success'))) continue;
      } else {
        // Older issues lack job evidence: every delivery job must have run successfully.
        const components = jobs.filter(job => !['initialize', 'release_result', 'release_proof'].includes(job.name));
        if (!components.length || !components.every(job => job.conclusion === 'success')) continue;
      }
    }
    const marker = `<!-- release-recovery:${run.id} -->`;
    const comments = await github.paginate(github.rest.issues.listComments, {
      ...context.repo, issue_number: issue.number, per_page: 100,
    });
    if (!comments.some(comment => comment.body?.includes(marker))) {
      await github.rest.issues.createComment({
        ...context.repo, issue_number: issue.number,
        body: `${marker}\nRecovered by successful ${preflight ? 'Release preflight' : 'Unified production release'}: ${run.html_url}`,
      });
    }
    await github.rest.issues.update({ ...context.repo, issue_number: issue.number, state: 'closed', state_reason: 'completed' });
  }
};
