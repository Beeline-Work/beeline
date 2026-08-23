/**
 * THE one corner-lifecycle oracle.
 *
 * Every surface that turns corner-channel history into a status — the Room
 * deck row, the deck's expanded corner rows, the pinned room bar, and the
 * corner screen's own badge/action card — consumes this module's verdict.
 * There is no second derivation anywhere: a per-surface re-derivation is how
 * the deck learned to flip working→gold seconds after open (#360), and how a
 * daemon restart's rebroadcast could re-gold parked corners while their
 * agents were actively working (2026-08-23).
 *
 * Canonical states (wire-proven tokens; product words in parens):
 * - `'live'`            — working: an agent is on it right now
 * - `'open'`            — ready-for-review: an approvable change exists
 * - `'needs-attention'` — needs-decision: waiting on a person
 * - `'failed'`          — failed terminally (recoverable failures carry
 *                         `display-status=needs-attention` instead)
 * - `'merged'` / `'archived'` — terminal
 * - `null`              — idle / nothing reportable (no corner or no fact)
 *
 * Every transition comes from NEW facts only. A status card speaks until a
 * newer fact (work signal or newer card) supersedes it — so a daemon that
 * restates an unchanged verdict must not expect readers to treat the
 * restatement as news, and a reader never has to dedupe by timestamp.
 */

/** The corner-channel event tags that mean the agent is — or most recently
 * was — DOING work here: its own narration (`agent-message` segments), its
 * turn lifecycle (`agent-turn`), and its activity receipts (`agent-activity`).
 * All are signed by the corner's own daemon. These are what RESOLVE a
 * needs-you status card: the moment the corner works again, whatever it was
 * waiting for was consumed by definition. */
export const CORNER_WORK_SIGNAL_TAGS: ReadonlySet<string> = new Set([
  'agent-message',
  'agent-turn',
  'agent-activity',
]);

export type CornerLifecycleFact = {
  createdAt: number;
  /** Raw `display-status`/`status` value, when this event is a status card. */
  rawStatus?: string;
  /** This event announces a change ready for review (`t=merge-ready`). */
  isMergeReady?: boolean;
  /** This event is the agent doing work (`t` ∈ `CORNER_WORK_SIGNAL_TAGS`). */
  isWorkSignal?: boolean;
};

export type CornerLifecycleStatus =
  | 'live'
  | 'needs-attention'
  | 'open'
  | 'failed'
  | 'merged'
  | 'archived';

/** Translate a raw `display-status`/`status` wire tag value into the one
 * canonical status. This is the single place that vocabulary conversion
 * happens — nothing downstream should re-derive status from raw tags. */
export function mapRawCornerStatusTag(raw: string | undefined): CornerLifecycleStatus | undefined {
  switch (raw) {
    case 'starting':
    case 'working':
    case 'open':
    case 'live':
      return 'live';
    case 'needs-attention':
      return 'needs-attention';
    case 'ready':
      return 'open';
    case 'failed':
      return 'failed';
    case 'merged':
      return 'merged';
    case 'archived':
      return 'archived';
    default:
      return undefined;
  }
}

/**
 * Current state from durable history — the rules, in order:
 *
 * 1. `merged`/`archived` are terminal and win outright — work signals never
 *    resurrect a closed corner.
 * 2. Otherwise the newest status card speaks, with a merge-ready counting as
 *    `open` only while nothing newer has spoken (an announcement, not a
 *    standing state).
 * 3. EXCEPT that a resolvable status — `needs-attention`, `open`, or a
 *    recoverable `failed` — stops speaking the moment the newest work signal
 *    is newer than it: the corner is working again, so the honest word is
 *    `live`. Terminal words and plain `live` need no resolution. This rule is
 *    what makes the answer stable under the relay's newest-N backfill window:
 *    a window that still holds the old card resolves it against the newer
 *    work, and a window that evicted the card finds no unresolved word either.
 *
 * No facts at all resolves to `live`: a corner whose history nobody holds is
 * one that was just opened and whose first card is still in flight.
 */
