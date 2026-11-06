const PROGRAM_PACKAGES = {
  '@agentclientprotocol/codex-acp': '@openai/codex',
  '@agentclientprotocol/claude-agent-acp': '@anthropic-ai/claude-code',
  'pi-acp': '@earendil-works/pi-coding-agent',
};

/** @public The ACP workflow invokes this through github-script. */
exports.reportAdapterFailures = async ({ github, context, report, programs }) => {
  const failures = report.results.filter(result => result.status === 'failed');
  if (!failures.length) return;
  try {
    await github.rest.issues.getLabel({ ...context.repo, name: 'adapter-compat' });
  } catch (error) {
    if (error.status !== 404) throw error;
    await github.rest.issues.createLabel({ ...context.repo, name: 'adapter-compat', color: 'b60205', description: 'ACP adapter compatibility failures' });
  }
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...context.repo, state: 'open', labels: 'adapter-compat', per_page: 100,
  });
  const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  for (const result of failures) {
    const title = `ACP adapter compatibility: ${result.adapter}@${result.version} failed at ${result.stage}`;
    const program = PROGRAM_PACKAGES[result.adapter];
    const body = `Program: ${program}\nProgram version: ${programs.dependencies[program]?.version || 'unknown'}\nAdapter: ${result.adapter}\nAdapter version: ${result.version}\nFailed stage: ${result.stage}\nRun: ${runUrl}\n\n${result.error || ''}`;
    const existing = issues.find(issue => !issue.pull_request && issue.title === title);
    if (existing) {
      await github.rest.issues.createComment({ ...context.repo, issue_number: existing.number, body });
    } else {
      const created = await github.rest.issues.create({ ...context.repo, title, body, labels: ['adapter-compat'] });
      issues.push(created.data);
    }
  }
};
