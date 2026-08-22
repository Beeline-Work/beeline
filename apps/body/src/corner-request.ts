/**
 * Agent-initiated edit-corner requests.
 *
 * The shipped pi-acp harness never sends `session/request_permission`: it
 * executes tools before the daemon sees them. A pi-backed Room agent therefore
 * has one text-only compatibility channel for asking the humans for an edit
 * corner: it ends a reply with a single marker line:
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

/**
 * pi-acp-only compatibility control. Permission-capable harnesses must use
 * ACP's real `session/request_permission` path and are never prompted to emit
 * or parsed for this marker.
 */
export const PI_CORNER_REQUEST_INSTRUCTIONS = [
  'This session uses pi-acp, which cannot send a native permission request before a tool runs.',
  'When repository inspection reveals a concrete edit worth making, you may ask the humans for an edit corner.',
  'Briefly explain the proposed change, then end your reply with exactly: CORNER_REQUEST: <one-sentence task objective>',
  'That final line requests approval only. The host removes it from chat and shows humans an allow/deny decision.',
  'Never describe the corner as open, created, or started unless a later host message confirms successful creation.',
  'Do not emit CORNER_REQUEST for information-only follow-up that does not need repository edits.',
];

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

function firstMarkerMatch(text: string): RegExpExecArray | undefined {
  return markerRegex().exec(text) ?? undefined;
}

/**
 * Pull the corner request out of a completed agent reply. Everything from the
 * FIRST marker line onward is treated as request payload rather than prose —
 * the prompt asks for the marker as the final line, so trailing text is part
 * of the request, never something a reader should see.
 */
export function extractCornerRequest(text: string): CornerRequestExtraction {
  const match = firstMarkerMatch(text);
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
  let markerIndex: number | undefined;

  return {
    onChunk(fullText: string): string {
      // Remember the FIRST complete marker as soon as its colon lands, even
      // before the task text does. Otherwise a token boundary immediately
      // after `CORNER_REQUEST:` would flash the control line in the draft.
      markerIndex ??= firstMarkerMatch(fullText)?.index;
      if (markerIndex !== undefined) {
        return fullText.slice(0, markerIndex).trimEnd();
      }
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
      return fullText;
    },
    finalize(fullText: string): CornerRequestExtraction {
      return extractCornerRequest(fullText);
    },
  };
}
