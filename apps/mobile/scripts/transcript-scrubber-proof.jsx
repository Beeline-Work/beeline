import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { TranscriptScrubber } from '../sources/components/buzz/TranscriptScrubber';
import { createTranscriptScrubberStore } from '../sources/buzz/use-transcript-scrubber';
import { beelineThemes } from '../sources/buzz/groknight';

// Exercise the real component, store and pointer responder over a scrollable
// transcript. Only platform haptics and theme selection are supplied by the runner.
const theme = beelineThemes.obsidian;
const store = createTranscriptScrubberStore();
const rows = Array.from({ length: 80 }, (_, index) => ({
  timestamp: Date.UTC(2024, 8, 30 - index) / 1000,
  text: `Transcript message ${index + 1}`,
}));

function Proof() {
  const list = useRef(null);
  const observe = () => {
    const element = list.current;
    store.observeScroll({
      contentOffset: { y: element.scrollTop },
      contentSize: { height: element.scrollHeight },
      layoutMeasurement: { height: element.clientHeight },
    });
    store.observeVisibleRows([
      rows[Math.min(rows.length - 1, Math.floor(element.scrollTop / 60))],
    ]);
  };
  useEffect(() => {
    list.current.scrollTop = 1500;
    observe();
    return store.dispose;
  }, []);
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', color: theme.textPrimary }}>
      <header style={{ padding: 20, borderBottom: `1px solid ${theme.borderStrong}` }}>Transcript</header>
      <main style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div ref={list} data-testid="transcript-list" onScroll={observe}
          style={{ height: '100%', overflowY: 'auto', scrollbarWidth: 'none' }}>
          {rows.map((row, index) => <div key={index} style={{ height: 60, paddingLeft: 20 }}>
            <button data-testid={`message-${index}`} onClick={() => {
              document.body.dataset.messageClicked = String(index);
            }} style={{ color: 'inherit', background: 'transparent', border: 0, height: 60 }}>
              {row.text}
            </button>
          </div>)}
        </div>
        <TranscriptScrubber scrubber={store} onScrubTo={(offset) => {
          list.current.scrollTop = offset;
          observe();
          document.body.dataset.scrubOffset = String(offset);
        }} />
      </main>
      <footer style={{ padding: 20, borderTop: `1px solid ${theme.borderStrong}` }}>Write a message</footer>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Proof />);
