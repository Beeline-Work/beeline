import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import { cornerStatusLine } from '@/buzz/corner-status-line';
import {
  currentCornerStatus,
  type CornerMachineState,
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
 * Display precedence is terminal, running turn, review, then waiting. This is
 * presentation only: the daemon and GitHub retain their full vocabularies.
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
  readonly status: CornerDisplayStatus;
  /** Compatibility mark vocabulary used by the existing state glyph. */
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
   * The one lowercase state word a row prints beside the name.
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
  /** Header-only explanation for the two retained quiet failure facts. */
  readonly headerSuffix?: 'failed' | 'checks failed';
  /** Existing design token family used by state labels and marks. */
  readonly tone: 'work' | 'brass' | 'quiet' | 'ghost';
};

export type CornerDisplayStatus = 'working' | 'waiting' | 'review' | 'archived';

/** Compact sentence fragment for the corner header's opener + state line. */
export function cornerHeaderStateLabel(state: CornerDisplayState): string {
  return state.headerSuffix ? `${state.status} · ${state.headerSuffix}` : state.status;
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
  const archived =
    facts.archived === true ||
    facts.machineState === 'concluded' ||
    facts.machineState === 'closed' ||
    remoteTerminalState(facts.lifecycle) !== undefined;
  const hasReview = facts.machineReason === 'review' || facts.lifecycle?.pr !== undefined;
  const status: CornerDisplayStatus = archived
    ? 'archived'
    : daemon === 'live'
      ? 'working'
      : hasReview
        ? 'review'
        : 'waiting';
  const visual: CornerVisualState =
    status === 'working' ? 'working' : status === 'review' ? 'needs-you' : 'idle';
  const checks = facts.lifecycle?.checksSummary?.status ?? facts.lifecycle?.checks;
  const headerSuffix =
    status === 'review' && checks === 'failing'
      ? 'checks failed'
      : status === 'waiting' && facts.machineReason === 'failure'
        ? 'failed'
        : undefined;
  const detail = cornerStatusLine(facts.lifecycle, archived);
  return {
    status,
    visual,
    needsYou:
      status === 'review' ||
      facts.awaitingReply === true ||
      facts.machineReason === 'question' ||
      facts.machineReason === 'failure',
    glyph: status === 'working' ? '◌' : status === 'review' ? '●' : '○',
    word: status,
    ...(detail ? { detail } : {}),
    ...(facts.lifecycle?.pr?.url ? { prUrl: facts.lifecycle.pr.url } : {}),
    terminal: status === 'archived',
    ...(headerSuffix ? { headerSuffix } : {}),
    tone:
      status === 'working'
        ? 'work'
        : status === 'review'
          ? 'brass'
          : status === 'archived'
            ? 'ghost'
            : 'quiet',
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
