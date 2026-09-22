import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { View, Text, StyleSheet } from 'react-native';
// The real decision under test, exactly as the app imports it.
import { shouldFollowDesktopTail } from '../../apps/mobile/sources/buzz/room-scroll-follow';

// Deterministic variable-height rows, like real ledger entries.
const ROW_HEIGHTS = [34, 52, 44, 70, 38, 58, 46, 84, 40, 62, 36, 55, 48, 76, 42, 66];
// Mirrors the production constant in _chat-surface.tsx.
const TAIL_PIN_THRESHOLD = 50;
const NOFIX = new URLSearchParams(location.search).has('nofix');

type Msg = { id: string; h: number };

function makeMessages(count: number): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ id: `m${i}`, h: ROW_HEIGHTS[i % ROW_HEIGHTS.length] });
  }
  return out;
}

function Row({ msg }: { msg: Msg }) {
  return (
    <View
      style={{
        minHeight: msg.h,
        paddingVertical: 6,
        marginBottom: 9,
        borderWidth: 1,
        borderColor: '#3a3a44',
        backgroundColor: '#16161c',
      }}
    >
      <Text
        style={{ color: '#d7d7df', fontSize: 13 }}
      >{`message ${msg.id} · height ${msg.h}`}</Text>
    </View>
  );
}

function HistoryLine() {
  return (
    <View style={{ paddingVertical: 6 }}>
      <Text style={{ color: '#888', fontSize: 11 }}>Beginning of Room</Text>
    </View>
  );
}

