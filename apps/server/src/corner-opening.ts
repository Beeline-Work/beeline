/** Opening orders own corner provenance, including after completion or cancellation.
 * Arguments are trusted SQL corner-id expressions; every order probe uses the
 * partial agent_commands_corner_opening index. Phone corners have no order.
 */
export function cornerOpeningSql(cornerId: string): string {
  return `SELECT opening.* FROM agent_commands opening
    WHERE opening.room_id=${cornerId} AND opening.reason='corner_objective'
    ORDER BY opening.created_at,opening.id LIMIT 1`;
}

export function cornerKindSql(cornerId: string): string {
  return `(CASE WHEN EXISTS (${cornerOpeningSql(cornerId)}) THEN 'agent' ELSE 'human' END)`;
}

export function cornerCommissionerSql(cornerId: string): string {
  // An agent-initiated order has no human commissioner. Only a corner without
  // an opening order falls back to its phone creator.
  return `(SELECT CASE WHEN opening.id IS NOT NULL THEN (
      SELECT person.id FROM messages source JOIN identities person
        ON person.id=source.author_id AND person.kind='human'
      WHERE source.id=opening.root_source_message_id
    ) ELSE opening_corner.created_by END
    FROM rooms opening_corner LEFT JOIN LATERAL (${cornerOpeningSql('opening_corner.id')}) opening ON true
    WHERE opening_corner.id=${cornerId} AND opening_corner.parent_id IS NOT NULL)`;
}

export function cornerOpenedFromSql(cornerId: string): string {
  return `(SELECT origin.id FROM (${cornerOpeningSql(cornerId)}) opening
    JOIN rooms origin ON origin.id=CASE WHEN opening.private_payload->>'fromRoomId'
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (opening.private_payload->>'fromRoomId')::uuid END
    WHERE origin.parent_id IS NOT NULL)`;
}

export function cornerRequestSql(cornerId: string): string {
  return `(SELECT opening.turn_request_id FROM (${cornerOpeningSql(cornerId)}) opening)`;
}
