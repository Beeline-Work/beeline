import React from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import RootLayout from '../sources/app/(app)/_layout';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lines: string[] = [];
function check(name: string, passed: boolean) {
  lines.push(`${passed ? 'PASS' : 'FAIL'} ${name}`);
  document.getElementById('result')!.textContent = lines.join('\n');
}
function element(id: string) {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function drag(
  start: number,
  points: Array<[number, number]>,
  cancel = false,
  held?: () => void,
) {
  const page = element('proof-page')!;
  const box = page.getBoundingClientRect();
  const send = (type: string, dx: number, dy: number) => {
    const touch = new Touch({
      identifier: 1,
      target: page,
      clientX: start + dx,
      pageX: start + dx,
      clientY: box.top + 180 + dy,
      pageY: box.top + 180 + dy,
    });
    page.dispatchEvent(
      new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === 'touchend' || type === 'touchcancel' ? [] : [touch],
        changedTouches: [touch],
        targetTouches: type === 'touchend' || type === 'touchcancel' ? [] : [touch],
      }),
    );
  };
  send('touchstart', 0, 0);
  for (const [dx, dy] of points) {
    await pause(30);
    send('touchmove', dx, dy);
  }
  await pause(30);
  held?.();
  send(cancel ? 'touchcancel' : 'touchend', ...points.at(-1)!);
  await pause(250);
}

function closed() {
  return !element('community-drawer-overlay');
}
function open() {
  const drawer = element('community-drawer');
  return Boolean(drawer && Math.abs(new DOMMatrix(getComputedStyle(drawer).transform).m41) < 1);
}
function dismiss() {
  element('community-drawer-scrim')?.click();
}

createRoot(document.getElementById('root')!).render(<RootLayout />);
async function run() {
  await pause(300);
  const baseline = new URLSearchParams(location.search).has('baseline');
  const navigate = (window as any).__proofNavigate as (page: string) => void;
  check('Rail rests hidden', closed());
  await drag(140, [
    [15, 0],
    [80, 0],
    [120, 0],
  ]);
  check('Non-edge horizontal swipe leaves the page alone', closed());
  await drag(2, [
    [2, 15],
    [4, 70],
    [7, 130],
  ]);
  check('Vertical scroll at the edge leaves the page alone', closed());
  await drag(2, [
    [15, 0],
    [24, 0],
  ]);
  check('Incomplete swipe closes', closed());
  await drag(
    2,
    [
      [15, 0],
      [70, 0],
    ],
    true,
  );
  check('Cancelled swipe closes', closed());

  for (const page of ['conversation', 'settings', 'corners', 'rooms', 'workbench', 'profile']) {
    navigate(page);
    await pause(50);
    await drag(
      2,
      [
        [15, 0],
        [38, 0],
      ],
      false,
      () => {
        const drawer = element('community-drawer');
        const x = drawer ? new DOMMatrix(getComputedStyle(drawer).transform).m41 : 0;
        if (!baseline) check(`${page}: rail follows the finger`, x > -72 && x < 0);
      },
    );
    dismiss();
    await pause(100);
    await drag(2, [
      [15, 0],
      [55, 0],
      [105, 0],
    ]);
    check(`${page}: left-edge swipe reveals the existing rail`, open());
    if (baseline) continue;
    check(
      `${page}: one rail, existing Add and Settings`,
      document.querySelectorAll('[data-testid="community-drawer"]').length === 1 &&
        Boolean(element('community-rail-add')) &&
        Boolean(element('community-rail-settings')),
    );
    element('community-rail-workspace-b')!.click();
    await pause(100);
    check(
      `${page}: selecting Morning Watch opens its Room list and persists selection`,
      closed() &&
        element('proof-page')?.textContent?.includes('rooms: workspace-b') === true &&
        localStorage.getItem('@beeline/community/active/proof-person') === 'workspace-b',
    );
  }

  if (!baseline) {
    navigate('rooms');
    await pause(50);
    element('workspace-avatar-trigger')!.click();
    await pause(100);
    check('Existing Room-list trigger opens the shared rail', open());
    check(
      'Stored active workspace is marked selected',
      getComputedStyle(element('community-rail-workspace-b')!).borderTopColor !==
        getComputedStyle(element('community-rail-workspace-a')!).borderTopColor,
    );
    element('community-rail-settings')!.click();
    await pause(100);
    check(
      'Existing Settings control closes the rail and opens Settings',
      closed() && element('proof-page')?.textContent?.includes('settings') === true,
    );
    await drag(2, [
      [15, 0],
      [55, 0],
      [105, 0],
    ]);
    element('community-rail-add')!.click();
    await pause(100);
    check(
      'Existing Add control closes the rail and opens workspace choice',
      closed() && element('proof-page')?.textContent?.includes('community') === true,
    );
    await drag(2, [
      [15, 0],
      [55, 0],
      [105, 0],
    ]);
    const pushesBeforeAdd = (window as any).__proofPushCount;
    element('community-rail-add')!.click();
    await pause(100);
    check(
      'Workspace choice Add closes the rail without pushing a duplicate page',
      closed() &&
        element('proof-page')?.textContent?.includes('community') === true &&
        (window as any).__proofPushCount === pushesBeforeAdd,
    );
    await drag(2, [
      [15, 0],
      [55, 0],
      [105, 0],
    ]);
    dismiss();
    await pause(100);
    check('Scrim dismisses the rail', closed());
    element('proof-tap')!.click();
    await pause(30);
    check(
      'Ordinary page tap still works',
      element('proof-page')?.textContent?.includes('taps: 1') === true,
    );
    (window as any).__proofSignedIn = false;
    (window as any).__proofIdentityChanged();
    await pause(100);
    await drag(2, [
      [15, 0],
      [55, 0],
      [105, 0],
    ]);
    check('Signed-out pages do not expose workspace navigation', closed());
    (window as any).__proofSignedIn = true;
    (window as any).__proofIdentityChanged();
    await pause(100);
    await drag(2, [
      [15, 0],
      [55, 0],
      [105, 0],
    ]);
    check('Signing in enables the shared rail without remounting the stack', open());
  }
  lines.push(lines.some((line) => line.startsWith('FAIL')) ? 'RESULT FAIL' : 'RESULT PASS');
  document.getElementById('result')!.textContent = lines.join('\n');
}
void run().catch((error) => check(String(error), false));
