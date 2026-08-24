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
  /** This event is an agent-authored question/ask awaiting a person —
   * narration (`t=agent-message`) whose text bears a question. The one
   * non-review artifact that can hold a needs-you verdict up. */
  isAsk?: boolean;
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

/** How long an agent's question/ask stays fresh enough to gold a corner.
 * An ask is only an actionable artifact while a person can reasonably still
 * act on it; past this window even the newest-substantive ask reads stale. */
export const CORNER_ASK_FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

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
 * 4. THE VERDICT is exactly one of four super-states (`resolveCornerState`),
 *    with NO sub-reason taxonomy — surfaces choose affordances contextually:
 *    - WORKING — recent agent work within the liveness window
 *      (`CORNER_WORK_LIVENESS_WINDOW_MS`); liveness must be VERIFIABLE, so an
 *      idle corner goes stale out of it.
 *    - NEEDS-HUMAN — everything unfinished that is not verifiably working,
 *      INCLUDING idle-without-finishing (deliberately a failure mode, golded
 *      plainly like every other needs-human state). A fresh unanswered agent
 *      ask also reads needs-human: the person IS what the corner waits on.
 *    - STALLED — same unfinished shapes as NEEDS-HUMAN, but the agent is
 *      PROVABLY offline past its presence lease (the soft `agentOffline`
 *      input): a dead agent cannot be waiting on your reply, and nothing here
 *      is actionable until it comes back — EXCEPT a reviewable change, which
 *      still reads NEEDS-HUMAN because the artifact stands on its own.
 *    - FINISHED — merged/archived.
 *
 * No facts at all resolves to WORKING: a corner whose history nobody holds is
 * one that was just opened and whose first card is still in flight.
 */
export type CornerSuperState = 'working' | 'needs-human' | 'stalled' | 'finished';

/** How long a corner's last agent work signal counts as "working right now".
 * Deliberately generous (a long turn can pause between activity batches) but
 * finite: idle-without-finishing is needs-human, not work. */
export const CORNER_WORK_LIVENESS_WINDOW_MS = 60 * 60 * 1000;

export type CornerVerdict = CornerSuperState;

const NEEDS_HUMAN: CornerVerdict = 'needs-human';

export function resolveCornerState(
  facts: ReadonlyArray<CornerLifecycleFact>,
  options: {
    merged?: boolean;
    archived?: boolean;
    now?: number;
    askFreshWindowMs?: number;
    workLivenessWindowMs?: number;
    /** SOFT presence input: the agent's presence record(s) are provably past
     * their lease (every agent serving this Room offline per
     * `isAgentPresenceOnline`'s lease). Absent/undefined means UNKNOWN and
     * behaves exactly as today — brief blips inside the lease never flip a
     * verdict, only sustained offline does. When true, an ask or standing
     * needs-you card reads `stalled` (agent unreachable), never
     * "waiting on you"; a reviewable change STILL reads needs-human because
     * the artifact does not need a live agent to be actionable. */
    agentOffline?: boolean;
  } = {},
): CornerVerdict {
  if (options.merged || options.archived) return 'finished';
  let latestStatus: CornerLifecycleFact | undefined;
  let mergeReadyAt: number | undefined;
  let workAt: number | undefined;
  let askAt: number | undefined;
  let resolvingWorkAt: number | undefined;
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
      // An ask IS signed as narration (`agent-message`), but it must never
      // count as working-on-it: a corner whose last event is "which base do
      // you want?" is waiting on a person, not working.
      if (!fact.isAsk) {
        resolvingWorkAt = Math.max(resolvingWorkAt ?? 0, fact.createdAt);
      }
    }
    if (fact.isAsk) {
      askAt = Math.max(askAt ?? 0, fact.createdAt);
    }
  }
  const mapped = mapRawCornerStatusTag(latestStatus?.rawStatus);
  // Terminal words win outright — work signals never resurrect a closed
  // corner (rule 1).
  if (mapped === 'merged' || mapped === 'archived') return 'finished';
  // A merge-ready may only speak while nothing newer has — same rule the
  // pre-resolver derivation pinned after three real corners stayed `open`
  // forever past a later failure.
  const reviewReady =
    mapped === 'open' ||
    (mergeReadyAt !== undefined &&
      (latestStatus === undefined || mergeReadyAt >= latestStatus.createdAt));
  const status: CornerLifecycleStatus = reviewReady ? 'open' : (mapped ?? 'live');
  // SOFT presence input, evaluated before anything else can speak: when the
  // agent is PROVABLY offline past its lease, no unfinished state here is a
  // live human-directed wait. The owner-reported defect (2026-08-23): charles/
  // beeline showed NEEDS YOU "Waiting on you" forever because the only thing
  // that clears an ask — newer work — can never come from a dead agent, and
  // never-idle (#389) drives only LIVE agents. A dead agent's ask is not a
  // question aimed at you right now; it is a stalled session. Only a real
  // ARTIFACT survives: a reviewable change still reads needs-human regardless
  // of presence, because approving it does not need the agent awake.
  if (options.agentOffline) {
    return reviewReady ? NEEDS_HUMAN : 'stalled';
  }
  // The moment whose word is standing: a status card when one exists, else the
  // merge-ready announcement itself.
  const standingAt = latestStatus?.createdAt ?? (reviewReady ? mergeReadyAt : undefined);
  // A fresh unanswered agent ask that nothing has superseded IS the wait: the
  // corner needs a person's reply, not a spinner. Evaluated before work
  // recency because the ask must never read as merely "working", and before
  // supersession because it must never clear its own question.
  const newestSubstantive = Math.max(
    latestStatus?.createdAt ?? 0,
    mergeReadyAt ?? 0,
    workAt ?? 0,
  );
  const nowMs = options.now ?? Date.now();
  const freshAsk =
    askAt !== undefined &&
    askAt >= newestSubstantive &&
    nowMs - askAt * 1000 <= (options.askFreshWindowMs ?? CORNER_ASK_FRESH_WINDOW_MS);
  if (freshAsk) return NEEDS_HUMAN;
  // Work recency anchor: non-ask agent activity, plus a live-word card (the
  // daemon announcing work moments ago counts as verifiable liveness too).
  const recentWorkAt = Math.max(
    resolvingWorkAt ?? 0,
    mapped === 'live' ? (latestStatus?.createdAt ?? 0) : 0,
  );
  // "No facts" means no SUBSTANTIVE fact — a channel event carrying no
  // lifecycle information at all (a bare create/control echo) is not evidence
  // of anything, and the just-opened corner stays working.
  const hasSubstantiveFact =
    latestStatus !== undefined ||
    mergeReadyAt !== undefined ||
    resolvingWorkAt !== undefined;
  const verifiablyWorking =
    !hasSubstantiveFact ||
    (recentWorkAt > 0 &&
      nowMs - recentWorkAt * 1000 <=
        (options.workLivenessWindowMs ?? CORNER_WORK_LIVENESS_WINDOW_MS));
  const supersededByWork =
    standingAt !== undefined &&
    resolvingWorkAt !== undefined &&
    resolvingWorkAt > standingAt &&
    (status === 'needs-attention' || status === 'open' || status === 'failed');
  if ((supersededByWork || status === 'live') && verifiablyWorking) return 'working';
  // Everything unfinished that is not verifiably working is needs-human —
  // including plain idle-without-finishing. Surfaces pick the affordance
  // (approve card / reply focus / retry / nudge-close) from their own richer
  // context; the STATE is just the word.
  return NEEDS_HUMAN;
}

