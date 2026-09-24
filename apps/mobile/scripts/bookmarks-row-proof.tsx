import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import BookmarksScreen from '../sources/app/(app)/beeline/bookmarks';

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

async function read() {
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
  assert(
    rowText.includes(
      new URLSearchParams(location.search).get('surface') === 'desktop' ? 'REMOVE' : 'OPEN →',
    ),
    `the row action is missing: ${rowText}`,
  );
  document.getElementById('result')!.textContent = `PASS ${rowText}`;
}

read().catch((error) => {
  document.getElementById('result')!.textContent = String(error);
});
