/**
 * Recipient chips in the composer.
 *
 * The composer text stays the one source of truth: a chip is a leading
 * `@handle ` token whose handle belongs to a Room member. The composer shows
 * those tokens as chips and the rest as typed text, so a send, a draft and a
 * reply still carry the exact `@handle ` prefix the server routes on.
 */

export type ComposerTagSplit = {
  /** Chip handles, in text order, without `@`. */
  readonly tags: readonly string[];
  /** The leading text the chips stand for, including its spaces. */
  readonly prefix: string;
  /** Everything after the chips: the text the person types. */
  readonly rest: string;
};

const LEADING_TAG = /^@([^\s@]+) +/;

/** Only current Room members' handles can become leading composer chips. */
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

function joinTags(tags: readonly string[], rest: string): string {
  return tags.map((tag) => `@${tag} `).join('') + rest;
}

/** The text without every chip for `handle`; typed text is untouched. */
export function removeComposerTag(
  text: string,
  handles: ReadonlySet<string>,
  handle: string,
): string {
  const split = splitComposerTags(text, handles);
  if (!split.tags.includes(handle)) return text;
  return joinTags(
    split.tags.filter((tag) => tag !== handle),
    split.rest,
  );
}

/** The text without its last chip, for a backspace at the start of the field. */
export function removeLastComposerTag(text: string, handles: ReadonlySet<string>): string {
  const split = splitComposerTags(text, handles);
  if (split.tags.length === 0) return text;
  return joinTags(split.tags.slice(0, -1), split.rest);
}

/** Adds `handle` after the existing chips, or removes it when it is already a chip. */
export function toggleComposerTag(
  text: string,
  handles: ReadonlySet<string>,
  handle: string,
): string {
  const split = splitComposerTags(text, handles);
  if (split.tags.includes(handle)) return removeComposerTag(text, handles, handle);
  return `${split.prefix}@${handle} ${split.rest}`;
}

/** A whole-text selection as offsets into the input, which holds only the text after the chips. */
export function composerFieldSelection(
  text: string,
  handles: ReadonlySet<string>,
  selection: { start: number; end: number },
): { start: number; end: number } {
  const offset = splitComposerTags(text, handles).prefix.length;
  return {
    start: Math.max(0, selection.start - offset),
    end: Math.max(0, selection.end - offset),
  };
}
