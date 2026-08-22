/**
 * Agent-initiated edit-corner requests.
 *
 * A Room agent that has diagnosed concrete work but has no way to act on it
 * (the shipped pi-acp harness never sends `session/request_permission`, and
 * even permission-sending harnesses cannot invoke that channel on demand) can
 * ask the humans for an edit corner by ending a reply with a single marker
 * line:
 *
 *   CORNER_REQUEST: <one-sentence description of the task>
 *
 * The marker is deliberately NOT a slash command: slash vocabulary is what a
 * HUMAN types into the composer (see `markSlashCommandVocabulary`), while this
 * marker is something the AGENT writes into its own reply text, so the two can
 * never collide. The host strips the line from everything it publishes — live
 * drafts, durable narrative segments, and the final message alike — posts an
 * approve/deny card reusing the existing write-permission surface, and opens
 * the corner only after a human ALLOW. The agent never announces the corner:
 * nothing it authored claims the corner exists until the host's own status
 * events say so after creation succeeded.
 */

/** The exact marker token a Room agent writes to request an edit corner. */
export const CORNER_REQUEST_MARKER = 'CORNER_REQUEST:';

/** Upper bound on a requested task; anything longer is truncated. */
export const CORNER_REQUEST_TASK_MAX_CHARS = 500;

export interface AgentCornerRequest {
  task: string;
}

export interface CornerRequestExtraction {
  /** Agent text with any marker line (and everything after it) removed. */
  visibleText: string;
  /** Present only when the text carries a marker with a non-empty task. */
  request?: AgentCornerRequest;
}

function markerRegex(): RegExp {
  // 'm' makes ^ match at every line start; the trailing group takes the rest
  // of the marker line as the requested task.
  return /^CORNER_REQUEST:[ \t]*(.*)$/gm;
}

function lastMarkerMatch(text: string): RegExpExecArray | undefined {
  const regex = markerRegex();
  let last: RegExpExecArray | undefined;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) last = match;
  return last;
}

/**
 * Pull the corner request out of a completed agent reply. Everything from the
 * LAST marker line onward is treated as request payload rather than prose —
 * the prompt asks for the marker as the final line, so trailing text is part
 * of the request, never something a reader should see.
 */
export function extractCornerRequest(text: string): CornerRequestExtraction {
  const match = lastMarkerMatch(text);
  if (!match) return { visibleText: text };
  const visibleText = text.slice(0, match.index).trimEnd();
  const task = (match[1] ?? '').trim().slice(0, CORNER_REQUEST_TASK_MAX_CHARS);
  if (!task) return { visibleText };
  return { visibleText, request: { task } };
}

export interface CornerRequestFilter {
  /**
   * Feed the full accumulated turn text (the same `fullText` the draft
   * streamer and narrative committer already receive). Returns the prefix safe
   * to publish downstream: once a marker line appears, everything from its
   * line start onward is withheld for the rest of the turn.
   */
  onChunk(fullText: string): string;
  /** Final extraction at end-of-turn. */
  finalize(fullText: string): CornerRequestExtraction;
}

/**
 * Streaming-safe filter for a Room turn whose harness may emit a corner
 * request marker mid-reply. Downstream consumers (live draft, narrative
 * committer) must never see the marker or anything after it.
 */
export function createCornerRequestFilter(): CornerRequestFilter {
  let markerSeen = false;
  let task: string | undefined;

  const apply = (fullText: string): CornerRequestExtraction => {
    if (markerSeen) {
      // The marker position is fixed once seen; recompute the cut so the
      // returned prefix stays stable even though callers may pass the same
      // growing text again.
      const match = lastMarkerMatch(fullText);
      const cutAt = match ? match.index : fullText.length;
      return { visibleText: fullText.slice(0, cutAt).trimEnd(), ...(task ? { request: { task } } : {}) };
    }
    return extractCornerRequest(fullText);
  };

  return {
    onChunk(fullText: string): string {
      const extraction = apply(fullText);
      if (extraction.request) {
        markerSeen = true;
        task = extraction.request.task;
        return extraction.visibleText;
      }
      if (markerSeen) return extraction.visibleText;
      // A bare marker line with no task yet is not a request; leave the text
      // alone rather than eating a line the model may still be writing.
      if (!lastMarkerMatch(fullText)) {
        // Withhold a trailing partial marker ("…\nCORNER_REQU") so a half-
        // written marker never flashes in the live draft. Only worth doing
        // while the incomplete tail could still become the marker.
        const lastNewline = fullText.lastIndexOf('\n');
        const tail = fullText.slice(lastNewline + 1);
        if (
          tail.length > 0 &&
          tail.length < CORNER_REQUEST_MARKER.length &&
          CORNER_REQUEST_MARKER.startsWith(tail)
        ) {
          return fullText.slice(0, lastNewline + 1);
        }
      }
      return fullText;
    },
    finalize(fullText: string): CornerRequestExtraction {
      const extraction = extractCornerRequest(fullText);
      if (extraction.request) {
        markerSeen = true;
        task = extraction.request.task;
      }
      return extraction;
    },
  };
}
