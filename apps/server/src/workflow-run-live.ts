/** The start card is the indexed live-run authority; transition writers maintain it. */
export function workflowRunLiveSql(card: string): string {
  return `(${card}->>'active'='true')`;
}