/**
 * Legacy seven-word projection of THE three-word verdict, for consumers not
 * yet migrated to `resolveCornerState`. Idle-without-finishing has no old
 * word — it maps to `null`, which mobile's facade re-golds as needs-human via
 * `cornerSuperState`.
 */
export function resolveCornerLifecycle(
  facts: ReadonlyArray<CornerLifecycleFact>,
  options: {
    merged?: boolean;
    archived?: boolean;
    now?: number;
    askFreshWindowMs?: number;
    workLivenessWindowMs?: number;
    /** Same soft presence input as `resolveCornerState`; a STALLED verdict
     * has no legacy word and maps to `null`. */
    agentOffline?: boolean;
  } = {},
): CornerLifecycleStatus | null {
  const verdict = resolveCornerState(facts, options);
  if (verdict === 'working') return 'live';
  if (verdict === 'finished') {
    if (options.merged) return 'merged';
    if (options.archived) return 'archived';
    let terminal: CornerLifecycleStatus | undefined;
    let terminalAt = 0;
    for (const fact of facts) {
      const word = mapRawCornerStatusTag(fact.rawStatus);
      if (
        (word === 'merged' || word === 'archived') &&
        fact.createdAt >= terminalAt
      ) {
        terminal = word;
        terminalAt = fact.createdAt;
      }
    }
    return terminal ?? 'merged';
  }
  // needs-human: preserve the old word where one exists so legacy surfaces
  // keep their affordance routing; idle-without-finishing (stalled) maps to
  // `null` and is re-golded as needs-human by mobile's `cornerSuperState`.
  // The presence-driven STALLED verdict has no legacy word either — it maps
  // to `null` too, carrying its distinct semantics through the summary's
  // `agentOffline` flag rather than inventing a fourth wire word.
  if (verdict === 'stalled') return null;
  let latestWord: CornerLifecycleStatus | undefined;
  let latestWordAt = -1;
  let mergeReadyAt = -1;
  for (const fact of facts) {
    const word = mapRawCornerStatusTag(fact.rawStatus);
    if (word !== undefined && fact.createdAt >= latestWordAt) {
      latestWord = word;
      latestWordAt = fact.createdAt;
    }
    if (fact.isMergeReady) mergeReadyAt = Math.max(mergeReadyAt, fact.createdAt);
  }
  if (mergeReadyAt >= latestWordAt && mergeReadyAt >= 0) return 'open';
  if (
    latestWord === 'open' ||
    latestWord === 'needs-attention' ||
    latestWord === 'failed'
  ) {
    return latestWord;
  }
  return null;
}

/**
 * Build one lifecycle fact from a channel event's raw tags. `createdAt` is
 * the event's `created_at`; the tags are read by the caller (wire shapes
 * differ slightly between Nostr events and projected session events).
 */
export function cornerLifecycleFact(
  createdAt: number,
  tags: { displayStatus?: string; status?: string; t?: string; text?: string },
): CornerLifecycleFact {
  const t = tags.t ?? '';
  return {
    createdAt,
    ...(tags.displayStatus !== undefined || tags.status !== undefined
      ? { rawStatus: tags.displayStatus ?? tags.status }
      : {}),
    ...(t === 'merge-ready' ? { isMergeReady: true } : {}),
    ...(CORNER_WORK_SIGNAL_TAGS.has(t) ? { isWorkSignal: true } : {}),
    ...(isAgentAsk(t, tags.text) ? { isAsk: true } : {}),
  };
}

/** An agent-authored question/ask: narration (`agent-message`) whose text
 * bears a question mark. Progress/retry noise never asks anything — its
 * shapes carry no '?' — so the bare test is sufficient here. */
function isAgentAsk(t: string, text: string | undefined): boolean {
  return t === 'agent-message' && typeof text === 'string' && /\?/.test(text);
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
