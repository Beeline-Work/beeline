/**
 * A run's status is saved once on its start card, as `runStatus`, whenever it
 * changes. Every live check uses this predicate so it matches the partial
 * index `messages_workflow_run_live_idx`.
 */
export function workflowRunIsLiveSql(card: string): string {
  return `(${card}->>'runStatus'='live')`;
}

/** Start cards whose saved status is missing or still carries the retired `active` flag. */
export function workflowRunStatusUnsavedSql(card: string, id: string): string {
  return `(${id}=${card}->>'runId' AND (${card} ? 'active' OR NOT ${card} ? 'runStatus'))`;
}
