import React from 'react';
// @ts-expect-error standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import LifecycleGlyphProof from './lifecycle-glyph-proof';
createRoot(document.getElementById('root')!).render(<LifecycleGlyphProof />);
setTimeout(() => {
  document.querySelector<HTMLElement>('[data-testid="notification-run-expand-r1"]')!.click();
  setTimeout(() => {
    const rows = [...document.querySelectorAll('[data-testid^="notification-run-cell-event-"]')];
    const glyphs = rows.map(row => row.querySelectorAll('polygon').length);
    const marker = document.querySelector('[aria-label="Open corner lifecycle-glyphs"]')!;
    const cornerPoints = marker.closest('[data-testid^="notification-run-cell-"]')?.querySelector('polygon')?.getAttribute('points');
    (document.querySelector('[data-testid="notification-run-cell-url-event-0"]') as HTMLElement).click();
    setTimeout(() => {
      document.getElementById('result')!.textContent = JSON.stringify({ rows: rows.length, glyphs, cornerPoints,
        destination: document.querySelector('[data-testid="destination"]')?.textContent,
        overflow: document.documentElement.scrollWidth > innerWidth, warnings: (window as any).__console });
    }, 50);
  }, 100);
}, 500);
