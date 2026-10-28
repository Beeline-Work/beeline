import type { SqlDatabase } from './database.js';

/** A review must actually deliver a decision or actionable findings. */
export const REVIEW_VERDICT_SQL = String.raw`(^|\n)[[:space:]>#*-]*(@[[:alnum:]_-]+[[:space:]]+)?((done|failed|blocked):[[:space:]]*)?(verdict:[[:space:]]*)?(PASS|FAIL)([[:space:]:*]|$)|(^|[[:space:]])F[0-9]+:|\mapproved\M|\mneeds? (a )?fix\M|\mfix (that|the|this)\M|\mbefore I can PASS\M`;

/** Claim only delivery here, not evidence discussed in a PR or requested later. */
function claimsAttachedEvidence(text: string): boolean {
  return text.split(/[.!?\n]+/).some(sentence => {
    if (/\b(?:not|no|never|missing|without|attach|please|should|must|will|need)\b/i.test(sentence)) return false;
    if (/\b(?:(?:in|on|to|from) (?:the )?(?:PR|pull request)|(?:PR|pull request) (?:has|contains|includes))\b/i.test(sentence)) return false;
    if (/\b(?:isn't|aren't|weren't|wasn't)\b/i.test(sentence)) return false;
    return /\b(?:screenshots?|images?|photos?|PNGs?|files?|captures?|attachments?)\b.{0,60}\b(?:are |is |were |have been |has been )?attached\b/i.test(sentence)
      || /\b(?:attached|attaching)\b.{0,60}\b(?:screenshots?|images?|photos?|PNGs?|files?|captures?)\b/i.test(sentence);
  });
}

/** Evidence belongs to the verdict's own turn, never an unrelated older upload. */
export async function missingReviewAttachments(
  db: SqlDatabase,
  cornerId: string,
  head: { headSha: string; number: number },
  reviewerId: string,
): Promise<boolean> {
  const turns = (await db.query<{ id: string; turn_request_id: string; agent_id: string; report_ids: string[] }>(
    `SELECT id,turn_request_id,agent_id,COALESCE(review_context->'reportIds','[]'::jsonb) report_ids FROM agent_commands
     WHERE room_id=$1 AND review_context->>'headSha'=$2
       AND review_context->>'purpose' IS DISTINCT FROM 'verdict'
       AND agent_id=$3 AND review_context->'pullRequest'=$4::jsonb`,
    [cornerId, head.headSha, reviewerId, JSON.stringify(head.number)],
  )).rows;
  for (const turn of turns) {
    const messages = (await db.query<{ text: string; attachments: unknown[] }>(
      `SELECT text,attachments FROM messages WHERE room_id=$1 AND author_id=$2
         AND (request_id=$3 OR id=(SELECT result_message_id FROM agent_commands WHERE id=$4))
         AND deleted_at IS NULL`,
      [cornerId, turn.agent_id, turn.turn_request_id, turn.id],
    )).rows;
    const reports = (await db.query<{ text: string; attachments: unknown[] }>(
      `SELECT text,attachments FROM messages WHERE id=ANY($1::text[]) AND author_id=$2 AND deleted_at IS NULL
       UNION ALL SELECT private_payload->>'text',COALESCE(private_payload->'attachments','[]'::jsonb)
       FROM agent_commands WHERE id=ANY($1::text[]) AND private_payload->>'authorId'=$2`,
      [turn.report_ids, turn.agent_id],
    )).rows;
    const evidence = [...messages, ...reports];
    if (evidence.some(message => claimsAttachedEvidence(message.text)) && !evidence.some(message => message.attachments?.length)) return true;
  }
  return false;
}
