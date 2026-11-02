import { CORNER_LIFECYCLE_CARD_TYPE } from './room-choice.js';

/**
 * A corner run's state is its newest handoff card (`corner-lifecycle.ts`);
 * nothing copies it onto the corner row. `cornerId` is a SQL expression.
 */
function newestRunCard(cornerId: string, field: 'toState' | 'outcome'): string {
  return `(SELECT run_card.card->>'${field}' FROM messages run_card
    WHERE run_card.room_id=${cornerId} AND run_card.card_type='${CORNER_LIFECYCLE_CARD_TYPE}'
      AND run_card.card->>'runId'=(${cornerId})::text
    ORDER BY (run_card.card->>'seq')::int DESC LIMIT 1)`;
}

export function cornerRunStateSql(cornerId: string): string {
  return newestRunCard(cornerId, 'toState');
}

export function cornerRunOutcomeSql(cornerId: string): string {
  return newestRunCard(cornerId, 'outcome');
}
