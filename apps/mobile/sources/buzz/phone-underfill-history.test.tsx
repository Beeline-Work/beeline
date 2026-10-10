import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RoomHistoryView, RoomViewMessage } from '@beeline/buzz-client';

import { phoneTranscriptUnderfilled, usePhoneUnderfillHistory } from './phone-underfill-history';
import { useRoomMessageStore } from './room-message-store';

const originalConsoleError = console.error;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => vi.restoreAllMocks());

const LIST_HEIGHT = 700;
const THRESHOLD = 50;

const message = (id: string, createdAt: number): RoomViewMessage => ({
  id: id.repeat(64),
  createdAt,
  text: `message-${id}`,
  presentation: 'message',
  author: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Owner' },
});

type Measure = {
  observeListHeight: (height: number) => void;
  observeContentHeight: (height: number) => void;
};

// The phone transcript as the surface wires it: older history only on a
// reader gesture (`onEndReached` behind the drag gate), plus the store's
// screen fill on layout and content size. No drag is ever sent here.
function PhoneTranscript({
  tail,
  history,
  connected = true,
  measureRef,
}: {
  tail: readonly RoomViewMessage[];
  history: (roomId: string, before?: { createdAt: number; id: string }) => Promise<RoomHistoryView>;
  connected?: boolean;
  measureRef: { current: Measure | null };
}) {
  const roomClient = React.useMemo(() => (connected ? { history } : null), [connected, history]);
  const page = useRoomMessageStore({
    roomId: 'room',
    tailMessages: tail,
    roomClient,
    enabled: true,
    initialVisibleCount: 30,
  });
  const rows = [...page.rows, ...tail].slice(-page.visibleMessageCount);
  measureRef.current = usePhoneUnderfillHistory({
    enabled: rows.length > 0 && Boolean(roomClient),
    status: page.fillStatus,
    historyRevision: page.visibleMessageCount,
    threshold: THRESHOLD,
    fill: () => page.fill(rows.length),
  });
  return React.createElement('Transcript', { status: page.status, rows: rows.length });
}

// A heavy PR day: the resident tail folds to one message and one lifecycle
// card, far shorter than the screen.
const TAIL = [message('a', 1), message('b', 2)];

function mount(history: ReturnType<typeof vi.fn>, connected = true) {
  const measureRef: { current: Measure | null } = { current: null };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(PhoneTranscript, { tail: TAIL, history, connected, measureRef }),
    );
  });
  const connect = () =>
    act(() => {
      renderer.update(
        React.createElement(PhoneTranscript, { tail: TAIL, history, connected: true, measureRef }),
      );
    });
  return { renderer, measure: () => measureRef.current!, connect };
}

describe('phoneTranscriptUnderfilled', () => {
  it('is underfilled only once both heights are measured and content fits the list', () => {
    expect(phoneTranscriptUnderfilled({ contentHeight: 0, listHeight: 700, threshold: 50 })).toBe(
      false,
    );
    expect(phoneTranscriptUnderfilled({ contentHeight: 300, listHeight: 0, threshold: 50 })).toBe(
      false,
    );
    expect(phoneTranscriptUnderfilled({ contentHeight: 300, listHeight: 700, threshold: 50 })).toBe(
      true,
    );
    expect(phoneTranscriptUnderfilled({ contentHeight: 750, listHeight: 700, threshold: 50 })).toBe(
      true,
    );
    expect(phoneTranscriptUnderfilled({ contentHeight: 751, listHeight: 700, threshold: 50 })).toBe(
      false,
    );
  });
});

