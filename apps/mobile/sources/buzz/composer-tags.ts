/**
 * Room member tags in the composer.
 *
 * Tags are plain text: a leading `@handle ` run whose handles belong to Room
 * members addresses the message, and the text after it is what the person
 * typed. A send, a draft and a reply carry the exact `@handle ` text the
 * server routes on.
 */

export type ComposerTagSplit = {
  /** Leading tag handles, in text order, without `@`. */
  readonly tags: readonly string[];
  /** The leading tags' text, including its spaces. */
  readonly prefix: string;
  /** Everything after the leading tags: the text the person typed. */
  readonly rest: string;
};

const LEADING_TAG = /^@([^\s@]+) +/;

/** Only current Room members' handles count as composer tags. */
export function roomComposerTagHandles(members: readonly { handle: string }[]): Set<string> {
  return new Set(members.map((member) => member.handle).filter(Boolean));
}

export function splitComposerTags(text: string, handles: ReadonlySet<string>): ComposerTagSplit {
  const tags: string[] = [];
  let offset = 0;
  if (handles.size > 0) {
    for (;;) {
      const match = LEADING_TAG.exec(text.slice(offset));
      if (!match || !handles.has(match[1]!)) break;
      tags.push(match[1]!);
      offset += match[0].length;
    }
  }
  return { tags, prefix: text.slice(0, offset), rest: text.slice(offset) };
}

const MEMBER_TAG_BEFORE_CURSOR = /(?:^|[\s([{])@([\p{L}\p{M}\p{N}_.-]+)$/u;
const HANDLE_WORD_CHARACTER = /^[\p{L}\p{M}\p{N}_]/u;
const HANDLE_CHARACTER = /^[\p{L}\p{M}\p{N}_.-]/u;

/**
 * A backspace with the cursor right after a Room member's `@handle` deletes
 * the whole tag. Returns the text without the tag and the cursor where the tag
 * began, or null when the character before the cursor does not end a member
 * tag, so the backspace removes one character as usual.
 */
export function deleteComposerTagBackward(
  text: string,
  cursor: number,
  handles: ReadonlySet<string>,
): { text: string; cursor: number } | null {
  if (handles.size === 0 || !Number.isInteger(cursor) || cursor <= 0 || cursor > text.length) {
    return null;
  }
  const match = MEMBER_TAG_BEFORE_CURSOR.exec(text.slice(0, cursor));
  const handle = match?.[1];
  if (!handle || !(handles.has(handle) || handles.has(handle.normalize('NFKC').toLocaleLowerCase()))) {
    return null;
  }
  // The cursor must end the handle, as the mention parser reads it: not in
  // the middle of a longer word such as `@rubyx` or `@ruby.dev`.
  const after = text.slice(cursor);
  const punctuation = after.match(/^[.-]+/u)?.[0] ?? '';
  if (HANDLE_WORD_CHARACTER.test(after)) return null;
  if (punctuation && HANDLE_CHARACTER.test(after.slice(punctuation.length))) return null;
  const start = cursor - handle.length - 1;
  return { text: text.slice(0, start) + after, cursor: start };
}

/**
 * The cursor a backspace was pressed at, read from a native text change that
 * removed one character, or null for any other change. iOS and Android report
 * the change before the cursor moves, so `selection` is where the cursor was:
 * a backspace removed the character before it, and a forward delete or a
 * deleted one-character selection removed the one after it. Only when the
 * selection fits neither is the cursor read from the text alone; inside a run
 * of one letter it is then the run's end, the only place a tag can end.
 */
export function composerBackspaceCursor(
  before: string,
  after: string,
  selection: { start: number; end: number },
): number | null {
  if (after.length !== before.length - 1) return null;
  const without = (at: number) => before.slice(0, at) + before.slice(at + 1);
  if (selection.start === selection.end) {
    if (selection.start > 0 && without(selection.start - 1) === after) return selection.start;
    if (without(selection.start) === after) return null;
  } else if (selection.end === selection.start + 1 && without(selection.start) === after) {
    return null;
  }
  let at = 0;
  while (at < after.length && after[at] === before[at]) at += 1;
  return without(at) === after ? at + 1 : null;
}
