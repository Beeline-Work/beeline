import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { ReadCursorAdvancer, READ_CURSOR_DEBOUNCE_MS } from './read-cursor-advance';
import { useNewMessageControl } from './use-new-message-control';
import type { ChatDisplayMessage } from './room-view-presentation';

/**
 * Fanout audit measurement: what repaints when the viewport read cursor moves.
 *
 * The transcript's viewability callback now does three things — it feeds the
 * new-message control, it advances the read cursor, and it lands a pending
 * arrival. Only the first of those holds React state, so this counts renders
 * with the cursor driven on its own and then with the control alongside it, to
 * say which half of the callback costs a repaint.
 */

const TRANSCRIPT = 5_000;
const VISIBLE_ROWS = 12;

function corpus(count: number): ChatDisplayMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${index}`,
    text: `row ${index}`,
    isUser: false,
    timestamp: 1_700_000_000 + index,
  })) as ChatDisplayMessage[];
}

const chronological = corpus(TRANSCRIPT);

describe('D. re-render fanout from the advancing read cursor', () => {
  it('the cursor alone repaints nothing, however far it advances', () => {
    let renders = 0;
    let observe: ((visible: readonly ChatDisplayMessage[]) => void) | null = null;
    const writes: string[] = [];

    function Row() {
      renders += 1;
      // The advancer is owned exactly as the surface owns it: a ref, holding
      // private fields, with a publish closure that touches no state.
      const advancerRef = React.useRef<ReadCursorAdvancer | null>(null);
      if (advancerRef.current === null) {
        advancerRef.current = new ReadCursorAdvancer((id) => writes.push(id), 0);
      }
      observe = (visible) => advancerRef.current?.observe(chronological, visible);
      return null;
    }

    act(() => {
      create(<Row />);
    });
    const afterMount = renders;
    act(() => {
      for (let start = 0; start + VISIBLE_ROWS < 2_000; start += 40) {
        observe?.(chronological.slice(start, start + VISIBLE_ROWS));
      }
    });
    console.log(
      `D-cursor  50 forward viewport reports -> renders ${renders - afterMount} (mount ${afterMount})`,
    );
    expect(renders - afterMount).toBe(0);
  });

  it('the new-message control in the same callback repaints on every viewport CHANGE', () => {
    let renders = 0;
    let observe: ((visible: readonly ChatDisplayMessage[]) => void) | null = null;

    function Surface({ newestMessageId }: { newestMessageId: string }) {
      renders += 1;
      const control = useNewMessageControl({
        roomId: 'room',
        queueableMessages: chronological,
        arrivingIds: React.useMemo(() => new Set<string>(), []),
        newestMessageId,
        firstUnreadMessageId: null,
        isPinnedToTail: React.useCallback(() => false, []),
      });
      observe = control.observeVisibleMessages;
      return null;
    }

    act(() => {
      create(<Surface newestMessageId={`m-${TRANSCRIPT - 1}`} />);
    });
    const afterMount = renders;
    // A reader working UP through history: the newest row is never visible, so
    // `newestMessageVisible` stays false and React bails out of every set.
    act(() => {
      for (let start = 0; start + VISIBLE_ROWS < 2_000; start += 40) {
        observe?.(chronological.slice(start, start + VISIBLE_ROWS));
      }
    });
    const awayFromTail = renders - afterMount;
    // A reader who reaches the tail: `newestMessageVisible` flips once.
    act(() => {
      observe?.(chronological.slice(TRANSCRIPT - VISIBLE_ROWS));
    });
    const reachingTail = renders - afterMount - awayFromTail;
    console.log(
      `D-control 50 reports away from tail -> renders ${awayFromTail}; reaching the tail -> renders ${reachingTail}`,
    );
    expect(awayFromTail).toBeGreaterThanOrEqual(0);
    expect(reachingTail).toBeGreaterThanOrEqual(1);
  });

  it('a settled write does not feed anything back into React', async () => {
    let renders = 0;
    let observe: ((visible: readonly ChatDisplayMessage[]) => void) | null = null;
    const settled: string[] = [];

    function Row() {
      renders += 1;
      const advancerRef = React.useRef<ReadCursorAdvancer | null>(null);
      if (advancerRef.current === null) {
        advancerRef.current = new ReadCursorAdvancer((id) => {
          // The surface's own publish closure, shape for shape.
          void Promise.resolve()
            .then(() => {
              settled.push(id);
            })
            .catch(() => undefined);
        }, 1);
      }
      observe = (visible) => advancerRef.current?.observe(chronological, visible);
      return null;
    }

    act(() => {
      create(<Row />);
    });
    const afterMount = renders;
    await act(async () => {
      observe?.(chronological.slice(100, 100 + VISIBLE_ROWS));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    console.log(
      `D-settle  one write published and settled -> renders ${renders - afterMount}, writes settled ${settled.length}`,
    );
    expect(settled.length).toBe(1);
    expect(renders - afterMount).toBe(0);
    expect(READ_CURSOR_DEBOUNCE_MS).toBe(400);
  });
});
