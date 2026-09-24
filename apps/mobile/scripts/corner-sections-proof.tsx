import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import BuzzCorners from '../sources/app/(app)/beeline/corners/[roomId]';
import { archivedReads, cornerSectionsView } from './corner-sections-fixture';

// The shimmed RoomViewClient reads corners through this seam.
(globalThis as { cornerSectionsView?: typeof cornerSectionsView }).cornerSectionsView =
  cornerSectionsView;

/**
 * The real corners page against a Room where seven open corners are the
 * viewer's, three are someone else's, and 23 are archived.
 */
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};
const rows = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="room-corner-corner-"]')).map(
    (node) => node.dataset.testid!.slice('room-corner-'.length),
  );
const label = (testID: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testID}"]`)?.textContent ?? null;
const tap = async (testID: string) => {
  document.querySelector<HTMLElement>(`[data-testid="${testID}"]`)!.click();
  for (let i = 0; i < 4; i += 1) await pause();
};

async function run() {
  createRoot(document.getElementById('root')!).render(<BuzzCorners />);
  for (let i = 0; i < 6; i += 1) await pause();
  const lines: string[] = [];
  const read = (step: string) => {
    const shown = rows();
    const closed = shown.filter((id) => id.startsWith('corner-closed-'));
    lines.push(
      `${step}: ${shown.length - closed.length} open rows [${shown
        .filter((id) => !id.startsWith('corner-closed-'))
        .join(',')}] | ${closed.length} archived rows${
        closed.length ? ` (${closed[0]}..${closed.at(-1)})` : ''
      } | "${label('room-corners-mine')}" "${label('room-corners-others')}" "${label(
        'room-corners-archived',
      )}"${label('room-corners-archived-more') ? ` "${label('room-corners-archived-more')}"` : ''}`,
    );
    return { shown, closed };
  };

  const opened = read('opened');
  assert(!document.querySelector('[role="switch"]'), 'a Mine switch is on the page');
  const mine = [1, 2, 3, 4, 5, 6].map((n) => `corner-mine-${n}`).concat('corner-asks-me');
  assert(opened.shown.join(',') === mine.join(','), `open: ${opened.shown}`);
  assert(label('room-corners-mine') === 'Mine · 7', `mine: ${label('room-corners-mine')}`);
  assert(label('room-corners-others') === 'Others · 3', `others: ${label('room-corners-others')}`);
  assert(label('room-corners-archived') === 'Archived corners', 'archived is not folded');
  assert(archivedReads.length === 0, 'archived was read before it was opened');

  await tap('room-corners-others');
  const others = read('tapped Others');
  assert(
    others.shown.join(',') ===
      [...mine, 'corner-theirs-1', 'corner-theirs-2', 'corner-asks-them'].join(','),
    `others: ${others.shown}`,
  );

  await tap('room-corners-archived');
  const first = read('tapped Archived');
  assert(first.closed.length === 10, `first page: ${first.closed.length}`);
  assert(label('room-corners-archived') === 'Archived corners · 10+', 'first page label');
  await tap('room-corners-archived-more');
  const second = read('tapped More');
  assert(second.closed.length === 20, `second page: ${second.closed.length}`);
  await tap('room-corners-archived-more');
  const third = read('tapped More');
  const expected = Array.from(
    { length: 23 },
    (_, index) => `corner-closed-${String(index + 1).padStart(2, '0')}`,
  );
  assert(third.closed.join(',') === expected.join(','), `all pages: ${third.closed}`);
  assert(!label('room-corners-archived-more'), 'More still offered after the last page');
  lines.push(`archived reads, by cursor: ${JSON.stringify(archivedReads)}`);
  assert(JSON.stringify(archivedReads) === '[null,"10","20"]', 'unexpected archived reads');

  await tap('room-corners-archived');
  const folded = read('tapped Archived again');
  assert(folded.closed.length === 0 && archivedReads.length === 3, 'fold re-read or stayed open');
  report(`PASS\n${lines.join('\n')}`);
}

run().catch((error) => report(`FAIL ${String(error)}`));
