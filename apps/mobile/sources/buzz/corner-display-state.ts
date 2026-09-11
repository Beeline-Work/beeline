import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import { cornerStatusLine } from '@/buzz/corner-status-line';
import {
  cornerGlyphForStatus,
  cornerVisualState,
  currentCornerStatus,
  isCornerTerminal,
  type CornerMachineState,
  type CornerStatus,
  type CornerVisualState,
} from '@/buzz/corners';

/**
 * The three fact families a corner row used to collapse by hand, in one place.
 *
 * Before this module every surface invented its own join. The Room-list
 * dropdown printed `lifecycle.lifecycle` raw ("in-review", "done") and so
 * spoke a different vocabulary from the Room row's own glyph, which reads the
 * daemon state; the corner index mapped that same lifecycle word onto a
 * `CornerStatus` with a second, differently-shaped ternary; and the PR line
 * above a transcript knew about checks but nothing about the daemon. Three
 * collapses meant three answers for one corner.
 *
 * The facts:
 *
 *  - DAEMON — `machineState`/`machineReason`/`stateAt`, the server-indexed
 *    five-state DTO. It owns product lifecycle, exactly as `corners.ts` says.
 *  - PR — `lifecycle.pr`: whether one exists, whether it merged, whether it
 *    conflicts.
 *  - CHECKS — `lifecycle.checks`/`lifecycle.checksSummary`, GitHub's verdict
 *    on the PR head.
 *
 * Precedence is not a tie-break; it is an authority rule. When the daemon has
 * an opinion it wins outright, because it is the only source that knows an
 * agent is mid-turn or has asked a question. PR and checks facts are then
 * narration — they fill `detail`, never `status`. They resolve the status only
 * where the daemon is genuinely silent, which is a different thing from
 * disagreeing with it.
 */
export type CornerDisplayFacts = {
  /** Canonical daemon state; absent means the daemon has never reported. */
  readonly machineState?: CornerMachineState;
  readonly machineReason?: 'review' | 'question' | 'failure';
  /** Lease timestamp for the daemon fact, in unix seconds. */
  readonly stateAt?: number;
  /** Canonical WAITING/question projection carrying its reply affordance. */
  readonly awaitingReply?: boolean;
  /** Daemon-observed git/GitHub facts: branch, PR, checks, outcome. */
  readonly lifecycle?: CornerLifecycleView;
  /** The viewer's surface already knows this corner is closed. */
  readonly archived?: boolean;
};

export type CornerDisplayState = {
  /** The one canonical lifecycle word every surface sorts and filters on. */
  readonly status: CornerStatus | null;
  /** The three-word presentation vocabulary: idle, working, needs-you. */
  readonly visual: CornerVisualState;
  /**
   * A person can act on this corner right now. The single condition a surface
   * is allowed to spend brass on — and never alone: `glyph` and `word` carry
   * the same fact in shape and copy, per the accent rule in DESIGN.md.
   */
  readonly needsYou: boolean;
  /** Shared state-circle glyph (`◌` working, `●` needs-you, `○` idle). */
  readonly glyph: string;
  /**
   * The one short word a row prints beside the name. For a needs-you corner
   * it is the AFFORDANCE — what opening it lets you do — because the state
   * itself is already carried by the glyph and the accent.
   */
  readonly word: string;
  /**
   * The PR/checks sentence (`PR #840 · 6/15 tests passed · running`), or
   * `undefined` before a pull request exists. Narration, never status.
   */
  readonly detail?: string;
  /** The pull request this corner's detail line describes, when one exists. */
  readonly prUrl?: string;
  /** This corner's life is over: it landed or it was closed. */
  readonly terminal: boolean;
};

/**
 * The affordance word per canonical projection. `open` is a review ask, which
 * the Room row's older table folded into REPLY; naming it separately is the
 * point of having one resolver.
 */
const DISPLAY_WORD: Readonly<Record<CornerStatus, string>> = {
  live: 'WORKING',
  open: 'REVIEW',
  'needs-attention': 'REPLY',
  failed: 'RETRY',
  merged: 'MERGED',
  archived: 'CLOSED',
};

/**
 * Whether the daemon has said anything durable about this corner. `working`
 * and `waiting` are opinions even when the working lease has gone stale — a
 * stale lease demotes the corner to idle, it does not hand authority to
 * GitHub. Only `open`, `idle`, and silence leave room for remote facts.
 */
function daemonSpoke(machineState: CornerMachineState | undefined): boolean {
  return (
    machineState === 'working' ||
    machineState === 'waiting' ||
    machineState === 'concluded' ||
    machineState === 'closed'
  );
}

/**
 * Whether remote facts alone say this corner's life is over, and how it ended.
 * `undefined` means GitHub has nothing final to say and the corner is still in
 * flight as far as the branch and its PR are concerned.
 *
 * A merged pull request counts even while `lifecycle` still reads `in-review`:
 * the daemon only writes `done` once the branch is gone, so there is a real
 * window where the PR has landed and the branch has not yet been reaped. The
 * PR line above a transcript has always read that window as merged
 * (`cornerStatusLine`); this makes every other surface agree.
 *
 * Exported because `cornerSummaries` needs the same verdict when it adapts the
 * per-Room corner view onto the index's `CornerSummary` shape. Two encodings of
 * "finished" is exactly how a Room row and its dropdown come to disagree.
 */
