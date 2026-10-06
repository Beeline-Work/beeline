import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { NotificationLifecycleCard } from '../sources/components/buzz/PrLifecycleCard';
import { foldPrLifecycleRuns } from '../sources/buzz/pr-lifecycle';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';
import { beelineThemes } from '../sources/buzz/groknight';
const root = createRoot(document.getElementById('root')!);
const assert = (ok: unknown, reason: string) => {
  if (!ok) throw Error(reason);
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const get = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const theme = beelineThemes.obsidian;
document.body.style.background = theme.bgBase;
document.body.style.color = theme.textPrimary;
document.getElementById('root')!.style.padding = '16px';
const font = document.createElement('style');
font.textContent = `@font-face{font-family:SpaceGrotesk-Regular;src:url(${require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf')})}
@font-face{font-family:SpaceGrotesk-Medium;src:url(${require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf')})}
@font-face{font-family:IBMPlexMono-Regular;src:url(${require('../sources/assets/fonts/IBMPlexMono-Regular.ttf')})}`;
font.textContent += `@font-face{font-family:SpaceGrotesk-SemiBold;src:url(${require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf')})}`;
font.textContent += '#result{white-space:pre-wrap;overflow-wrap:anywhere}';
document.head.appendChild(font);
const messages: ChatDisplayMessage[] = Array.from({ length: 20 }, (_, i) => ({
  id: `open-${i + 1}`,
  text: 'opened',
  timestamp: 100 + i,
  isUser: false,
  githubEvent: {
    type: 'pull-request',
    action: 'opened',
    actor: 'octocat',
    title: `Change ${i + 1}`,
    url: `https://github.com/acme/repo/pull/${i + 1}`,
  },
}));
let openedUrl = '';
function render() {
  const rows = foldPrLifecycleRuns(messages);
  assert(rows.length === 1, 'not one summary');
  root.render(
    <NotificationLifecycleCard
      message={rows[0]}
      onOpenUrl={(url) => {
        openedUrl = url;
      }}
    />,
  );
}
async function main() {
  await Promise.all(
    [
      'SpaceGrotesk-Regular',
      'SpaceGrotesk-Medium',
      'SpaceGrotesk-SemiBold',
      'IBMPlexMono-Regular',
    ].map((font) => document.fonts.load(`16px ${font}`)),
  );
  render();
  await pause(250);
  const expand = () => get('notification-run-expand-open-1');
  assert(expand().textContent === '19 more ▾', 'collapsed strip');
  assert(
    document.querySelectorAll('[data-testid^="notification-run-contracted-"]').length === 0,
    'hidden rows rendered',
  );
  expand().click();
  await pause(100);
  assert(
    document.querySelectorAll('[data-testid^="notification-run-contracted-"]').length === 19,
    'missing compact rows',
  );
  get('notification-run-contracted-open-1').click();
  await pause(80);
  assert(get('notification-run-cell-open-1'), 'row selection did not present');
  const selectedCell = get('notification-run-cell-open-1');
  const titleNode = [...selectedCell.querySelectorAll('div')]
    .filter((node) => node.textContent === 'Change 1')
    .at(-1)!;
  const selectionEarly = getComputedStyle(titleNode).color;
  get('notification-run-cell-url-open-1').click();
  assert(openedUrl.endsWith('/pull/1'), 'wrong PR link');
  await pause(1900);
  const selectionLate = getComputedStyle(titleNode).color;
  assert(
    location.search.includes('reduced')
      ? selectionEarly === selectionLate
      : selectionEarly !== selectionLate,
    'selection settle',
  );
  messages.push({
    ...messages[0],
    id: 'merged-1',
    timestamp: 200,
    githubEvent: { ...messages[0].githubEvent!, action: 'merged' },
  });
  render();
  await pause(80);
  const cell = get('notification-run-cell-open-1');
  assert(cell.textContent?.includes('merged'), 'update not merged');
  const textNodes = [...cell.querySelectorAll('div')].filter(
    (node) => node.textContent === 'merged',
  );
  const stateNode = textNodes.at(-1)!;
  const early = getComputedStyle(stateNode).color;
  await pause(1900);
  const late = getComputedStyle(stateNode).color;
  const reduced = location.search.includes('reduced');
  assert(
    reduced ? early === late : early !== late,
    `settle ${early} -> ${late}, reduced=${reduced}`,
  );
  assert(
    foldPrLifecycleRuns(messages)[0].notificationLifecycleRun!.items.length === 20,
    'update added duplicate',
  );
  expand().click();
  await pause(100);
  assert(expand().textContent === '19 more ▾', 'collapse after update');
  assert(
    document.querySelectorAll('[data-testid^="notification-run-contracted-"]').length === 0,
    'compact rows still visible',
  );
  assert(document.documentElement.scrollWidth <= innerWidth, 'horizontal overflow');
  document.getElementById('result')!.textContent =
    `PASS PR-ACCORDION-1: one card, 20 PRs, expansion, selection, correct link, merged update, ${reduced ? 'reduced motion' : 'brass settle'}, collapse, no overflow`;
}
main().catch((error) => {
  document.getElementById('result')!.textContent = `FAIL: ${error.message}`;
});
