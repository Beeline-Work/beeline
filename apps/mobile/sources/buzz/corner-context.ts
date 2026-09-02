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
  return cornerObjectiveItems(input).join('\n') || undefined;
}

/** Turns a fixed objective into independently readable items without treating
 * commas, code, or abbreviations as list boundaries. */
export function cornerObjectiveItems(input: {
  planObjective?: string;
  task?: string;
  cornerName?: string;
}): string[] {
  const candidates = [
    input.task,
    input.planObjective,
    input.cornerName ? unslug(input.cornerName) : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const lines = candidate.split('\n');
    const explicitList = lines.some((line) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line));
    const rawItems = explicitList
      ? lines.map((line) => line.trim().replace(/^(?:[-*+] |\d+[.)] )/, '')).filter(Boolean)
      : splitPlainObjective(candidate);
    const items = rawItems
      .map((item) => roomPreviewText(item, Number.POSITIVE_INFINITY))
      .filter(Boolean);
    if (items.length) return items;
  }
  return [];
}

function splitPlainObjective(value: string): string[] {
  const flattened = value.replace(/\s*\n+\s*/g, ' ').trim();
  const parts = flattened
    .split(/\s*;\s*(?:and\s+)?|(?<=[!?])\s+(?=[A-Z])|(?<=[a-z0-9])\.\s+(?=[A-Z])/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : [flattened];
}