export function resolveCornerLifecycle(
  facts: ReadonlyArray<CornerLifecycleFact>,
  options: { merged?: boolean; archived?: boolean } = {},
): CornerLifecycleStatus {
  if (options.merged) return 'merged';
  if (options.archived) return 'archived';
  let latestStatus: CornerLifecycleFact | undefined;
  let mergeReadyAt: number | undefined;
  let workAt: number | undefined;
  for (const fact of facts) {
    // Only a Mappable status word is a lifecycle card. Session-machinery
    // words (`suspended`, `queued`, `complete`, …) are not lifecycle facts:
    // letting one be the newest "card" erased the standing verdict and read
    // as `live` — a non-fact overriding a fact.
    if (
      fact.rawStatus !== undefined &&
      mapRawCornerStatusTag(fact.rawStatus) !== undefined &&
      (latestStatus === undefined || fact.createdAt >= latestStatus.createdAt)
    ) {
      latestStatus = fact;
    }
    if (fact.isMergeReady) {
      mergeReadyAt = Math.max(mergeReadyAt ?? 0, fact.createdAt);
    }
    if (fact.isWorkSignal) {
      workAt = Math.max(workAt ?? 0, fact.createdAt);
    }
  }
  const mapped = mapRawCornerStatusTag(latestStatus?.rawStatus);
  // A merge-ready may only speak while nothing newer has — same rule the
  // pre-resolver derivation pinned after three real corners stayed `open`
  // forever past a later failure.
  const reviewReady =
    mapped === 'open' ||
    (mergeReadyAt !== undefined &&
      (latestStatus === undefined || mergeReadyAt >= latestStatus.createdAt));
  let status: CornerLifecycleStatus = reviewReady ? 'open' : (mapped ?? 'live');
  // The moment whose word is standing: a status card when one exists, else the
  // merge-ready announcement itself.
  const standingAt = latestStatus?.createdAt ?? (reviewReady ? mergeReadyAt : undefined);
  const supersededByWork =
    standingAt !== undefined &&
    workAt !== undefined &&
    workAt > standingAt &&
    (status === 'needs-attention' || status === 'open' || status === 'failed');
  if (supersededByWork) return 'live';
  return status;
}

/**
 * Build one lifecycle fact from a channel event's raw tags. `createdAt` is
 * the event's `created_at`; the tags are read by the caller (wire shapes
 * differ slightly between Nostr events and projected session events).
 */
export function cornerLifecycleFact(
  createdAt: number,
  tags: { displayStatus?: string; status?: string; t?: string },
): CornerLifecycleFact {
  const t = tags.t ?? '';
  return {
    createdAt,
    ...(tags.displayStatus !== undefined || tags.status !== undefined
      ? { rawStatus: tags.displayStatus ?? tags.status }
      : {}),
    ...(t === 'merge-ready' ? { isMergeReady: true } : {}),
    ...(CORNER_WORK_SIGNAL_TAGS.has(t) ? { isWorkSignal: true } : {}),
  };
}

/** The statuses a person must act on — the set the Room index golds a row for
 * (`needs-you`) and the corner view surfaces as an attention card when no live
 * merge review exists. ONE definition: if those surfaces ever disagreed about
 * what counts as needs-you, the deck would send someone to a corner that
 * shows them nothing to do. */
export const CORNER_NEEDS_YOU_STATUSES: ReadonlySet<CornerLifecycleStatus> = new Set([
  'needs-attention',
  'open',
  'failed',
]);

export function isCornerNeedsYou(status: CornerLifecycleStatus): boolean {
  return CORNER_NEEDS_YOU_STATUSES.has(status);
}

const STATUS_PRECEDENCE: Record<CornerLifecycleStatus, number> = {
  live: 0,
  'needs-attention': 1,
  open: 2,
  failed: 3,
  merged: 4,
  archived: 5,
};

/** Relative terminality of two statuses. */
export function cornerStatusPrecedence(status: CornerLifecycleStatus): number {
  return STATUS_PRECEDENCE[status];
}

/** The most terminal of two reported statuses for ONE corner, or the single
 * defined one. A snapshot fetched before a corner closed must never re-open
 * it, wherever two independent sources (live cards, relay snapshot) meet. */
export function mergeCornerStatuses(
  left: CornerLifecycleStatus | undefined,
  right: CornerLifecycleStatus | undefined,
): CornerLifecycleStatus | undefined {
  if (!left) return right;
  if (!right) return left;
  return STATUS_PRECEDENCE[right] > STATUS_PRECEDENCE[left] ? right : left;
}

/**
 * A corner view's own archived confirmation (`isChannelArchived` / a live
 * archive signal) is fetched independently of, and can resolve after, its
 * last known lifecycle-status snapshot. Once the channel is confirmed
 * archived, never keep displaying a stale non-terminal snapshot — apply the
 * same precedence used to keep a corner's displayed status from walking
 * backwards elsewhere.
 */
export function resolveCornerStatusAgainstArchive(
  known: CornerLifecycleStatus | null,
  confirmedArchived: boolean,
): CornerLifecycleStatus | null {
  if (!confirmedArchived) return known;
  if (!known || cornerStatusPrecedence('archived') >= cornerStatusPrecedence(known)) {
    return 'archived';
  }
  return known;
}
