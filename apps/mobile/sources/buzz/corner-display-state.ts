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
  readonly needsYou: boolean;
  readonly glyph: string;
  readonly word: CornerState;
  readonly detail?: string;
  readonly prUrl?: string;
  readonly terminal: boolean;
  readonly headerSuffix?: 'failed' | 'checks failed';
  readonly tone: 'work' | 'brass' | 'quiet' | 'ghost';
};

export type CornerDisplayItem = {
  readonly state: CornerState;
  readonly stateAt?: number;
  readonly reason?: CornerStateReason;
  /** PR/check narration only; never an input to the displayed state. */
  readonly lifecycle: CornerLifecycleView;
};

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
    tone:
      state === 'working'
        ? 'work'
        : state === 'review'
          ? 'brass'
          : state === 'archived'
            ? 'ghost'
            : 'quiet',
  };
}

export function cornerHeaderStateLabel(state: CornerDisplayState): string {
  return state.headerSuffix ? `${state.status} · ${state.headerSuffix}` : state.status;
}

export function cornerDisplayItems<T extends CornerDisplayItem>(
  corners: readonly T[],
): Array<{ readonly item: T; readonly display: CornerDisplayState }> {
  return corners.map((item) => ({ item, display: cornerDisplayState(item) }));
}
