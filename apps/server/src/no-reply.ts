const PLACE = String.raw`(?:here|(?:to|in) (?:(?:the|this|a) )?(?:room|corner)(?: or (?:the )?(?:room|corner))?)`;
const NO_REPLY_STATEMENT = new RegExp(String.raw`^(?:NO_REPLY|\[NO_REPLY\]|no[ -]reply(?: needed)?|nothing(?: new)? to (?:post|report|add)|I (?:posted nothing|(?:have not|haven't) posted(?: anything)?|(?:did not|didn't) post(?: anything)?|(?:will not|won't) post(?: anything)?|(?:am not|will not be|won't be) posting(?: anything)?|(?:will|shall) (?:stay|remain) (?:quiet|silent))|I'll (?:stay|remain) (?:quiet|silent)|no (?:room|corner)(?: or (?:room|corner))? (?:post|message|reply)(?: is)? (?:needed|sent|posted))(?: ${PLACE})?$`, 'i');

/** Recognize whole silence declarations, never a sentence inside a real answer. */
export function isNoReplyDeclaration(text: string): boolean {
  const value = text.trim().replace(/’/g, "'");
  if (!value || value.length > 500) return false;
  const statements = value.split(/[.!…]+/).map(part => part.trim()).filter(Boolean);
  return statements.length > 0 && statements.every(statement => NO_REPLY_STATEMENT.test(statement));
}
