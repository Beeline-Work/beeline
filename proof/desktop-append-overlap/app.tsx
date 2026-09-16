import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FlatList, View, Text, StyleSheet } from 'react-native';
// The real decision under test, exactly as the app imports it.
import { desktopTailLanding } from '../../apps/mobile/sources/buzz/room-scroll-follow';

// Deterministic variable-height rows, like real ledger entries.
const ROW_HEIGHTS = [34, 52, 44, 70, 38, 58, 46, 84, 40, 62, 36, 55, 48, 76, 42, 66];
// Mirrors of the production constants in [channelId].tsx.
const TAIL_PIN_THRESHOLD = 50;
const DESKTOP_TAIL_LANDING_CAP = 24;
const DESKTOP_USER_SCROLL_WINDOW_MS = 500;
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
      <Text style={{ color: '#d7d7df', fontSize: 13 }}>{`message ${msg.id} · height ${msg.h}`}</Text>
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
  const userScrolledAtRef = useRef(0);
  const offsetRef = useRef(0);
  const viewportRef = useRef(0);

  // The app's tail follow: decide during render, scroll in a layout effect.
  useLayoutEffect(() => {
    if (!appendedRef.current) return;
    landingsRef.current = NOFIX ? 0 : DESKTOP_TAIL_LANDING_CAP;
    listRef.current?.scrollToEnd({ animated: false });
  }, [messages]);

  useEffect(() => {
    const measure = (label: string) => {
      const scroller = document.querySelector('[data-testid="chat-messages"]') as HTMLElement | null;
      const rows = Array.from(document.querySelectorAll('[data-row]')) as HTMLElement[];
      const rects = rows.map((r) => r.getBoundingClientRect());
      let overlaps = 0;
      for (let i = 1; i < rects.length; i++) {
        if (rects[i].top < rects[i - 1].bottom - 0.5) overlaps++;
      }
      const tailGap = scroller ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop : null;
      const newestRowVisible = rects.length > 0 ? rects[rects.length - 1].bottom <= window.innerHeight : null;
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
      (window as any).__measure = measure;
      document.getElementById('status').textContent = 'ready';
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={{ flex: 1, height: 520, flexDirection: 'column', borderWidth: 2, borderColor: '#555' }}>
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
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          offsetRef.current = contentOffset.y;
          viewportRef.current = layoutMeasurement.height;
          if (
            landingsRef.current > 0 &&
            contentSize.height - layoutMeasurement.height - contentOffset.y <= TAIL_PIN_THRESHOLD
          ) {
            landingsRef.current = 0;
          }
        }}
        onWheel={() => {
          userScrolledAtRef.current = Date.now();
        }}
        onTouchMove={() => {
          userScrolledAtRef.current = Date.now();
        }}
        onContentSizeChange={(_w: number, h: number) => {
          if (NOFIX) return;
          // Mirrors the desktop branch of [channelId].tsx onContentSizeChange.
          const landing = desktopTailLanding({
            tailGapAboveThreshold:
              h - viewportRef.current - offsetRef.current > TAIL_PIN_THRESHOLD,
            isUserScrolling:
              userScrolledAtRef.current > 0 &&
              Date.now() - userScrolledAtRef.current < DESKTOP_USER_SCROLL_WINDOW_MS,
            landingsRemaining: landingsRef.current,
          });
          landingsRef.current = landing.disarm
            ? 0
            : Math.max(0, landingsRef.current - (landing.land ? 1 : 0));
          if (landing.land) {
            listRef.current?.scrollToOffset({ offset: h, animated: false });
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
