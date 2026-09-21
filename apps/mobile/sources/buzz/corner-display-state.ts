import type {
  CornerLifecycleView,
  CornerState,
  CornerStateReason,
} from '@beeline/api-contract/phone';
import { deriveCornerState } from '@beeline/api-contract/phone';
import { cornerStatusLine } from '@/buzz/corner-status-line';
import type { CornerVisualState } from '@/buzz/corners';

export type CornerDisplayState = {
  readonly status: CornerState;
  readonly visual: CornerVisualState;
  readonly needsYou: boolean;
  readonly glyph: string;
  readonly word: CornerState;
  readonly detail?: string;
  readonly prUrl?: string;
  readonly terminal: boolean;
  readonly headerSuffix?: 'failed' | 'checks failed';
  readonly tone: 'brass' | 'quiet' | 'ghost';
};

export type CornerDisplayItem = {
  readonly state: CornerState;
  readonly stateAt?: number;
  readonly reason?: CornerStateReason;
  /** PR/check narration only; never an input to the displayed state. */
  readonly lifecycle: CornerLifecycleView;
};

/**
 * What names a corner is its parent, and the Room header carries that fact on
 * its own: `parentId`. The richer `parent` block is how a reader gets the
 * parent's NAME, so a payload that drops it must still read as a corner.
 */
export function roomViewParentId(view: {
  readonly room: { readonly parentId?: string };
  readonly parent?: { readonly id: string };
}): string | undefined {
  return view.parent?.id ?? view.room.parentId;
}

/** A corner viewing itself: derive state from this Room, never sibling corners. */
export function cornerDisplayFromRoomView(view: {
  readonly room: { readonly archived: boolean };
  readonly latestAgentTurns: readonly { readonly status: string }[];
  readonly cornerLifecycle?: CornerLifecycleView;
}): CornerDisplayItem {
  const derived = deriveCornerState({
    archived: view.room.archived,
    turnRunning: view.latestAgentTurns.some((turn) => turn.status === 'working'),
    lifecycle: view.cornerLifecycle,
  });
  return {
    ...derived,
    lifecycle: view.cornerLifecycle ?? { lifecycle: 'unknown', checks: 'unknown' },
  };
}

export function cornerDisplayState(item: CornerDisplayItem): CornerDisplayState {
  const { state } = item;
  const visual: CornerVisualState =
    state === 'working' ? 'working' : state === 'review' ? 'needs-you' : 'idle';
  const headerSuffix =
    item.reason === 'failed'
      ? 'failed'
      : item.reason === 'checks-failed'
        ? 'checks failed'
        : undefined;
  const detail = cornerStatusLine(item.lifecycle, state === 'archived');
  return {
    status: state,
    visual,
    needsYou: state === 'review' || item.reason === 'question' || item.reason === 'failed',
    glyph: state === 'working' ? '◌' : state === 'review' ? '●' : '○',
    word: state,
    ...(detail ? { detail } : {}),
    ...(item.lifecycle.pr?.url ? { prUrl: item.lifecycle.pr.url } : {}),
    terminal: state === 'archived',
    ...(headerSuffix ? { headerSuffix } : {}),
    tone: state === 'waiting' ? 'brass' : state === 'archived' ? 'ghost' : 'quiet',
  };
}

export function cornerHeaderStateLabel(state: CornerDisplayState): string {
  return state.headerSuffix ? `${state.status} · ${state.headerSuffix}` : state.status;
}

export type CornerHeaderAgentInput = {
  /** The corner's OWN agent: the server projection's `agent`
   * (`corners.created_by`). The transcript-derived identity is only a
   * cold-start fallback the caller may pass when the projection has not
   * landed; the name never swaps to whoever holds a live turn. */
  readonly ownerPubkey?: string;
  readonly status: CornerState;
  readonly headerSuffix?: 'failed' | 'checks failed';
  /** Pubkeys holding a live working receipt in this corner. */
  readonly activeTurnPubkeys: readonly string[];
};

export type CornerHeaderAgent = {
  readonly pubkey?: string;
  /** A reviewer's live turn is still work IN the corner, so the state stays
   * a working state — it reads `reviewing` while the running turn belongs to
   * an agent other than the corner's own. The name never swaps. */
  readonly reviewerTurnRunning: boolean;
  readonly stateWord: string;
  /** The header mark's gold ring is the corner's own agent's aliveness, not
   * the corner's: a reviewer's turn must not light the owner's creature. */
  readonly ownerWorking: boolean;
};

export function cornerHeaderAgent(input: CornerHeaderAgentInput): CornerHeaderAgent {
  const base = input.headerSuffix
    ? `${input.status} · ${input.headerSuffix}`
    : input.status;
  const reviewerTurnRunning =
    input.status === 'working' &&
    input.ownerPubkey !== undefined &&
    input.activeTurnPubkeys.length > 0 &&
    !input.activeTurnPubkeys.includes(input.ownerPubkey);
  return {
    ...(input.ownerPubkey !== undefined ? { pubkey: input.ownerPubkey } : {}),
    reviewerTurnRunning,
    stateWord: reviewerTurnRunning
      ? input.headerSuffix
        ? `reviewing · ${input.headerSuffix}`
        : 'reviewing'
      : base,
    ownerWorking: input.ownerPubkey !== undefined && input.activeTurnPubkeys.includes(input.ownerPubkey),
  };
}

export function cornerDisplayItems<T extends CornerDisplayItem>(
  corners: readonly T[],
): Array<{ readonly item: T; readonly display: CornerDisplayState }> {
  return corners.map((item) => ({ item, display: cornerDisplayState(item) }));
}