function App() {
  const [messages, setMessages] = useState<Msg[]>(
    makeMessages(Number(new URLSearchParams(location.search).get('count') ?? 60)),
  );
  const appendedRef = useRef(false);
  // The real scroll container and content node — a plain scrollable View
  // over real DOM, exactly as the production desktop transcript renders it
  // (apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx).
  const scrollNodeRef = useRef<HTMLElement | null>(null);
  const contentNodeRef = useRef<HTMLElement | null>(null);
  const contentObserverRef = useRef<ResizeObserver | null>(null);
  const isPinnedToTailRef = useRef(true);
  const isUserDraggingRef = useRef(false);
  const hasLandingAnchorRef = useRef(false);
  const prependOldestIdRef = useRef<string | null>(null);
  const prependScrollHeightRef = useRef<number | null>(null);

  const setContentNode = useCallback((node: HTMLElement | null) => {
    contentObserverRef.current?.disconnect();
    contentObserverRef.current = null;
    contentNodeRef.current = node;
    if (!node || typeof ResizeObserver === 'undefined' || NOFIX) return;
    const observer = new ResizeObserver(() => {
      const scrollNode = scrollNodeRef.current;
      if (!scrollNode) return;
      (window as any).__gapLog ??= [];
      (window as any).__gapLog.push(
        Math.round(scrollNode.scrollHeight - scrollNode.scrollTop - scrollNode.clientHeight),
      );
      // Pin state comes from isPinnedToTailRef (real onScroll events only),
      // not a fresh read here: cold open has scrollTop still 0 against the
      // full content, which a fresh read would call "not pinned".
      if (
        shouldFollowDesktopTail({
          isPinnedToTail: isPinnedToTailRef.current,
          isUserDragging: isUserDraggingRef.current,
          hasLandingAnchor: hasLandingAnchorRef.current,
        })
      ) {
        scrollNode.scrollTop = scrollNode.scrollHeight;
      }
    });
    observer.observe(node);
    contentObserverRef.current = observer;
  }, []);
  const setScrollNode = useCallback((node: HTMLElement | null) => {
    scrollNodeRef.current = node;
  }, []);

  // Older history paging in above the reader grows the content from the
  // top — hold the reader's place by the real measured growth, exactly as
  // the production prepend-anchor layout effect does.
  useLayoutEffect(() => {
    const node = scrollNodeRef.current;
    const oldestId = messages[0]?.id ?? null;
    const previousOldestId = prependOldestIdRef.current;
    const previousScrollHeight = prependScrollHeightRef.current;
    if (
      node &&
      oldestId !== null &&
      previousOldestId !== null &&
      oldestId !== previousOldestId &&
      previousScrollHeight !== null
    ) {
      node.scrollTop += node.scrollHeight - previousScrollHeight;
    }
    prependOldestIdRef.current = oldestId;
    prependScrollHeightRef.current = node?.scrollHeight ?? null;
  }, [messages]);

  useEffect(() => {
    const measure = (label: string) => {
      const scroller = document.querySelector(
        '[data-testid="chat-messages"]',
      ) as HTMLElement | null;
      const rows = Array.from(document.querySelectorAll('[data-row]')) as HTMLElement[];
      const rects = rows.map((r) => r.getBoundingClientRect());
      let overlaps = 0;
      for (let i = 1; i < rects.length; i++) {
        if (rects[i].top < rects[i - 1].bottom - 0.5) overlaps++;
      }
      const tailGap = scroller
        ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
        : null;
      const newestRowVisible =
        rects.length > 0 ? rects[rects.length - 1].bottom <= window.innerHeight : null;
      const verdict = {
        label,
        nofix: NOFIX,
        rows: rows.length,
        tailGap: tailGap === null ? null : Math.round(tailGap),
        newestRowVisible,
        overlaps,
        // No budget/cap left in the measured-DOM follow; report whether the
        // reader is still pinned (the only state the follow now tracks).
        budgetLeft: isPinnedToTailRef.current ? 1 : 0,
        scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
        scrollHeight: scroller ? scroller.scrollHeight : null,
        gapLog: (window as any).__gapLog?.slice(-14),
      };
      (window as any).__log ??= [];
      (window as any).__log.push(JSON.stringify(verdict));
      document.getElementById('log').textContent = (window as any).__log.join('\n');
    };

    const raf = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    let cancelled = false;
    (async () => {
      await raf();
      await raf();
      if (cancelled) return;
      measure('cold-open');
      (window as any).__appendOne = () => {
        appendedRef.current = true;
        setMessages((prev) => [
          ...prev,
          { id: `m${prev.length}`, h: ROW_HEIGHTS[prev.length % ROW_HEIGHTS.length] },
        ]);
      };
      // History paging shape: rows prepend, newest id unchanged, so the
      // follow must not re-arm and must not yank the reader back down.
      let prependSeq = 0;
      (window as any).__prependOlder = (n: number) => {
        setMessages((prev) => {
          const older: Msg[] = [];
          for (let i = 0; i < n; i++) {
            prependSeq += 1;
            older.push({
              id: `o${prependSeq}`,
              h: ROW_HEIGHTS[(prependSeq * 5 + 3) % ROW_HEIGHTS.length],
            });
          }
          return [...older, ...prev];
        });
      };
      // The scrollbar-drag / PageUp shape: scrollTop drops with no wheel or
      // touch event ever fired.
      (window as any).__goTop = () => {
        const scroller = document.querySelector(
          '[data-testid="chat-messages"]',
        ) as HTMLElement | null;
        if (scroller) {
          scroller.scrollTop = 0;
          isPinnedToTailRef.current = false;
        }
      };
      (window as any).__measure = measure;
      document.getElementById('status').textContent = 'ready';
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View
      style={{ flex: 1, height: 520, flexDirection: 'column', borderWidth: 2, borderColor: '#555' }}
    >
      <View
        // @ts-expect-error react-native-web forwards onScroll/testID straight to the DOM node.
        testID="chat-messages"
        ref={setScrollNode}
        onScroll={(event: any) => {
          const node = event.currentTarget as HTMLElement;
          isPinnedToTailRef.current =
            node.scrollHeight - node.scrollTop - node.clientHeight <= TAIL_PIN_THRESHOLD;
        }}
        style={[styles.messageList, styles.desktopScroll] as any}
      >
        <View ref={setContentNode as any} style={styles.messageListContent}>
          <HistoryLine />
          {messages.map((item) => (
            // @ts-expect-error dataSet is react-native-web's escape hatch for data-* attrs.
            <View key={item.id} dataSet={{ row: item.id }}>
              <Row msg={item} />
            </View>
          ))}
        </View>
      </View>
      <View style={{ height: 44, borderTopWidth: 1, borderTopColor: '#555' }}>
        <Text style={{ color: '#aaa', padding: 10 }}>composer…</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  messageList: { flex: 1 },
  desktopScroll: { overflowX: 'hidden', overflowY: 'auto' } as any,
  messageListContent: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
});

createRoot(document.getElementById('root')).render(React.createElement(App));
