import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { NotificationLifecycleCard } from '../sources/components/buzz/PrLifecycleCard';
import { LedgerSystemLine } from '../sources/components/buzz/Ledger';
import { foldPrLifecycleRuns } from '../sources/buzz/pr-lifecycle';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';
import { beelineThemes } from '../sources/buzz/groknight';

const root = createRoot(document.getElementById('root')!);
const assert = (ok: unknown, reason: string) => {
  if (!ok) throw Error(reason);
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const get = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const theme = location.search.includes('bone') ? beelineThemes.bone : beelineThemes.obsidian;
document.body.style.background = theme.bgBase;
document.body.style.color = theme.textPrimary;
document.getElementById('root')!.style.padding = '16px';
const fonts = document.createElement('style');
fonts.textContent = `
@font-face{font-family:SpaceGrotesk-Regular;src:url(${require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf')})}
@font-face{font-family:SpaceGrotesk-SemiBold;src:url(${require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf')})}
@font-face{font-family:SpaceGrotesk-Medium;src:url(${require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf')})}
@font-face{font-family:IBMPlexMono-Regular;src:url(${require('../sources/assets/fonts/IBMPlexMono-Regular.ttf')})}
#result{white-space:pre-wrap;overflow-wrap:anywhere}`;
document.head.appendChild(fonts);
function check(id: string, name: string, verb: string, run: number): ChatDisplayMessage {
  return {
    id,
    text: `GitHub ${verb} ${name}`,
    timestamp: 100,
    isUser: false,
    isSystemNotice: true,
    systemEvent: {
      subject: { kind: 'github', name: 'GitHub' },
      verb,
      object: {
        text: name,
        headSha: 'a'.repeat(40),
        url: `https://github.com/acme/repo/actions/runs/${run}`,
      },
    },
  };
}
const messages = [
  check('server', 'SERVER SUITE', 'started a check', 1),
  check('mobile', 'MOBILE SUITE', 'started a check', 2),
];
let opened = '';
function render() {
  const rows = foldPrLifecycleRuns(messages);
  root.render(
    <>
      {rows.map((message) =>
        message.notificationLifecycleRun ? (
          <NotificationLifecycleCard
            key={message.id}
            message={message}
            onOpenCorner={() => undefined}
            onOpenUrl={(url) => {
              opened = url;
            }}
          />
        ) : (
          <LedgerSystemLine
            key={message.id}
            id={message.id}
            text={message.text}
            event={message.systemEvent}
            stamp="11:27"
          />
        ),
      )}
    </>,
  );
  return rows;
}
function textColor(id: string, text: string) {
  const node = [...get(id).querySelectorAll('div')]
    .filter((node) => node.textContent === text)
    .at(-1)!;
  return getComputedStyle(node).color;
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
  if (location.search.includes('reproduce')) {
    messages.push(
      check('server-pass', 'SERVER SUITE', 'passed a check', 1),
      check('mobile-fail', 'MOBILE SUITE', 'failed a check', 2),
    );
    const rows = render();
    await pause(250);
    document.getElementById('result')!.textContent =
      `Reproduction CI-ACCORDION-1: open transcript with two checks started then passed/failed → ${rows.length} visible rows; ${document.querySelectorAll('[data-testid^="system-line-text-"]').length} separate system lines; ${document.querySelectorAll('[data-testid^="notification-run-head-"]').length} shared cards`;
    return;
  }
  const rows = render();
  await pause(250);
  assert(rows.length === 1, 'checks still separate');
  const expand = () => get('notification-run-expand-server');
  assert(expand().textContent === '1 more ▾', 'collapsed strip');
  assert(
    get('notification-run-head-server').textContent?.includes('Check · 2 running'),
    'check header',
  );
  expand().click();
  await pause(100);
  get('notification-run-contracted-server').click();
  await pause(80);
  assert(get('notification-run-cell-server'), 'selection');
  assert(get('notification-run-contracted-mobile'), 'previous row not contracted');
  const selectionEarly = textColor('notification-run-cell-server', 'SERVER SUITE');
  get('notification-run-cell-url-server').click();
  assert(opened.endsWith('/actions/runs/1'), 'wrong check link');
  await pause(1900);
  const reduced = location.search.includes('reduced');
  const selectionLate = textColor('notification-run-cell-server', 'SERVER SUITE');
  assert(
    reduced ? selectionEarly === selectionLate : selectionEarly !== selectionLate,
    'selection settle',
  );
  messages.push(
    check('server-pass', 'SERVER SUITE', 'passed a check', 1),
    check('mobile-fail', 'MOBILE SUITE', 'failed a check', 2),
  );
  const updated = render();
  await pause(80);
  assert(updated[0].notificationLifecycleRun!.items.length === 2, 'duplicate checks');
  assert(
    get('notification-run-cell-server').textContent?.includes('passed'),
    'selected check did not update',
  );
  assert(
    get('notification-run-contracted-mobile').textContent?.includes('failed'),
    'failed check did not update',
  );
  const early = textColor('notification-run-cell-server', 'passed');
  await pause(1900);
  const late = textColor('notification-run-cell-server', 'passed');
  assert(reduced ? early === late : early !== late, 'state settle');
  expand().click();
  await pause(100);
  assert(expand().textContent === '1 more ▾', 'collapse');
  assert(!get('notification-run-contracted-mobile'), 'compact row still visible');
  assert(document.documentElement.scrollWidth <= innerWidth, 'horizontal overflow');
  document.getElementById('result')!.textContent =
    `PASS CI-ACCORDION-1: four events → one card, two latest-state checks, expansion, selection, correct View link, passed/failed updates, ${reduced ? 'reduced motion' : 'brass settle'}, collapse, no overflow`;
}
main().catch((error) => {
  document.getElementById('result')!.textContent = `FAIL: ${error.message}`;
});
