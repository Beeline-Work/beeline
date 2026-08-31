/**
 * What a NON-corner summary surface should show about a corner's needs-you
 * state, derived ONCE from the same lifecycle verdict the Room index uses —
 * `resolveCornerLifecycle` via `isCornerNeedsYou`. There is no second oracle
 * here: this module consumes a `CornerStatus`, it never re-derives one from
 * raw wire tags.
 *
 * SURFACE SCOPE: this card routes attention FROM a summary surface INTO the
 * corner, so it must never render inside the corner screen itself (there the
 * 'REPLY IN THIS CORNER' affordance is meaningless and the ask is already on
 * the transcript). `[channelId].tsx` consumes only the `review` branch of
 * this derivation; the attention card itself belongs to summary surfaces.
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
import type { MergeTarget } from '@beeline/buzz-client';

/** Structural subset of the server-indexed lifecycle needed by this surface. */
type ReviewLifecycle = {
  lifecycle: 'WORKING' | 'REVIEW' | 'APPROVED' | 'REJECTED' | 'ARCHIVED';
  git?: {
    relation: 'absent' | 'no-deliverable-commits-yet' | 'review' | 'contained';
    repository: string;
    targetBranch: string;
    featureTip?: string;
    artifact?: { patchId?: string };
  };
};

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
   * The newest MEANINGFUL agent-authored line in the corner — usually the ask
   * itself ("main moved on… tell me here if you want this corner brought up
   * to date"). Retry/progress/log noise ('Retrying (attempt 1/3, waiting
   * 2s)…') is never chosen, plain narration without a question or status cue
   * is skipped in favour of the resolver's reason, and the review panel's own
   * not-ready reason is the fallback when no qualifying line exists.
   * `undefined` means neither exists.
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

/** Build the signed merge target only from the server-indexed lifecycle fact. */
export function mergeTargetFromCornerLifecycle(
  lifecycle: ReviewLifecycle | undefined,
): MergeTarget | null {
  const projection = lifecycle?.git;
  if (
    !lifecycle ||
    (lifecycle.lifecycle !== 'REVIEW' && lifecycle.lifecycle !== 'APPROVED') ||
    projection?.relation !== 'review' ||
    !projection.featureTip
  ) {
    return null;
  }
  return {
    repo: projection.repository,
    branch: projection.targetBranch,
    tip: projection.featureTip,
    ...(projection.artifact?.patchId ? { patchId: projection.artifact.patchId } : {}),
  };
}

export type CornerReviewPanelMountState = 'review' | 'nothing-ready' | null;

/**
 * The review panel mounts from durable review truth, never from the corner-list
 * narration. A concluded session may still show the legacy empty state, but a
 * REVIEW/APPROVED merge target wins even while that list reports `waiting`.
 */
export function cornerReviewPanelMountState(input: {
  isCorner: boolean;
  archived: boolean;
  mergeTarget: MergeTarget | null;
  sessionFinished: boolean;
}): CornerReviewPanelMountState {
  if (!input.isCorner || input.archived) return null;
  if (input.mergeTarget) return 'review';
  return input.sessionFinished ? 'nothing-ready' : null;
}

const DETAIL_MAX_CHARS = 240;

/**
 * Progress/retry/log-noise shapes an agent's own stream can carry. A line
 * matching any of these is NEVER the headline — it describes the harness's
 * transport, not what the corner needs from a person.
 */
const PROGRESS_NOISE_PATTERNS: readonly RegExp[] = [
  /\bretry(?:ing|ed)?\b[^\n]*\battempt\s+\d+/i,
  /\battempt\s+\d+\s*(?:\/|of)\s*\d+/i,
  /\bwaiting\s+(?:\d+\s*)?(?:ms|s|sec|secs|seconds|m|min|minutes)\b/i,
  /\bback(?:ing)?[- ]?off\b/i,
  /\bexponential backoff\b/i,
  /^\s*[.·•…]+\s*$/, // bare ellipsis/dot leaders
];

/** Short standalone progress utterances — matched as whole trimmed lines. */
const PROGRESS_NOISE_LINES: readonly string[] = [
  'working…',
  'working...',
  'still working…',
  'still working...',
  'thinking…',
  'thinking...',
  'one moment…',
  'one moment...',
  'hold on…',
  'in progress…',
  'in progress...',
  'processing…',
  'processing...',
  'loading…',
  'loading...',
];

/** True when a line is transport/progress noise rather than a statement. */
export function isProgressNoiseLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (PROGRESS_NOISE_LINES.includes(lower)) return true;
  return PROGRESS_NOISE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Positive cues that an agent line states something a person can act on: a
 * question ("which base should I rebase onto?") or a status-bearing statement
 * ("main moved on since you approved it", "the gate refused the merge").
 */
const STATUS_CUES: readonly RegExp[] = [
  /\bwaiting (?:on|for)\b/i,
  /\btell me\b/i,
  /\blet me know\b/i,
  /\byour call\b/i,
  /\bdo you want\b/i,
  /\bwant me to\b/i,
  /\bshould i\b/i,
  /\bwhich\b/i,
  /\bwhether\b/i,
  /\bneed(?:s|ed)?\b/i,
  /\bapprove/i,
  /\breview\b/i,
  /\bdecision\b/i,
  /\bblocked\b/i,
  /\bconflict\b/i,
  /\bmoved on\b/i,
  /\bstale\b/i,
  /\bfailed\b/i,
  /\brefus(?:ed|al)\b/i,
  /\bcouldn'?t\b/i,
  /\bcannot\b/i,
  /\buncommitted\b/i,
  /\brebase/i,
];

/** True when a non-noise line bears a question or an actionable status. */
function isQuestionOrStatusBearing(text: string): boolean {
  if (text.includes('?')) return true;
  return STATUS_CUES.some((pattern) => pattern.test(text));
}

/** One flattened human-readable line; newlines collapse so the card stays one
 * pointer to the prose, not a second copy of the whole turn. */
function detailLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= DETAIL_MAX_CHARS) return flat;
  return `${flat.slice(0, DETAIL_MAX_CHARS - 1).trimEnd()}…`;
}

/** The newest agent-authored conversational message that MEANINGFULLY states
 * what the corner needs. Drafts (still-streaming bubbles), system notices,
 * activity receipts and merge summaries never speak for the corner; nor does
 * progress/retry/log noise; and among real statements only question-bearing
 * or status-bearing lines qualify — plain narration loses to the resolver's
 * own state reason, which is the honest fallback. Returns `undefined` when no
 * qualifying line exists so callers fall back to that reason. */
export function newestAgentAttentionMessage(
  messages: readonly CornerAttentionMessage[] | undefined,
): CornerAttentionMessage | undefined {
  if (!messages) return undefined;
  let newest: CornerAttentionMessage | undefined;
  for (const message of messages) {
    if (!message.isAgentAuthor || message.isAgentDraft) continue;
    if (message.isSystemNotice || message.isMergeSummary || message.isAgentActivity) continue;
    if (!message.text.trim()) continue;
    if (isProgressNoiseLine(message.text)) continue;
    if (!isQuestionOrStatusBearing(message.text)) continue;
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
  // Unknown verdict, archived corner, or nothing needs-you: keep the empty
  // state exactly as it is.
  if (!input.status || input.archived || !isCornerNeedsYou(input.status)) {
    return { kind: 'nothing-ready' };
  }
  // Content order: meaningful agent statement first; retry spam never; the
  // resolver's own not-ready reason in plain words as the fallback.
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
