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

async function readRow() {
  createRoot(document.getElementById('root')!).render(<BookmarksScreen />);
  await pause();
  await pause();

  const row = document.querySelector<HTMLElement>('[data-testid="bookmark-msg-1"]');
  const line = document.querySelector<HTMLElement>('[data-testid="bookmark-save-line-msg-1"]');
  assert(row != null && line != null, 'the bookmark row never painted');
  const saved = Array.from(line!.querySelectorAll<HTMLElement>('*')).find(
    (element) => element.textContent === 'SAVED 2m',
  );
  assert(saved != null, `the right stamp reads: ${line!.textContent}`);
  const rowText = row!.textContent ?? '';
  assert(rowText.split('SAVED 2m').length === 2, `save age appears more than once: ${rowText}`);
  assert(!rowText.includes('2h'), `message age still appears: ${rowText}`);
  assert(
    Math.abs(row!.getBoundingClientRect().right - saved!.getBoundingClientRect().right) <= 18,
    'save age is not at the right edge of the row',
  );
  assert(rowText.includes(desktop ? 'REMOVE' : 'OPEN →'), `the row action is missing: ${rowText}`);
  report(`PASS ${rowText}`);
}

(new URLSearchParams(location.search).get('mode') === 'row' ? readRow() : read()).catch((error) =>
  report(String(error)),
);
