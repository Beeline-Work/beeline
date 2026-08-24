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
 *   - the context is the parent Room's own conversational messages, read
 *     back through the same projection the Room transcript uses.
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
import type { ChatDisplayMessage } from '@/sync/transport/buzz-event-projection';
import { roomPreviewText } from '@/buzz/room-list-summary';

/** How much of the Room a corner inherits. Enough to recover the thread that
 *  led here; short enough that the corner still opens on its own work. */
export const ROOM_CONTEXT_LIMIT = 10;

/** One line of inherited Room conversation. */
export type RoomContextEntry = {
  id: string;
  text: string;
  timestamp: number;
  pubkey?: string;
  isAgent: boolean;
};

/** Longest quoted Room line. The block caps each entry at three rendered
 *  lines anyway; this bounds the string before it ever reaches layout. */
const CONTEXT_MAX_CHARS = 240;

/** A generated corner name (`corner-1a2b3c4d`) names nothing; a task slug does. */
const GENERATED_CORNER_NAME = /^(?:corner|sub)-[0-9a-f]{4,}$/i;

/**
 * A Room message a person actually said or an agent actually answered.
 *
 * Everything else on a Room's wire is mechanism — corner status cards, turn
 * lifecycle, activity batches, merge summaries, permission cards, the
 * client-only offline notice — and none of it is the discussion that led to
 * the corner.
 */
function isConversation(message: ChatDisplayMessage): boolean {
  if (message.corner || message.agentTurn || message.writePermission) return false;
  if (message.isAgentActivity || message.isSystemNotice) return false;
  if (message.isMergeSummary || message.isArchivedNotice) return false;
  return Boolean(message.text?.trim());
}

/**
 * The bounded window of Room conversation immediately before a corner opened,
 * oldest first.
 *
 * Takes the *last* `limit` conversational messages rather than the first:
 * a corner is opened at the end of a discussion, so the messages nearest the
 * open-corner command are the ones that explain it.
 */
export function selectRoomContext(
  messages: readonly ChatDisplayMessage[],
  limit: number = ROOM_CONTEXT_LIMIT,
): RoomContextEntry[] {
  if (limit <= 0) return [];
  const entries: RoomContextEntry[] = [];
  for (const message of messages) {
    if (!isConversation(message)) continue;
    // Sanitized the same way a Room-list preview is: markdown flattened, git
    // and CLI plumbing lines dropped, the whole thing collapsed to one
    // readable line. A message that is nothing *but* a pasted push-rejection
    // dump reduces to '' and is not conversation at all.
    const text = roomPreviewText(message.text, CONTEXT_MAX_CHARS);
    if (!text) continue;
    entries.push({
      id: message.id,
      text,
      timestamp: message.timestamp,
      ...(message.pubkey ? { pubkey: message.pubkey } : {}),
      isAgent: Boolean(message.isAgentAuthor),
    });
  }
  return entries
    .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
    .slice(-limit);
}

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
