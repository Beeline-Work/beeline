/** Budget for conversation history, after the rest of the turn has been rendered. */
export function budgetTranscript(
  lines: readonly string[],
  modelContextTokens: number | undefined,
  otherPromptBytes: number,
): string[] {
  const context = modelContextTokens && modelContextTokens > 0 ? modelContextTokens : 32_768;
  // Two UTF-8 bytes per token is deliberately conservative for prose, code,
  // and non-English text. Leave space for tools, prior warm-session turns, and
  // the answer even when the harness does not report its current token usage.
  const reserveTokens = Math.max(4_096, Math.ceil(context * 0.3));
  const available = Math.max(0, context - Math.ceil(otherPromptBytes / 2) - reserveTokens);
  const budget = Math.max(0, Math.min(24_000, Math.floor(context * 0.25), available * 2) - 128);
  if (!budget) return [];

  const selected: string[] = [];
  let used = 0;
  const rowLimit = Math.min(4_096, Math.floor(budget / 2));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const row = boundMessageText(lines[index]!, rowLimit);
    const bytes = Buffer.byteLength(row) + 1;
    if (used + bytes > budget) break;
    selected.push(row);
    used += bytes;
  }
  selected.reverse();
  if (selected.length < lines.length) {
    selected.unshift(`[${lines.length - selected.length} older messages omitted from this prompt]`);
  }
  return selected;
}

/** The initiating Room message is outside history but needs the same one-item guard. */
export function boundRoomTaskBody(body: string, modelContextTokens: number | undefined): string {
  const context = modelContextTokens && modelContextTokens > 0 ? modelContextTokens : 32_768;
  return boundMessageText(body, Math.min(8_000, Math.floor(context / 4)));
}

function boundMessageText(original: string, maxBytes: number): string {
  const sanitized = stripInlineData(original);
  const clean =
    sanitized === original
      ? original
      : sanitized + fetchPointer(original, 'inline content omitted');
  return Buffer.byteLength(clean) > maxBytes ? truncateRow(clean, maxBytes) : clean;
}

/** Media belongs to the attachment fetch path, never to a text transcript. */
export function stripInlineData(text: string): string {
  return text
    .replace(/data:[^\s"'<>)]*/gi, '[inline data omitted]')
    .replace(/\b[A-Za-z0-9+/]{512,}={0,2}\b/g, (candidate) =>
      /[A-Z]/.test(candidate) && /[a-z]/.test(candidate) && /[0-9+/]/.test(candidate)
        ? '[inline binary data omitted]'
        : candidate,
    );
}

function truncateRow(row: string, maxBytes: number): string {
  const pointer = fetchPointer(row, 'message truncated');
  const contentBytes = Math.max(0, maxBytes - Buffer.byteLength(pointer));
  let prefix = Buffer.from(row).subarray(0, contentBytes).toString('utf8');
  // A byte cut may split a UTF-8 character; drop the replacement character.
  prefix = prefix.replace(/\uFFFD$/, '');
  return prefix + pointer;
}

function fetchPointer(row: string, reason: string): string {
  const id = /^\[message id: ([^\]\n]+)\]/.exec(row)?.[1];
  return id
    ? `\n[${reason}; call get_room_message with messageId "${id}" and offset 0 for the full text]`
    : `\n[${reason}; read the source conversation for the full text]`;
}
