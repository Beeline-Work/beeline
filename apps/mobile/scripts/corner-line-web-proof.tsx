import React from 'react';
// @ts-expect-error this app's proof harness does not install react-dom declarations.
import { createRoot } from 'react-dom/client';
import CornerLineProof from './corner-line-proof';
const query = new URLSearchParams(location.search);
const surface = query.get('surface') as 'room' | 'dm' | 'parent';
const state = query.get('state') as 'opened' | 'merged' | 'closed';
createRoot(document.getElementById('root')!).render(
  <CornerLineProof initialSurface={surface} initialState={state} />,
);
const fail = (message: string) => {
  throw new Error(message);
};
setTimeout(() => {
  try {
    const scene = document.querySelector('[data-testid="proof-scene"]')!;
    const rows = scene.querySelectorAll('[data-testid^="corner-opened-marker-"]');
    if (rows.length !== 1) fail(`Expected one anchored line, got ${rows.length}`);
    const expected =
      state === 'merged'
        ? 'Merged requested-work PR 2832'
        : state === 'closed'
          ? 'Closed close-requested-work'
          : 'Opened requested-work';
    if (!rows[0].textContent?.replace(/\u00a0/g, ' ').includes(expected))
      fail(`Wrong copy: ${rows[0].textContent}`);
    const glyph = rows[0].querySelector('polygon');
    if (glyph?.getAttribute('fill') !== '#E5A645') fail('Missing gold corner glyph');
    if (rows[0].textContent?.includes('#') || rows[0].textContent?.includes('corner '))
      fail('Unexpected corner prefix');
    const completion = scene.querySelector('[data-testid="proof-room-completion"]');
    const roomRows =
      completion?.querySelectorAll('[data-testid^="notification-run-cell-corner-"]') ?? [];
    if (roomRows.length !== (surface !== 'room' && state === 'merged' ? 1 : 0))
      fail('Wrong Room completion count');
    const target = rows[0] as HTMLElement;
    target.click();
    setTimeout(() => {
      try {
        const corner = document.querySelector('[data-testid="proof-destination"]')?.textContent;
        if (!corner?.match(/^[a-f0-9-]{36}$/)) fail(`Corner navigation failed: ${corner}`);
        const pr = target.querySelector('[aria-label="Open PR 2832"]') as HTMLElement;
        if (state === 'merged') {
          if (!pr) fail('Missing PR link');
          pr.click();
        } else if (target.querySelector('[aria-label^="Open PR "]')) fail('PR leaked before merge');
        setTimeout(() => {
          const result = document.querySelector('[data-testid="proof-destination"]')?.textContent;
          if (state === 'merged' && result !== 'https://github.com/owner/widgets/pull/2832')
            fail('PR target bubbled into the corner target');
          document.getElementById('result')!.textContent = JSON.stringify({
            status: 'PASS',
            surface,
            state,
            copy: expected,
            corner,
            destination: result,
            overflow: document.documentElement.scrollWidth > innerWidth,
            warnings: (window as any).__console,
          });
        }, 50);
      } catch (error) {
        document.getElementById('result')!.textContent = `FAIL ${error}`;
      }
    }, 50);
  } catch (error) {
    document.getElementById('result')!.textContent = `FAIL ${error}`;
  }
}, 500);
