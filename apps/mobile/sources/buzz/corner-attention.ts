/**
 * What the corner view's action area (where the merge-review panel lives)
 * should show, derived ONCE from the same lifecycle verdict the Room index
 * uses — `resolveCornerLifecycle` via `isCornerNeedsYou`. There is no second
 * oracle here: this module consumes a `CornerStatus`, it never re-derives one
 * from raw wire tags.
 *
 * The mismatch this closes: the deck golds a row ('Ox · ready for review',
 * 'Codex · decision needed'), but opening the corner showed only the
 * merge-review panel's 'NOTHING READY TO MERGE YET' because there was no live
 * merge card — while the actual ask sat un-highlighted in transcript prose.
 * The person arrives at "needs you" and cannot see WHAT needs them.
 */
import {
  cornerStatusPresentation,
  isCornerNeedsYou,
  type CornerStatus,
} from '@/buzz/corners';

/** The projected transcript shape this derivation reads. A structural subset
 * of `ChatDisplayMessage` so tests need no React Native mocks. */
export type CornerAttentionMessage = {
  text: string;
  timestamp: number;
  isAgentAuthor?: boolean;
  isAgentDraft?: boolean;
  isSystemNotice?: boolean;
  isMergeSummary?: boolean;
  isAgentActivity?: boolean;
};

export type CornerAttentionCard = {
  status: CornerStatus;
  /** From `cornerStatusPresentation` — the one glyph/label source. */
  glyph: string;
  label: string;
  /**
   * The newest agent-authored line in the corner — usually the ask itself
   * ("main moved on… tell me here if you want this corner brought up to
   * date") — falling back to the review panel's own not-ready reason when the
   * transcript holds no readable agent line. `undefined` means neither exists.
   */
  detail?: string;
};

/**
 * Which card the corner's action area renders:
 * - `review`: a live merge-review target exists — the existing approval panel
 *   stays the card, unchanged.
 * - `attention`: the resolver's verdict is needs-you and there is NO live
 *   merge target — say WHAT needs the person instead of an empty placeholder.
 * - `nothing-ready`: the current empty-state panel ('NOTHING READY TO MERGE
 *   YET') — only ever shown when the verdict is NOT needs-you.
 */
export type CornerActionSurface =
  | { kind: 'review' }
  | { kind: 'attention'; card: CornerAttentionCard }
  | { kind: 'nothing-ready' };

const DETAIL_MAX_CHARS = 240;

/** One flattened human-readable line; newlines collapse so the card stays one
 * pointer to the prose, not a second copy of the whole turn. */
function detailLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= DETAIL_MAX_CHARS) return flat;
  return `${flat.slice(0, DETAIL_MAX_CHARS - 1).trimEnd()}…`;
}

/** The newest agent-authored conversational message. Drafts (still-streaming
 * bubbles), system notices, activity receipts and merge summaries never speak
 * for what the corner needs — only the agent's own voice does. */
export function newestAgentAttentionMessage(
  messages: readonly CornerAttentionMessage[] | undefined,
): CornerAttentionMessage | undefined {
  if (!messages) return undefined;
  let newest: CornerAttentionMessage | undefined;
  for (const message of messages) {
    if (!message.isAgentAuthor || message.isAgentDraft) continue;
    if (message.isSystemNotice || message.isMergeSummary || message.isAgentActivity) continue;
    if (!message.text.trim()) continue;
    if (newest === undefined || message.timestamp >= newest.timestamp) newest = message;
  }
  return newest;
}

export function cornerActionSurface(input: {
  /** THE resolved lifecycle verdict (`resolveCornerLifecycleStatus` on this
   * screen — the same word the deck golds). `null` = not yet known. */
  status: CornerStatus | null;
  hasMergeTarget: boolean;
  archived?: boolean;
  messages?: readonly CornerAttentionMessage[];
  /** Why the corner declined to surface a review, when it said so. */
  mergeNotReadyReason?: string | null;
}): CornerActionSurface {
  // A live merge-review target IS the card — requirement 2, unchanged path.
  if (input.hasMergeTarget) return { kind: 'review' };
  // Unknown verdict, archived corner, or nothing needs-you: keep today's
  // empty state exactly as it is (requirement 4).
  if (!input.status || input.archived || !isCornerNeedsYou(input.status)) {
    return { kind: 'nothing-ready' };
  }
  const agent = newestAgentAttentionMessage(input.messages);
  const reason = input.mergeNotReadyReason?.trim();
  const detail = agent ? detailLine(agent.text) : reason ? detailLine(reason) : undefined;
  return {
    kind: 'attention',
    card: {
      status: input.status,
      ...cornerStatusPresentation(input.status),
      ...(detail ? { detail } : {}),
    },
  };
}
