import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import {
  MemberPickerSheet,
  type MemberPickerCandidate,
} from '../sources/components/buzz/MemberPickerSheet';

/**
 * Android draws the app edge to edge, so the 3-button navigation bar sits over
 * the bottom `insets.bottom` pixels of the screen and takes every tap there.
 * This paints the real member picker at phone size with a 48px bottom inset and
 * enough candidates to overflow the sheet, lays an opaque 48px bar over the
 * bottom of the page, checks a member, taps Add where a finger would, then
 * scrolls the list to its end.
 */
const NAV_BAR = 48;

const CANDIDATES: MemberPickerCandidate[] = Array.from({ length: 20 }, (_, index) => ({
  pubkey: String(index).padStart(64, 'c'),
  name: `Member ${index}`,
  handle: `member${index}`,
  kind: index % 2 ? 'agent' : 'person',
}));

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};
const byTestID = (testID: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);

async function read() {
  const added: string[][] = [];
  const root = document.getElementById('root')!;
  root.style.cssText = 'height:100vh';
  createRoot(root).render(
    <MemberPickerSheet
      visible
      onClose={() => undefined}
      candidates={CANDIDATES}
      workspacePeerCount={CANDIDATES.length}
      canManage
      busy={false}
      error={null}
      onAdd={(pubkeys) => added.push(pubkeys)}
      onInvitePerson={() => undefined}
      onConnectAgent={() => undefined}
    />,
  );
  await pause();
  await pause();

  const bar = document.createElement('div');
  bar.id = 'system-nav-bar';
  bar.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${NAV_BAR}px;background:rgba(255,255,255,0.9);z-index:9999`;
  document.body.appendChild(bar);
  const barTop = window.innerHeight - NAV_BAR;

  const firstRow = byTestID(`member-picker-candidate-${CANDIDATES[0]!.pubkey}`);
  if (!firstRow) return report('FAIL the member picker never painted');
  const sheetTop = Math.round(firstRow.getBoundingClientRect().top);
  const before = byTestID('member-picker-add');
  const addBeforeCheck = before
    ? `${before.textContent}${before.getAttribute('aria-disabled') === 'true' ? '(disabled)' : ''}`
    : 'absent';
  firstRow.click();
  await pause();

  const add = byTestID('member-picker-add');
  let addBottom = NaN;
  let tapHits = 'no-add-button';
  if (add) {
    const rect = add.getBoundingClientRect();
    addBottom = Math.round(rect.bottom);
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    tapHits =
      hit && add.contains(hit)
        ? 'add-button'
        : (hit as HTMLElement | null)?.id || String(hit?.tagName);
    if (tapHits === 'add-button') (hit as HTMLElement).click();
  }
  await pause();

  const lastAction = byTestID('room-member-picker-add-agent');
  let scroller: HTMLElement | null = lastAction;
  while (scroller && scroller.scrollHeight <= scroller.clientHeight)
    scroller = scroller.parentElement;
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  await pause();
  const lastActionBottom = Math.round(lastAction?.getBoundingClientRect().bottom ?? NaN);

  const facts = [
    `viewport=${window.innerHeight}`,
    `navBarTop=${barTop}`,
    `sheetFirstRowTop=${sheetTop}`,
    `addBeforeCheck=${addBeforeCheck}`,
    `addAfterCheck=${add?.textContent ?? 'absent'}`,
    `addButtonBottom=${addBottom}`,
    `tapHits=${tapHits}`,
    `onAdd=${JSON.stringify(added.map((pubkeys) => pubkeys.map((key) => key.slice(-2))))}`,
    `lastActionBottomScrolled=${lastActionBottom}`,
  ].join(' ');
  const pass =
    sheetTop >= 0 &&
    addBeforeCheck === 'Add(disabled)' &&
    addBottom <= barTop &&
    tapHits === 'add-button' &&
    added.length === 1 &&
    lastActionBottom <= barTop;
  report(`${pass ? 'PASS' : 'FAIL'} ${facts}`);
}

read().catch((error) => report(`FAIL ${String(error)}`));
