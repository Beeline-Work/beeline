import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTranscriptScrubberStore, SCRUBBER_LINGER_MS } from './use-transcript-scrubber';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const scroll = (y: number, contentHeight = 5_600) => ({
  contentOffset: { y },
  contentSize: { height: contentHeight },
  layoutMeasurement: { height: 600 },
});

describe('transcript scrubber store', () => {
  it('shows the bar while the list scrolls and fades it after the list stops', () => {
    const store = createTranscriptScrubberStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.observeScroll(scroll(1_000));
    expect(store.getSnapshot()).toMatchObject({
      visible: true,
      metrics: { offset: 1_000, contentHeight: 5_600, viewportHeight: 600 },
    });
    vi.advanceTimersByTime(SCRUBBER_LINGER_MS - 1);
    store.observeScroll(scroll(1_200));
    vi.advanceTimersByTime(SCRUBBER_LINGER_MS - 1);
    expect(store.getSnapshot().visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot().visible).toBe(false);
    expect(listener).toHaveBeenCalled();
    store.dispose();
  });

  it('keeps the same snapshot when the oldest day on screen does not change', () => {
    const store = createTranscriptScrubberStore();
    const rows = [{ id: 'a', text: 'a', isUser: false, timestamp: 1_788_000_000 }];
    store.observeVisibleRows(rows);
    const first = store.getSnapshot();
    expect(first.date).not.toBeNull();
    store.observeVisibleRows(rows);
    expect(store.getSnapshot()).toBe(first);
  });

  it('takes a new content height without scrolling or showing the bar', () => {
    const store = createTranscriptScrubberStore();
    store.observeContentSize(8_600);
    expect(store.getSnapshot().metrics).toBeNull();
    store.observeScroll(scroll(5_000));
    vi.advanceTimersByTime(SCRUBBER_LINGER_MS);
    store.observeContentSize(8_600);
    expect(store.getSnapshot()).toMatchObject({
      visible: false,
      metrics: { offset: 5_000, contentHeight: 8_600, viewportHeight: 600 },
    });
    const same = store.getSnapshot();
    store.observeContentSize(8_600);
    expect(store.getSnapshot()).toBe(same);
    store.dispose();
  });
});