export function remoteTerminalState(
  lifecycle: CornerLifecycleView | undefined,
): 'concluded' | 'closed' | undefined {
  if (!lifecycle) return undefined;
  if (lifecycle.pr?.mergedAt || lifecycle.outcome === 'landed') return 'concluded';
  if (lifecycle.outcome === 'abandoned' || lifecycle.lifecycle === 'done') return 'closed';
  return undefined;
}

/**
 * What PR and checks facts alone say a corner is. Only consulted where the
 * daemon is silent, so this can never overturn a live turn or a pending
 * question — it reports the corner GitHub still remembers after the agent that
 * opened it stopped reporting.
 *
 * A failing check or a conflicted PR resolves to `failed` rather than `open`
 * because both are things only a person can clear, and a corner nobody will
 * touch is worse than one that says so.
 */
function remoteCornerStatus(
  lifecycle: CornerLifecycleView | undefined,
  archived: boolean,
): CornerStatus | null {
  if (archived) return 'archived';
  if (!lifecycle) return null;
  const ended = remoteTerminalState(lifecycle);
  if (ended) return ended === 'concluded' ? 'merged' : 'archived';
  if (!lifecycle.pr) return null;
  const checks = lifecycle.checksSummary?.status ?? lifecycle.checks;
  if (checks === 'failing' || lifecycle.pr.mergeability === 'dirty') return 'failed';
  return lifecycle.lifecycle === 'in-review' ? 'open' : null;
}

/** The one collapse. Every corner row on every surface reads this answer. */
export function resolveCornerDisplayState(
  facts: CornerDisplayFacts,
  now = Date.now(),
): CornerDisplayState {
  const daemon = currentCornerStatus(
    {
      status: null,
      ...(facts.machineState ? { machineState: facts.machineState } : {}),
      ...(facts.machineReason ? { machineReason: facts.machineReason } : {}),
      ...(facts.stateAt === undefined ? {} : { stateAt: facts.stateAt }),
    },
    now,
  );
  const archived = facts.archived === true || facts.machineState === 'closed';
  const status =
    daemon ??
    (daemonSpoke(facts.machineState) ? null : remoteCornerStatus(facts.lifecycle, archived));
  const visual = cornerVisualState(status, { awaitingReply: facts.awaitingReply });
  const detail = cornerStatusLine(facts.lifecycle, status === 'archived' || archived);
  return {
    status,
    visual,
    needsYou: visual === 'needs-you',
    glyph: cornerGlyphForStatus(status, { awaitingReply: facts.awaitingReply }),
    // A corner with no canonical status that is nonetheless awaiting a reply
    // reads as the reply it is waiting for, not as the idle it no longer is.
    word: status ? DISPLAY_WORD[status] : visual === 'needs-you' ? 'REPLY' : 'IDLE',
    ...(detail ? { detail } : {}),
    ...(facts.lifecycle?.pr?.url ? { prUrl: facts.lifecycle.pr.url } : {}),
    terminal: isCornerTerminal(status),
  };
}

/**
 * The Room-list dropdown's own shape. It reads the daemon status the parent
 * Room's count was derived from, so the number on a row can never advertise
 * work that expanding hides — the invariant `roomListCorners` states for the
 * index DTO, restated here for the richer per-Room corner view.
 */
export type CornerDisplayItem = {
  readonly status: 'open' | 'working' | 'waiting' | 'idle' | 'concluded' | 'closed';
  readonly statusAt?: number;
  readonly reason?: 'review' | 'question' | 'failure';
  readonly lifecycle: CornerLifecycleView;
};

export function cornerDisplayFacts(item: CornerDisplayItem): CornerDisplayFacts {
  return {
    machineState: item.status,
    ...(item.reason ? { machineReason: item.reason } : {}),
    ...(item.statusAt === undefined ? {} : { stateAt: item.statusAt }),
    lifecycle: item.lifecycle,
  };
}

/**
 * The call every screen makes. Taking the list item whole rather than raw
 * facts is deliberate: a `CornerListItem` spells the daemon state `status`, so
 * handing one straight to `resolveCornerDisplayState` would typecheck and
 * silently resolve every corner as though the daemon had never reported.
 */
export function cornerDisplayState(item: CornerDisplayItem, now = Date.now()): CornerDisplayState {
  return resolveCornerDisplayState(cornerDisplayFacts(item), now);
}

/**
 * Corners the Room-list dropdown lists: everything still unfinished. Terminal
 * corners are excluded outright rather than dimmed — a count that includes
 * rows a person cannot act on turns the index into a to-do list of dead work.
 */
export function unfinishedCornerDisplay<T extends CornerDisplayItem>(
  corners: readonly T[],
  now = Date.now(),
): Array<{ readonly item: T; readonly display: CornerDisplayState }> {
  return corners
    .map((item) => ({ item, display: cornerDisplayState(item, now) }))
    .filter((entry) => !entry.display.terminal);
}
