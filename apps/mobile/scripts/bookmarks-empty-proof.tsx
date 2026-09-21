import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import BookmarksScreen from '../sources/app/(app)/beeline/bookmarks';

const desktop = new URLSearchParams(location.search).get('surface') === 'desktop';

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};

async function read() {
  createRoot(document.getElementById('root')!).render(<BookmarksScreen />);
  // The list loads, finds nothing saved, and paints its empty block.
  await pause();
  await pause();

  const empty = document.querySelector<HTMLElement>('[data-testid="bookmarks-empty"]');
  assert(empty != null, 'the empty block never painted');
  const copy = (empty!.textContent ?? '').replace(/\s+/g, ' ').trim();
  assert(copy.includes('No bookmarks yet'), `empty block reads: ${copy}`);

  if (desktop) {
    assert(
      copy.includes('Hover a message and press its bookmark mark.'),
      `desktop reader is told: ${copy}`,
    );
    assert(!/long press/i.test(copy), `desktop reader is still told to long press: ${copy}`);
  } else {
    assert(
      copy.includes('Long press a message and pick Bookmark.'),
      `touch reader is told: ${copy}`,
    );
    assert(!/desktop|hover/i.test(copy), `touch reader is still told about desktop: ${copy}`);
  }

  report(`PASS ${copy}`);
}

read().catch((error) => report(String(error)));
