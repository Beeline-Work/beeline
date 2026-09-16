import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FlatList, View, Text, StyleSheet } from 'react-native';
// The real decision under test, exactly as the app imports it.
import { desktopTailLanding, tailFollowStalled } from '../../apps/mobile/sources/buzz/room-scroll-follow';

// Deterministic variable-height rows, like real ledger entries.
const ROW_HEIGHTS = [34, 52, 44, 70, 38, 58, 46, 84, 40, 62, 36, 55, 48, 76, 42, 66];
// Mirrors of the production constants in [channelId].tsx.
const TAIL_PIN_THRESHOLD = 50;
const DESKTOP_TAIL_LANDING_CAP = 24;
const DESKTOP_TAIL_SETTLE_MS = 1_000;
const DESKTOP_TAIL_POLL_MS = 50;
const DESKTOP_USER_SCROLL_WINDOW_MS = 500;
const DESKTOP_TAIL_STALL_EPS = 1;
const NOFIX = new URLSearchParams(location.search).has('nofix');
// `noguard` reproduces the settle-window shape WITHOUT the reader-motion
// disarm — exactly the code the escape scenario below convicts.
const NOGUARD = new URLSearchParams(location.search).has('noguard');

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
  const listRef = useRef<FlatList<Msg>>(null);
  const logRef = useRef<string[]>([]);
  const appendedRef = useRef(false);
  // The production landing state, mirrored one-for-one.
  const landingsRef = useRef(0);
  const disarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stableSinceRef = useRef<number | null>(null);
  const userScrolledAtRef = useRef(0);
  const offsetRef = useRef(0);
  const viewportRef = useRef(0);
  // Where the follow last held the reader; production clears it on disarm.
  const landedOffsetRef = useRef<number | null>(null);
  // Scroll state left by the previous landing (production stall-test mirror).
  const lastLandRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  // The app's tail follow: decide during render, scroll in a layout effect.
  // Mirrors production exactly: the follow arms on a NEWEST-id change while
  // the reader is pinned, never on an unrelated data change (history paging
  // prepends rows without touching the newest id).
  const newestId = messages.at(-1)?.id ?? null;
  const previousNewestRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const previous = previousNewestRef.current;
    previousNewestRef.current = newestId;
    if (newestId === null || previous === null || newestId === previous) return;
    if (!appendedRef.current) return;
    landingsRef.current = NOFIX ? 0 : DESKTOP_TAIL_LANDING_CAP;
    stableSinceRef.current = null;
    const armNode = listRef.current?.getScrollableNode() as HTMLElement | null | undefined;
    landedOffsetRef.current = armNode ? armNode.scrollTop : offsetRef.current;
    if (disarmTimerRef.current !== null) clearTimeout(disarmTimerRef.current);
    listRef.current?.scrollToEnd({ animated: false });
  }, [newestId]);

  useEffect(() => {
    // Mirrors the production web drag guard: the scroll node's own wheel and
    // touchmove events, since React Native Web never fires the drag props.
    const scrollNode = listRef.current?.getScrollableNode() as HTMLElement | null | undefined;
    if (!scrollNode?.addEventListener || !scrollNode.removeEventListener) return;
    const disarmDesktopTailFollow = () => {
      userScrolledAtRef.current = Date.now();
      landingsRef.current = 0;
      stableSinceRef.current = null;
      landedOffsetRef.current = null;
      if (disarmTimerRef.current !== null) clearTimeout(disarmTimerRef.current);
      disarmTimerRef.current = null;
    };
    scrollNode.addEventListener('wheel', disarmDesktopTailFollow, { passive: true });
    scrollNode.addEventListener('touchmove', disarmDesktopTailFollow, { passive: true });
    return () => {
      scrollNode.removeEventListener('wheel', disarmDesktopTailFollow);
      scrollNode.removeEventListener('touchmove', disarmDesktopTailFollow);
    };
  }, []);

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
        budgetLeft: landingsRef.current,
        scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
        scrollHeight: scroller ? scroller.scrollHeight : null,
        gapLog: (window as any).__gapLog?.slice(-14),
      };
      logRef.current.push(JSON.stringify(verdict));
      document.getElementById('log').textContent = logRef.current.join('\n');
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
        if (scroller) scroller.scrollTop = 0;
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
      <FlatList
        testID="chat-messages"
        ref={listRef}
        inverted={false}
        data={messages}
        keyExtractor={(item: Msg) => item.id}
        style={styles.messageList}
        contentContainerStyle={[styles.messageListContent, styles.messageListContentDesktop]}
        scrollEventThrottle={100}
        onScroll={(e: any) => {
          const { contentOffset, layoutMeasurement } = e.nativeEvent;
          offsetRef.current = contentOffset.y;
          viewportRef.current = layoutMeasurement.height;
        }}
        onContentSizeChange={(_w: number, h: number) => {
          if (NOFIX) return;
          (window as any).__gapLog ??= [];
          if (disarmTimerRef.current !== null) clearTimeout(disarmTimerRef.current);
          disarmTimerRef.current = null;
          stableSinceRef.current = null;
          // Mirrors the desktop branch of [channelId].tsx onContentSizeChange.
          const scrollNode = listRef.current?.getScrollableNode() as HTMLElement | null | undefined;
          const tailGap = scrollNode
            ? scrollNode.scrollHeight - scrollNode.clientHeight - scrollNode.scrollTop
            : h - viewportRef.current - offsetRef.current;
          (window as any).__gapLog.push(Math.round(tailGap));
          const landing = desktopTailLanding({
            tailGapAboveThreshold: tailGap > TAIL_PIN_THRESHOLD,
            tailStable: false,
            isUserScrolling:
              userScrolledAtRef.current > 0 &&
              Date.now() - userScrolledAtRef.current < DESKTOP_USER_SCROLL_WINDOW_MS,
            readerMovedUp:
              !NOGUARD &&
              landedOffsetRef.current !== null &&
              scrollNode != null &&
              scrollNode.scrollTop < landedOffsetRef.current - 1,
            landingsRemaining: landingsRef.current,
          });
          landingsRef.current = landing.disarm
            ? 0
            : landing.land
              ? tailFollowStalled(
                  lastLandRef.current,
                  scrollNode
                    ? { scrollHeight: scrollNode.scrollHeight, scrollTop: scrollNode.scrollTop }
                    : null,
                  DESKTOP_TAIL_STALL_EPS,
                )
                ? Math.max(0, landingsRef.current - 1)
                : Math.min(DESKTOP_TAIL_LANDING_CAP, landingsRef.current + 1)
              : landingsRef.current;
          if (landing.disarm) {
            landedOffsetRef.current = null;
            lastLandRef.current = null;
          }
          if (landing.land) {
            listRef.current?.scrollToOffset({
              offset: scrollNode?.scrollHeight ?? h,
              animated: false,
            });
            if (scrollNode) {
              landedOffsetRef.current = scrollNode.scrollHeight - scrollNode.clientHeight;
              lastLandRef.current = {
                scrollHeight: scrollNode.scrollHeight,
                scrollTop: scrollNode.scrollTop,
              };
            }
          }
          if (!landing.disarm && landingsRef.current > 0) {
            const settleDesktopTail = () => {
              const settledNode = listRef.current?.getScrollableNode() as
                HTMLElement | null | undefined;
              const settledGap = settledNode
                ? settledNode.scrollHeight - settledNode.clientHeight - settledNode.scrollTop
                : Number.POSITIVE_INFINITY;
              if (settledGap > TAIL_PIN_THRESHOLD) {
                stableSinceRef.current = null;
              } else if (stableSinceRef.current === null) {
                stableSinceRef.current = Date.now();
              }
              const settledDecision = desktopTailLanding({
                tailGapAboveThreshold: settledGap > TAIL_PIN_THRESHOLD,
                tailStable:
                  stableSinceRef.current !== null &&
                  Date.now() - stableSinceRef.current >= DESKTOP_TAIL_SETTLE_MS,
                isUserScrolling:
                  userScrolledAtRef.current > 0 &&
                  Date.now() - userScrolledAtRef.current < DESKTOP_USER_SCROLL_WINDOW_MS,
                readerMovedUp:
                  !NOGUARD &&
                  landedOffsetRef.current !== null &&
                  settledNode != null &&
                  settledNode.scrollTop < landedOffsetRef.current - 1,
                landingsRemaining: landingsRef.current,
              });
              landingsRef.current = settledDecision.disarm
                ? 0
                : settledDecision.land
                  ? tailFollowStalled(
                      lastLandRef.current,
                      settledNode
                        ? {
                            scrollHeight: settledNode.scrollHeight,
                            scrollTop: settledNode.scrollTop,
                          }
                        : null,
                      DESKTOP_TAIL_STALL_EPS,
                    )
                    ? Math.max(0, landingsRef.current - 1)
                    : Math.min(DESKTOP_TAIL_LANDING_CAP, landingsRef.current + 1)
                  : landingsRef.current;
              if (settledDecision.disarm) {
                landedOffsetRef.current = null;
                lastLandRef.current = null;
              }
              if (settledDecision.land && settledNode) {
                listRef.current?.scrollToOffset({
                  offset: settledNode.scrollHeight,
                  animated: false,
                });
                landedOffsetRef.current = settledNode.scrollHeight - settledNode.clientHeight;
                lastLandRef.current = {
                  scrollHeight: settledNode.scrollHeight,
                  scrollTop: settledNode.scrollTop,
                };
              }
              if (settledDecision.disarm || landingsRef.current <= 0) {
                landingsRef.current = 0;
                landedOffsetRef.current = null;
                lastLandRef.current = null;
                disarmTimerRef.current = null;
                return;
              }
              disarmTimerRef.current = setTimeout(settleDesktopTail, DESKTOP_TAIL_POLL_MS);
            };
            disarmTimerRef.current = setTimeout(settleDesktopTail, DESKTOP_TAIL_POLL_MS);
          }
        }}
        ListHeaderComponent={HistoryLine}
        renderItem={({ item }: { item: Msg }) => (
          <View dataSet={{ row: item.id }}>
            <Row msg={item} />
          </View>
        )}
      />
      <View style={{ height: 44, borderTopWidth: 1, borderTopColor: '#555' }}>
        <Text style={{ color: '#aaa', padding: 10 }}>composer…</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  messageList: { flex: 1 },
  messageListContent: { paddingHorizontal: 12, paddingVertical: 12 },
  messageListContentDesktop: { flexGrow: 1, justifyContent: 'flex-end' },
});

createRoot(document.getElementById('root')).render(React.createElement(App));
