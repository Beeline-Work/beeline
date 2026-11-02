/**
 * A corner's worker, derived from its commands: the agent of the latest
 * assignment in the corner — the opening order (`corner_objective`) or a
 * person's tag (`human_tag`) — never the corner's reviewer. Agent tags invite
 * conversation and assign nothing. Without an assignment the opener stands.
 * A newly assigned agent simply receives the next wakes; nobody is stopped.
 * All worker-scoped reads use this expression.
 */
export function cornerImplementerSql(factAlias: string, cornerAlias: string): string {
  // An owner from an assignment is itself an assignment, so the latest one
  // already covers it; only the legacy owner column and the opener remain.
  return `COALESCE((SELECT assignment.agent_id FROM agent_commands assignment
      WHERE assignment.room_id=${cornerAlias}.id AND assignment.reason IN ('corner_objective','human_tag')
        AND assignment.agent_id IS DISTINCT FROM COALESCE(${factAlias}.reviewer_agent_id,
          (SELECT assignment_parent.reviewer_agent_id FROM rooms assignment_parent
           WHERE assignment_parent.id=${cornerAlias}.parent_id))
      ORDER BY assignment.inbox_sequence DESC LIMIT 1),
    ${factAlias}.owner_agent_id,${cornerAlias}.created_by)`;
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
        WHERE opening.room_id=owner_corner.id AND opening.reason='${reason}'
          AND opening.agent_id IS DISTINCT FROM owner_corner.reviewer_id
        ORDER BY opening.inbox_sequence LIMIT 1)`;
  return `(SELECT COALESCE(${earliest('corner_objective')},owner_corner.legacy_owner_id,${earliest('human_tag')})
    FROM (SELECT owner_room.id,owner_fact.owner_agent_id legacy_owner_id,
        COALESCE(owner_fact.reviewer_agent_id,owner_parent.reviewer_agent_id) reviewer_id
      FROM rooms owner_room LEFT JOIN corner_facts owner_fact ON owner_fact.corner_id=owner_room.id
      LEFT JOIN rooms owner_parent ON owner_parent.id=owner_room.parent_id
      WHERE owner_room.id=${cornerId}) owner_corner)`;
}
