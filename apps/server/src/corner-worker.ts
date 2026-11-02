/**
 * A corner's worker, derived from its commands: the agent of the latest
 * assignment in the corner — the opening order (`corner_objective`) or a
 * person's tag (`human_tag`) — never the corner's reviewer. Agent tags invite
 * conversation and assign nothing. Without an assignment the opener stands.
 * A newly assigned agent simply receives the next wakes; nobody is stopped.
 * All worker-scoped reads use this expression.
 */
export function cornerImplementerSql(factAlias: string, cornerAlias: string): string {
  return `COALESCE((SELECT assignment.agent_id FROM agent_commands assignment
      WHERE assignment.room_id=${cornerAlias}.id AND assignment.reason IN ('corner_objective','human_tag')
        AND assignment.agent_id IS DISTINCT FROM COALESCE(${factAlias}.reviewer_agent_id,
          (SELECT assignment_parent.reviewer_agent_id FROM rooms assignment_parent
           WHERE assignment_parent.id=${cornerAlias}.parent_id))
      ORDER BY assignment.inbox_sequence DESC LIMIT 1),
    ${factAlias}.owner_agent_id,${cornerAlias}.created_by)`;
}
