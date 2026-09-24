import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import type { ChatListItem } from '@beeline/buzz-client';
import BuzzCorners from '../sources/app/(app)/beeline/corners/[roomId]';
import { DesktopRoomCorners } from '../sources/components/buzz/DesktopRoomCorners';
import { MineCornersToggle } from '../sources/components/buzz/MineCornersToggle';
import { useMineCorners } from '../sources/buzz/mine-corners';
import { MINE_CORNERS_FIXTURE, MINE_CORNERS_ROOM_ID } from './mine-corners-fixture';

/**
 * The corners page and the desktop rail's corner list, side by side in one
 * page, reading the same Room. The viewer commissioned one corner, one awaits
 * them, and two belong to someone else, one of those waiting on someone else.
 */
const saved = new URLSearchParams(location.search).get('saved');
if (saved) localStorage.setItem('beeline.corners.mine.v1', saved);

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};
const ids = (prefix: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`))
    .map((node) => node.dataset.testid!.slice(prefix.length))
    .filter((id) => id.startsWith('corner-'))
    .sort()
    .join(',');
const toggles = () =>
  document.querySelectorAll('[data-testid^="desktop-room-corners-toggle-"]').length;
const checked = (testID: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testID}"]`)?.getAttribute('aria-checked');

const chat = {
  room: {
    id: MINE_CORNERS_ROOM_ID,
    name: 'alpha',
    workspaceId: MINE_CORNERS_FIXTURE.room.workspaceId,
  },
  cornerCount: 4,
  waitingCornerCount: 2,
  // The rail reads the chat list, where the server marks the viewer's corners.
  openCorners: MINE_CORNERS_FIXTURE.corners.map((item) => ({
    id: item.corner.id,
    name: item.corner.name,
    state: item.state,
    ...(item.awaitsViewer || item.initiator?.pubkey === MINE_CORNERS_FIXTURE.viewer.identity.pubkey
      ? { mine: true }
      : {}),
  })),
} as unknown as ChatListItem;

/** The sidebar's wiring: one Mine switch that every Room corner list reads. */
function Rail() {
  const [mine, setMine] = useMineCorners();
  return (
    <div style={{ width: 360 }}>
      <MineCornersToggle mine={mine} onChange={setMine} testID="desktop-corners-mine" />
      <DesktopRoomCorners
        item={chat}
        mine={mine}
        onOpen={() => undefined}
        renderDrag={(_, children) => children}
      />
    </div>
  );
}

async function run() {
  createRoot(document.getElementById('root')!).render(
    <div style={{ display: 'flex', height: 800 }}>
      <Rail />
      <div style={{ flex: 1 }}>
        <BuzzCorners />
      </div>
    </div>,
  );
  for (let i = 0; i < 6; i += 1) await pause();

  const lines: string[] = [];
  const read = (step: string) => {
    const page = ids('room-corner-');
    const rail = ids('desktop-corner-');
    lines.push(
      `${step}: page Mine=${checked('room-corners-mine')} [${page}] | rail Mine=${checked(
        'desktop-corners-mine',
      )} [${rail}] toggles=${toggles()}`,
    );
    return { page, rail };
  };

  const first = read(saved ? `opened with saved=${saved}` : 'opened fresh');
  if (saved === 'all') {
    assert(
      first.page === 'corner-mine,corner-theirs,corner-theirs-waiting,corner-waiting',
      `page: ${first.page}`,
    );
    assert(
      first.rail === 'corner-mine,corner-theirs,corner-theirs-waiting,corner-waiting',
      `rail: ${first.rail}`,
    );
    assert(toggles() === 0, 'rail still has a corners toggle');
    report(`PASS\n${lines.join('\n')}`);
    return;
  }
  assert(checked('room-corners-mine') === 'true', 'page Mine is not on by default');
  const switches = document.querySelectorAll('[data-testid$="corners-mine"]').length;
  const header = document.querySelector('[data-testid="room-corners-mine"]')!.parentElement!;
  const headerText = header.textContent;
  lines.push(`Mine switches on screen: ${switches}; page header reads "${headerText}"`);
  assert(switches === 2, `switches: ${switches}`);
  assert(!/\d/.test(headerText ?? ''), `page header still shows a count: ${headerText}`);
  assert(first.page === 'corner-mine,corner-waiting', `page shows: ${first.page}`);
  assert(first.rail === 'corner-mine,corner-waiting', `rail shows: ${first.rail}`);
  assert(toggles() === 0, 'rail still has a corners toggle');

  document.querySelector<HTMLElement>('[data-testid="room-corners-mine"]')!.click();
  await pause();
  const off = read('tapped Mine on the page');
  const all = 'corner-mine,corner-theirs,corner-theirs-waiting,corner-waiting';
  assert(off.page === all, `page shows: ${off.page}`);
  assert(off.rail === all, `rail shows: ${off.rail}`);
  const stored = localStorage.getItem('beeline.corners.mine.v1');
  lines.push(`device storage beeline.corners.mine.v1=${stored}`);
  assert(stored === 'all', `stored: ${stored}`);

  document.querySelector<HTMLElement>('[data-testid="desktop-corners-mine"]')!.click();
  await pause();
  const on = read('tapped Mine on the rail');
  assert(on.page === 'corner-mine,corner-waiting', `page shows: ${on.page}`);
  assert(on.rail === 'corner-mine,corner-waiting', `rail shows: ${on.rail}`);
  report(`PASS\n${lines.join('\n')}`);
}

run().catch((error) => report(`FAIL ${String(error)}`));