describe('phone transcript shorter than the screen', () => {
  it('requests exactly one older page without a drag when the folded tail underfills the list', async () => {
    const pending: Array<(view: RoomHistoryView) => void> = [];
    const history = vi.fn(() => new Promise<RoomHistoryView>((resolve) => pending.push(resolve)));
    const { renderer, measure } = mount(history);

    act(() => {
      measure().observeListHeight(LIST_HEIGHT);
      measure().observeContentHeight(240);
    });
    // Another content report while the page is in flight must not stack a request.
    act(() => measure().observeContentHeight(240));
    expect(history).toHaveBeenCalledTimes(1);

    // The page arrives and now overfills the list: paging stops.
    await act(async () => {
      pending[0]!({
        messages: [message('c', -3), message('d', -2), message('e', -1)],
        nextBefore: { createdAt: -3, id: 'c'.repeat(64) },
      } as unknown as RoomHistoryView);
    });
    act(() => measure().observeContentHeight(1400));
    expect(history).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('waits for the Room connection, then requests exactly one page', () => {
    const history = vi.fn(() => new Promise<RoomHistoryView>(() => {}));
    // The saved copy shows and measures short before the connection exists.
    const { renderer, measure, connect } = mount(history, false);
    act(() => {
      measure().observeListHeight(LIST_HEIGHT);
      measure().observeContentHeight(240);
    });
    expect(history).not.toHaveBeenCalled();

    // The connection arrives with no new height report: the check runs once.
    connect();
    expect(history).toHaveBeenCalledTimes(1);
    act(() => measure().observeContentHeight(240));
    expect(history).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('requests nothing when the tail already overfills the list on open', () => {
    const history = vi.fn(() => new Promise<RoomHistoryView>(() => {}));
    const { renderer, measure } = mount(history);

    act(() => {
      measure().observeListHeight(LIST_HEIGHT);
      measure().observeContentHeight(2400);
    });
    expect(history).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('stops at the start of the Room instead of looping', async () => {
    const history = vi.fn(
      async () => ({ messages: [], nextBefore: null }) as unknown as RoomHistoryView,
    );
    const { renderer, measure } = mount(history);

    await act(async () => {
      measure().observeListHeight(LIST_HEIGHT);
      measure().observeContentHeight(240);
    });
    await act(async () => measure().observeContentHeight(240));
    expect(history).toHaveBeenCalledTimes(1);
    expect(renderer.toJSON().props.status).toBe('complete');
    renderer.unmount();
  });

  it('keeps loading page after page until the content fills the screen', async () => {
    let page = 0;
    const history = vi.fn(async () => {
      page += 1;
      return {
        messages: [
          message(String.fromCharCode(98 + page * 2), -page * 2),
          message(String.fromCharCode(99 + page * 2), -page * 2 + 1),
        ],
        nextBefore: { createdAt: -page * 2, id: 'x'.repeat(64) },
      } as unknown as RoomHistoryView;
    });
    const { renderer, measure } = mount(history);

    await act(async () => {
      measure().observeListHeight(LIST_HEIGHT);
      measure().observeContentHeight(240);
    });
    // The first page lands: still short, so the next page loads.
    await act(async () => measure().observeContentHeight(480));
    expect(history).toHaveBeenCalledTimes(2);
    // The second page fills the screen: loading stops.
    await act(async () => measure().observeContentHeight(900));
    expect(history).toHaveBeenCalledTimes(2);
    renderer.unmount();
  });

  it('stops on a page that adds no rows instead of looping', async () => {
    const history = vi.fn(
      async () =>
        ({
          messages: [],
          nextBefore: { createdAt: 0, id: 'z'.repeat(64) },
        }) as unknown as RoomHistoryView,
    );
    const { renderer, measure } = mount(history);

    await act(async () => {
      measure().observeListHeight(LIST_HEIGHT);
      measure().observeContentHeight(240);
    });
    await act(async () => measure().observeContentHeight(240));
    await act(async () => measure().observeListHeight(LIST_HEIGHT));
    expect(history).toHaveBeenCalledTimes(1);
    expect(renderer.toJSON().props.status).toBe('idle');
    renderer.unmount();
  });

  it('stops on a failed page instead of looping', async () => {
    const history = vi.fn(async () => {
      throw new Error('offline');
    });
    const { renderer, measure } = mount(history);

    await act(async () => {
      measure().observeListHeight(LIST_HEIGHT);
      measure().observeContentHeight(240);
    });
    await act(async () => measure().observeContentHeight(240));
    expect(history).toHaveBeenCalledTimes(1);
    expect(renderer.toJSON().props.status).toBe('error');
    renderer.unmount();
  });

  it('is wired into the phone FlatList', () => {
    const surface = readFileSync(
      path.join(__dirname, '..', 'app', '(app)', 'beeline', 'chat', '_chat-surface.tsx'),
      'utf8',
    );
    expect(surface).toContain('usePhoneUnderfillHistory({');
    expect(surface).toMatch(/usePhoneUnderfillHistory\(\{\s*enabled:[^}]*Boolean\(roomClient\)/);
    expect(surface).toContain('phoneUnderfill.observeListHeight(event.nativeEvent.layout.height)');
    expect(surface).toContain('phoneUnderfill.observeContentHeight(height)');
  });
});
