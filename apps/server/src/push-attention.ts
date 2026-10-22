import { addressedToPersonSql } from './corner-owed.js';

/** Shared direct-attention policy for enqueue filtering and delivery. */
export function pushDirectAttentionSql(turnIds: string): string {
  return `(
    (room.direct_participants IS NOT NULL AND (m.presentation='message' OR m.card_type IS NULL OR m.card_type='grant-request'))
    OR (m.card_type='machine-offline' AND m.card->>'status'='open'
      AND m.card->>'ownerId'=recipient.id)
    OR ${addressedToPersonSql('m', 'recipient.id', 'recipient.handle', 'recipient.kind', false)}
    OR (author.kind='agent' AND m.presentation='message' AND m.request_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM unnest(${turnIds}) part_ids(id)
        CROSS JOIN LATERAL (SELECT * FROM messages WHERE id=part_ids.id OFFSET 0) part
        WHERE part.room_id=m.room_id AND part.author_id=m.author_id AND part.request_id=m.request_id
          AND part.deleted_at IS NULL
          AND ${addressedToPersonSql('part', 'recipient.id', 'recipient.handle', 'recipient.kind', false)}))
  )`;
}
