import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import TrayScreen from '../sources/app/(app)/beeline/tray';

const desktop = new URLSearchParams(location.search).get('surface') === 'desktop';

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};

async function read() {
  createRoot(document.getElementById('root')!).render(<TrayScreen />);
  // The list loads, finds nothing saved, and paints its empty block.
  await pause();
  await pause();

  // Needs you is empty on its own, and says so without hiding Saved.
  const nothing = document.querySelector<HTMLElement>('[data-testid="needs-you-empty"]');
  assert(nothing != null, 'the Needs you empty block never painted');
  assert(
    (nothing!.textContent ?? '').includes('Nothing needs you'),
    `Needs you empty block reads: ${nothing!.textContent}`,
  );

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
  createRoot(document.getElementById('root')!).render(<TrayScreen />);
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

/** A link with no communityId paints the Tray or a way back, never only the loader. */
async function readNoLink() {
  const started = performance.now();
  createRoot(document.getElementById('root')!).render(<TrayScreen />);
  let row: HTMLElement | null = null;
  let fallback: HTMLElement | null = null;
  while (!row && !fallback && performance.now() - started < 5_000) {
    await pause();
    row = document.querySelector<HTMLElement>('[data-testid="bookmark-msg-1"]');
    fallback = document.querySelector<HTMLElement>('[data-testid="tray-no-workspace"]');
  }
  const elapsed = Math.round(performance.now() - started);
  assert(row != null || fallback != null, `only the loader after ${elapsed} ms`);
  if (row) {
    report(`PASS Tray of workspace-1 in ${elapsed} ms: ${row.textContent}`);
    return;
  }
  const back = Array.from(fallback!.querySelectorAll<HTMLElement>('[role="button"]')).find(
    (element) => element.textContent === 'BACK TO ROOMS',
  );
  assert(back != null, `the fallback has no way back: ${fallback!.textContent}`);
  back!.click();
  const replaced = (window as typeof window & { __replaced?: string }).__replaced;
  assert(replaced === '/beeline/channels', `BACK TO ROOMS went to ${replaced}`);
  report(`PASS ${fallback!.textContent} in ${elapsed} ms; back to ${replaced}`);
}

/** CLEAR on a section head empties it at once and offers Undo; approvals stay. */
async function readClear() {
  const section = new URLSearchParams(location.search).get('clear') === 'saved' ? 'saved' : 'needs';
  createRoot(document.getElementById('root')!).render(<TrayScreen />);
  await pause();
  await pause();
  const clear = document.querySelector<HTMLElement>(`[data-testid="tray-clear-${section}"]`);
  assert(clear != null, `the ${section} head has no CLEAR`);
  const target = clear!.getBoundingClientRect();
  const head = clear!.closest<HTMLElement>('[data-testid^="tray-section-"]')!.getBoundingClientRect();
  assert(
    target.width >= 44 && target.height >= 44 && head.height >= 44,
    `CLEAR is ${target.width}×${target.height} in a ${head.height} px head; it needs 44×44`,
  );
  const size = `CLEAR ${Math.round(target.width)}×${Math.round(target.height)} in ${Math.round(head.height)} px head`;
  clear!.click();
  await pause();
  const undo = document.querySelector<HTMLElement>('[data-testid="tray-clear-undo"]');
  assert(undo != null, 'no Undo bar after CLEAR');
  const gone = section === 'needs' ? 'needs-you-ask-1' : 'bookmark-msg-1';
  assert(
    document.querySelector(`[data-testid="${gone}"]`) == null,
    `${gone} is still on screen after CLEAR`,
  );
  if (section === 'needs')
    assert(
      document.querySelector('[data-testid="needs-you-grant-1"]') != null,
      'CLEAR took the approval too',
    );
  const heads = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="tray-section-"]'))
    .map((head) => head.textContent)
    .join(' | ');
  if (new URLSearchParams(location.search).get('remove') === '1') {
    const remove = document.querySelector<HTMLElement>('[aria-label="Remove unavailable bookmark"]');
    assert(remove != null, 'no REMOVE on the unavailable bookmark');
    remove!.click();
    await pause();
    const removal = document.querySelector<HTMLElement>('[data-testid="bookmark-undo"]');
    const bulk = document.querySelector<HTMLElement>('[data-testid="tray-clear-undo"]');
    assert(removal != null, 'no Bookmark removed bar after REMOVE');
    assert(bulk != null, `bulk Undo disappeared after REMOVE: ${removal!.textContent}`);
    assert(
      bulk!.getBoundingClientRect().bottom <= removal!.getBoundingClientRect().top,
      'the bulk Undo bar overlaps the Bookmark removed bar',
    );
    const bars = `${bulk!.textContent} above ${removal!.textContent}`;
    bulk!.querySelector<HTMLElement>('[role="button"]')!.click();
    await pause();
    assert(
      document.querySelector('[data-testid="needs-you-ask-1"]') != null,
      'bulk UNDO did not bring the question back',
    );
    report(`PASS ${size} | ${bars} | UNDO restored needs-you-ask-1`);
    return;
  }
  if (desktop) {
    const list = document.querySelector<HTMLElement>('[data-testid="tray-list"]')!.getBoundingClientRect();
    const bar = undo!.getBoundingClientRect();
    assert(
      bar.left >= list.left && bar.right <= list.right,
      `the Undo bar spans x${Math.round(bar.left)}–${Math.round(bar.right)}, outside the list x${Math.round(list.left)}–${Math.round(list.right)}`,
    );
    report(`PASS ${size} | ${heads} | ${undo!.textContent} | Undo x${Math.round(bar.left)}–${Math.round(bar.right)} in list x${Math.round(list.left)}–${Math.round(list.right)}`);
    return;
  }
  report(`PASS ${size} | ${heads} | ${undo!.textContent}`);
}

const mode = new URLSearchParams(location.search).get('mode');
(mode === 'row'
  ? readRow()
  : mode === 'no-link'
    ? readNoLink()
    : mode === 'clear'
      ? readClear()
      : read()
).catch((error) => report(String(error)));
