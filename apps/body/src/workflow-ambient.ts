import type { DaemonOperationMap } from '@beeline/api-contract/daemon';

type Workflows = DaemonOperationMap['listWorkflows']['output'];
type Runs = DaemonOperationMap['listWorkflowRuns']['output']['runs'];

/** Keep discoverable workflows near the task and active runs near the top. */
export function workflowAmbient(workflows: Workflows, runs: Runs, task: string): string {
  const words = new Set(task.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []);
  const score = (name: string, purpose: string) =>
    [...new Set(`${name} ${purpose}`.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])].filter(
      (word) => words.has(word),
    ).length;
  const visible = [...workflows].sort(
    (left, right) =>
      score(right.name, right.purpose) - score(left.name, left.purpose) ||
      left.name.localeCompare(right.name),
  );
  const lines = [
    ...runs
      .filter((run) => run.status === 'running' || run.status === 'waiting')
      .slice(0, 5)
      .map((run) => `- open run ${run.runId}: ${run.name} at ${run.state} (${run.status})`),
    ...visible
      .slice(0, 8)
      .map(
        (workflow) =>
          `- ${workflow.name} (${workflow.layer} v${workflow.version}): ${(workflow.purpose || 'No purpose stated').slice(0, 80)}; trigger ${workflow.trigger.kind}`,
      ),
  ];
  return lines.length ? `Available workflows and open runs:\n${lines.join('\n')}` : '';
}
