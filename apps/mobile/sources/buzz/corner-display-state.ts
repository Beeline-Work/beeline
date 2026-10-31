import type {
  CornerLifecycleView,
  CornerState,
  CornerStateReason,
} from '@beeline/api-contract/phone';
import { cornerStatusLine } from '@/buzz/corner-status-line';
import type { CornerVisualState } from '@/buzz/corners';

export type CornerDisplayState = {
  readonly status: CornerState;
  readonly visual: CornerVisualState;
  readonly glyph: string;
  readonly word: CornerState;
  /** Why a working corner has not started: the order is queued, or the helper is offline. */
  readonly queueNote?: string;
  readonly detail?: string;
  readonly prUrl?: string;
  readonly terminal: boolean;
  readonly headerSuffix?: 'checks failed';
  readonly tone: 'brass' | 'quiet' | 'ghost';
};

export type CornerDisplayItem = {
  readonly state: CornerState;
  readonly queue?: 'queued' | 'offline';
  readonly queueBehind?: string;
  readonly stateAt?: number;
  readonly reason?: CornerStateReason;
  readonly itemId?: string;
  readonly blocker?: import('@beeline/api-contract/phone').CornerBlocker;
  /** PR/check narration; never an input to the displayed state. */
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

/**
 * The one archived rule for a Room or corner screen: only the server's
 * `archived: true` is a fact. The composer, the turn stream and the header
 * all read it.
 */
export function roomIsArchived(room: { readonly archived?: boolean } | undefined): boolean {
  return room?.archived === true;
}

/**
 * A corner's header state is its row in the parent Room's corner record, the
 * same row the Corners screen paints. With no row yet, an archived corner
 * shows archived; anything else shows no state until the row lands.
 */
export function cornerHeaderItem(
  row: CornerDisplayItem | undefined,
  archived: boolean,
): CornerDisplayItem | undefined {
  if (row) return row;
  if (archived)
    return { state: 'archived', lifecycle: { lifecycle: 'unknown', checks: 'unknown' } };
  return undefined;
}

/** The phrase a working corner shows while its order is still unclaimed. */
export function cornerQueueNote(
  queue: 'queued' | 'offline' | undefined,
  behind?: string,
): string | undefined {
  if (queue === 'offline') return 'waiting for the agent to come back';
  if (queue === 'queued' && behind?.trim()) return `queued behind ${behind.trim()}`;
  if (queue === 'queued') return 'queued';
  return undefined;
}

export function cornerDisplayState(item: CornerDisplayItem): CornerDisplayState {
  const { state } = item;
  const queueNote = cornerQueueNote(item.queue, item.queueBehind);
  const visual: CornerVisualState =
    state === 'working' ? 'working' : state === 'review' ? 'needs-you' : state === 'waiting' ? 'waiting' : 'idle';
  const headerSuffix = item.lifecycle.checks === 'failing' || item.lifecycle.checksSummary?.status === 'failing'
    ? 'checks failed' as const : undefined;
  const detail = cornerStatusLine(item.lifecycle, state === 'archived');
  return {
    status: state,
    word: state,
    visual,
    glyph: state === 'working' ? '◌' : state === 'review' ? '●' : state === 'waiting' ? 'Ⅱ' : '○',
    ...(queueNote ? { queueNote } : {}),
    ...(detail ? { detail } : {}),
    ...(item.lifecycle.pr?.url ? { prUrl: item.lifecycle.pr.url } : {}),
    terminal: state === 'archived',
    ...(headerSuffix ? { headerSuffix } : {}),

    tone: state === 'waiting' ? 'brass' : state === 'archived' ? 'ghost' : 'quiet',
  };
}

export type CornerHeaderAgentInput = {
  /** The corner's OWN agent: the server projection's `agent`
   * (`corners.created_by`). The transcript-derived identity is only a
   * cold-start fallback the caller may pass when the projection has not
   * landed; the name never swaps to whoever holds a live turn. */
  readonly ownerPubkey?: string;
  /** Absent until the corner's row lands; the header then shows no state. */
  readonly status?: CornerState;
  readonly headerSuffix?: 'checks failed';
  /** From `cornerDisplayState`: the order is queued, or the helper is offline. */
  readonly queueNote?: string;
  /** Pubkeys holding a live working receipt in this corner. */
  readonly activeTurnPubkeys: readonly string[];
};

export type CornerHeaderAgent = {
  readonly pubkey?: string;
  /** The server's Review state identifies reviewer work. The name never swaps. */
  readonly reviewerTurnRunning: boolean;
  readonly stateWord?: string;
  /** The header mark's gold ring is the corner's own agent's aliveness, not
   * the corner's: a reviewer's turn must not light the owner's creature. */
  readonly ownerWorking: boolean;
};

export function cornerHeaderAgent(input: CornerHeaderAgentInput): CornerHeaderAgent {
  const stateWord = [input.status, input.queueNote, input.headerSuffix].filter(Boolean).join(' · ') || undefined;
  const reviewerTurnRunning = input.status === 'review' && input.activeTurnPubkeys.length > 0;
  return {
    ...(input.ownerPubkey !== undefined ? { pubkey: input.ownerPubkey } : {}),
    reviewerTurnRunning,
    ...(stateWord ? { stateWord } : {}),
    ownerWorking: input.ownerPubkey !== undefined && input.activeTurnPubkeys.includes(input.ownerPubkey),
  };
}

export function cornerDisplayItems<T extends CornerDisplayItem>(
  corners: readonly T[],
): Array<{ readonly item: T; readonly display: CornerDisplayState }> {
  return corners.map((item) => ({ item, display: cornerDisplayState(item) }));
}
