/**
 * A corner's inherited context: the Room discussion that led to it, and the
 * one-line objective it was opened for.
 *
 * Both answer the same complaint — a corner opened mid-conversation used to
 * start blank, with no trace of the discussion that produced it — and both are
 * deliberately built from *human-authored, already-durable* data:
 *
 *   - the objective is the human's own request with the "open a corner"
 *     scaffolding peeled off, published by the daemon on the corner's
 *     immutable kind:9007 create event (`task` tag);
 *   - the context is the bounded briefing returned by the parent Room endpoint.
 *
 * Neither ever renders raw harness output. That is the lesson of the first
 * objective banner (PR #165), which put a free-text string on a brand-new
 * relay wire and rendered it verbatim in a permanent region at the top of the
 * corner — so the moment anything unfiltered reached that region it stayed
 * there, full width, for the life of the corner. Everything here is filtered
 * through `isMachinePreview`, collapsed to one line, and length-capped, and
 * anything that survives none of that renders nothing at all rather than
 * something raw.
 */
import { roomPreviewText } from '@/buzz/room-list-summary';

/** One line of inherited Room conversation. */
export type RoomContextEntry = {
  id: string;
  text: string;
  timestamp: number;
  pubkey?: string;
  isAgent: boolean;
};

/** A generated corner name (`corner-1a2b3c4d`) names nothing; a task slug does. */
const GENERATED_CORNER_NAME = /^(?:corner|sub)-[0-9a-f]{4,}$/i;

/** `add-color-to-code-blocks` reads as a branch; "add color to code blocks"
 *  reads as an objective. Only a real slug is expanded. */
function unslug(name: string): string | undefined {
  const trimmed = name.trim().replace(/^#+/, '');
  if (!trimmed || GENERATED_CORNER_NAME.test(trimmed)) return undefined;
  if (/\s/.test(trimmed)) return trimmed;
  if (!trimmed.includes('-')) return trimmed;
  return trimmed.replace(/-+/g, ' ').trim() || undefined;
}

/**
 * The corner's objective, as one line.
 *
 * The human's task from the immutable corner create event wins for the life of
 * the corner. A plan objective is only a compatibility fallback for corners
 * opened before the `task` tag shipped; the corner's name is the final fallback.
 * `undefined` means "say nothing" — never a placeholder, and never raw text.
 */
export function cornerObjectiveLine(input: {
  planObjective?: string;
  task?: string;
  cornerName?: string;
}): string | undefined {
  const candidates = [
    input.task,
    input.planObjective,
    input.cornerName ? unslug(input.cornerName) : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    // Keep the complete readable objective. The pinned panel owns visual
    // collapsing, so shortening here would make expansion unable to recover
    // the text the person asked to see.
    const line = roomPreviewText(candidate, Number.POSITIVE_INFINITY);
    if (line) return line;
  }
  return undefined;
}
