/** Unknown provenance and human-triggered commands never authorize this tool. */
export function nonhumanSilentWake(reason: unknown): boolean {
  return typeof reason === 'string' && [
    'report', 'order', 'watched_corner', 'corner_check', 'corner_review_needed',
    'corner_review_dispatch', 'corner_merge_conflict', 'computer_activity',
  ].includes(reason);
}
