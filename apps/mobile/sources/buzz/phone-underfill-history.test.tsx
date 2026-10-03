import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RoomHistoryView, RoomViewMessage } from '@beeline/buzz-client';

import { phoneTranscriptUnderfilled, usePhoneUnderfillHistory } from './phone-underfill-history';
import { useRoomTranscriptHistory } from './use-room-transcript-history';

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
// reader gesture (`onEndReached` behind the drag gate), plus the underfill
// check on layout and content size. No drag is ever sent here.
function PhoneTranscript({
  tail,
  history,
  measureRef,
}: {
  tail: readonly RoomViewMessage[];
  history: (roomId: string, before?: { createdAt: number; id: string }) => Promise<RoomHistoryView>;
  measureRef: { current: Measure | null };
}) {
  const page = useRoomTranscriptHistory({
    roomId: 'room',
    tailMessages: tail,
    roomClient: { history },
    enabled: true,
    initialVisibleCount: 30,
  });
  const rows = [...page.olderPages.flat(), ...tail].slice(-page.visibleMessageCount);
  measureRef.current = usePhoneUnderfillHistory({
    enabled: rows.length > 0,
    status: page.status,
    historyRevision: page.visibleMessageCount,
    threshold: THRESHOLD,
    loadOlder: () => page.loadOlder(rows.length),
  });
  return React.createElement('Transcript', { status: page.status, rows: rows.length });
}

function mount(history: ReturnType<typeof vi.fn>) {
  const measureRef: { current: Measure | null } = { current: null };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(PhoneTranscript, {
        // A heavy PR day: the resident tail folds to one message and one
        // lifecycle card, far shorter than the screen.
        tail: [message('a', 1), message('b', 2)],
        history,
        measureRef,
      }),
    );
  });
  return { renderer, measure: () => measureRef.current! };
}

describe('phoneTranscriptUnderfilled', () => {
  it('is underfilled only once both heights are measured and content fits the list', () => {
    expect(phoneTranscriptUnderfilled({ contentHeight: 0, listHeight: 700, threshold: 50 })).toBe(false);
    expect(phoneTranscriptUnderfilled({ contentHeight: 300, listHeight: 0, threshold: 50 })).toBe(false);
    expect(phoneTranscriptUnderfilled({ contentHeight: 300, listHeight: 700, threshold: 50 })).toBe(true);
    expect(phoneTranscriptUnderfilled({ contentHeight: 750, listHeight: 700, threshold: 50 })).toBe(true);
    expect(phoneTranscriptUnderfilled({ contentHeight: 751, listHeight: 700, threshold: 50 })).toBe(false);
  });
});

describe('phone transcript shorter than the screen', () => {
  it('requests exactly one older page without a drag when the folded tail underfills the list', async () => {
    const pending: Array<(view: RoomHistoryView) => void> = [];
    const history = vi.fn(
      () => new Promise<RoomHistoryView>((resolve) => pending.push(resolve)),
    );
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
    const history = vi.fn(async () => ({ messages: [], nextBefore: null }) as unknown as RoomHistoryView);
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

  it('is wired into the phone FlatList', () => {
    const surface = readFileSync(
      path.join(__dirname, '..', 'app', '(app)', 'beeline', 'chat', '_chat-surface.tsx'),
      'utf8',
    );
    expect(surface).toContain('usePhoneUnderfillHistory({');
    expect(surface).toContain('phoneUnderfill.observeListHeight(event.nativeEvent.layout.height)');
    expect(surface).toContain('phoneUnderfill.observeContentHeight(height)');
  });
});
