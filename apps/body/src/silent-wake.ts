/** Unknown provenance and human-triggered commands never authorize this tool. */
export function nonhumanSilentWake(reason: unknown): boolean {
  return typeof reason === 'string' && [
    'report', 'order', 'watched_corner', 'corner_check', 'corner_review_needed',
    'corner_review_dispatch', 'corner_merge_conflict', 'computer_activity',
    'schedule', 'subscribed_event', 'system', 'agent_tag', 'corner_objective',
    'corner_land', 'corner_merge_refused', 'corner_merge_unconfirmed',
    'corner_background_tool', 'corner_brief_revision',
  ].includes(reason);
}
