import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FlatList, View, Text, StyleSheet } from 'react-native';

// Deterministic variable-height rows, like real ledger entries.
const ROW_HEIGHTS = [34, 52, 44, 70, 38, 58, 46, 84, 40, 62, 36, 55, 48, 76, 42, 66];

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
  const [messages, setMessages] = useState<Msg[]>(makeMessages(60));
  const listRef = useRef<FlatList<Msg>>(null);
  const logRef = useRef<string[]>([]);
  const appendedRef = useRef(false);

  // The app's tail follow: decide during render, scroll in a layout effect.
  const pinnedRef = useRef(true);
  useLayoutEffect(() => {
    if (!appendedRef.current) return;
    listRef.current?.scrollToEnd({ animated: false });
  }, [messages]);

  useEffect(() => {
    const measure = (label: string) => {
      const scroller = document.querySelector('[data-testid="chat-messages"]');
      const rows = Array.from(document.querySelectorAll('[data-row]'));
      const rects = rows.map((r) => {
        const rect = (r as HTMLElement).getBoundingClientRect();
        return { id: r.getAttribute('data-row'), top: rect.top, bottom: rect.bottom };
      });
      let overlaps = 0;
      const details: string[] = [];
      for (let i = 1; i < rects.length; i++) {
        if (rects[i].top < rects[i - 1].bottom - 0.5) {
          overlaps++;
          details.push(
            `${rects[i].id}.top=${rects[i].top.toFixed(1)} < ${rects[i - 1].id}.bottom=${rects[i - 1].bottom.toFixed(1)}`,
          );
        }
      }
      const sc = scroller as HTMLElement | null;
      const verdict = {
        label,
        scrollTop: sc ? Math.round(sc.scrollTop) : null,
        scrollHeight: sc ? sc.scrollHeight : null,
        clientHeight: sc ? sc.clientHeight : null,
        renderedRows: rows.length,
        overlaps,
        details: details.slice(0, 6),
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
        onScroll={() => {}}
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
