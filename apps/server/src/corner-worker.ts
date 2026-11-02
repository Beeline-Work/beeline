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
    ${cornerOwnerSql(`${cornerAlias}.id`)},${cornerAlias}.created_by)`;
}

/**
 * A corner's owner: the agent of its opening order, else (for corners whose
 * commands are gone) the legacy `corner_facts.owner_agent_id`, else the first
 * agent a person tagged in a person-opened corner — never the corner's
 * reviewer. Nothing stores it for new corners; the legacy column is read until
 * it drops. `cornerId` is a SQL expression.
 */
export function cornerOwnerSql(cornerId: string): string {
  const earliest = (reason: string) => `(SELECT opening.agent_id FROM agent_commands opening
      WHERE opening.room_id=${cornerId} AND opening.reason='${reason}'
        AND opening.agent_id IS DISTINCT FROM COALESCE(
          (SELECT opening_fact.reviewer_agent_id FROM corner_facts opening_fact WHERE opening_fact.corner_id=${cornerId}),
          (SELECT opening_parent.reviewer_agent_id FROM rooms opening_corner
           JOIN rooms opening_parent ON opening_parent.id=opening_corner.parent_id WHERE opening_corner.id=${cornerId}))
      ORDER BY opening.inbox_sequence LIMIT 1)`;
  return `COALESCE(${earliest('corner_objective')},
    (SELECT legacy.owner_agent_id FROM corner_facts legacy WHERE legacy.corner_id=${cornerId}),
    ${earliest('human_tag')})`;
}
