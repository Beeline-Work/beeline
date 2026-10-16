/** Current implementer selected by a person's address in the corner.
 * Agent tags invite conversation and do not change this role.
 * Historical owner_agent_id remains the fallback until a person redirects work.
 * All worker-scoped reads use this expression.
 */
export function cornerImplementerSql(factAlias: string, cornerAlias: string): string {
  return `COALESCE(${factAlias}.worker_agent_id,${factAlias}.owner_agent_id,${cornerAlias}.created_by)`;
}
