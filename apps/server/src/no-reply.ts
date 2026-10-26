const PLACE = String.raw`(?:here|(?:to|in) (?:(?:the|this|a) )?(?:room|corner)(?: or (?:the )?(?:room|corner))?)`;
const NO_REPLY_STATEMENT = new RegExp(String.raw`^(?:NO_REPLY|\[NO_REPLY\]|no[ -]reply(?: needed)?|nothing(?: new)? to (?:post|report|add)|nonhuman(?: [a-z][a-z-]*)? wake only(?:(?:\s*[-–—:]\s*|\s+)(?:ending|end)(?: up)? (?:silently|quietly))?|(?:ending|end)(?: up)? (?:silently|quietly)|I (?:posted nothing|(?:have not|haven't) posted(?: anything)?|(?:did not|didn't) post(?: anything)?|(?:will not|won't) post(?: anything)?|(?:am not|will not be|won't be) posting(?: anything)?|(?:will|shall) (?:stay|remain) (?:quiet|silent))|I'll (?:stay|remain) (?:quiet|silent)|no (?:room|corner)(?: or (?:room|corner))? (?:post|message|reply)(?: is)? (?:needed|sent|posted))(?: ${PLACE})?$`, 'i');

/** A report-status prefix: how an agent writes to its commander, never how it
 * replies to a person's room. */
export function isReportStatusPrefixed(text: string): boolean {
  return /^(?:done|blocked|failed|needs[-_]decision):\s*\S/i.test(text.trim());
}

/** The whole final text is "Posted … Waiting for …" progress narration about
 * work done somewhere else — internal status, never a transcript answer. */
export function isPostedWaitingNarration(text: string): boolean {
  const value = text.trim();
  if (!value || value.length > 500 || value.includes('?')) return false;
  return /^posted\s+[\s\S]{0,240}?(?:…|\.\s+|\n+|\s—\s|\s-\s)\s*waiting for\s+[\s\S]{0,240}$/i.test(value);
}

/** Recognize whole silence declarations, never a sentence inside a real answer. */
export function isNoReplyDeclaration(text: string): boolean {
  const value = text.trim().replace(/’/g, "'");
  if (!value || value.length > 500) return false;
  const statements = value.split(/[.!…]+/).map(part => part.trim()).filter(Boolean);
  return statements.length > 0 && statements.every(statement =>
    NO_REPLY_STATEMENT.test(statement) || isPostedWaitingNarration(statement));
}
