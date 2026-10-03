import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { readChatListView, type ChatListView } from '@beeline/api-contract/phone';
import { ConversationRow } from '../sources/components/buzz/ConversationRow';
import { DesktopRoomCorners } from '../sources/components/buzz/DesktopRoomCorners';
import { RoomCornersList } from '../sources/components/buzz/RoomCornersList';
import { useCornerDropdowns } from '../sources/buzz/corner-dropdowns';
import { WAITING_PULSE_CYCLE } from '../sources/components/buzz/CornerWaitingPulse';

/**
 * The Room list's corner dropdown, fed chat-list responses as the server sends
 * them and read through the client's guard, on the phone row and on the
 * desktop rail (each rail row inside the sidebar's draggable div). Steps:
 * nothing waiting, one of the viewer's corners hands back, the viewer taps
 * the mark twice, the corner is answered. Then the waiting pulse is sampled
 * on the dropdown and on the corner list page.
 */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspaceId = uuid(900);
const alpha = uuid(100);
const beta = uuid(200);
const corner = (id: number, name: string, state: string, extra: object = {}) => ({
  id: uuid(id),
  name,
  state,
  mine: true,
  ...extra,
});
/**
 * The viewer's corner 4: still working, waiting on them and unseen, waiting
 * but already opened by them, or idle with nothing owed to anyone.
 */
type Phase = 'working' | 'waiting' | 'seen' | 'idle';
const response = (phase: Phase) => {
  const waiting = phase === 'waiting' || phase === 'seen';
  const alphaRow = {
    room: { id: alpha, name: 'alpha', workspaceId, updatedAt: 1_790_000_000 },
    unread: false,
    cornerCount: 5,
    waitingCornerCount: waiting ? 1 : 0,
    latestMessage: {
      id: 'm-alpha',
      text: 'older',
      createdAt: 1_790_000_100,
      author: { pubkey: 'b'.repeat(64), kind: 'agent', name: 'Bee', handle: 'bee' },
    },
    openCorners: [
      corner(1, 'short', 'working'),
      corner(2, 'widget-notification-pipeline-rewrite-for-desktop-and-mobile', 'working'),
      corner(3, 'rev', 'review'),
      corner(4, 'needs you', waiting ? 'waiting' : phase, {
        ...(waiting ? { waitingSince: 1_790_000_900 } : {}),
        ...(phase === 'waiting' ? { attention: true } : {}),
      }),
      { id: uuid(5), name: 'theirs', state: 'waiting' },
    ],
  };
  const betaRow = {
    room: { id: beta, name: 'beta', workspaceId, updatedAt: 1_790_000_000 },
    unread: false,
    latestMessage: {
      id: 'm-beta',
      text: 'newer',
      createdAt: 1_790_000_500,
      author: { pubkey: 'b'.repeat(64), kind: 'agent', name: 'Bee', handle: 'bee' },
    },
  };
  // The server lists Rooms newest activity first; a viewer's waiting corner is activity.
  return {
    workspace: { id: workspaceId, name: 'Proof', role: 'member', updatedAt: 1_790_000_000 },
    viewer: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Me' },
    truncated: false,
    watchFilters: [],
    chats: waiting ? [alphaRow, betaRow] : [betaRow, alphaRow],
  };
};

const setters = new Set<(view: ChatListView) => void>();
const setView = (view: ChatListView) => setters.forEach((set) => set(view));

function RoomList({ desktop }: { desktop: boolean }) {
  const [view, set] = React.useState<ChatListView>(() => readChatListView(response('working'))!);
  React.useEffect(() => {
    setters.add(set);
    return () => void setters.delete(set);
  }, []);
  const dropdowns = useCornerDropdowns(view.chats);
  const prefix = desktop ? 'desktop' : 'phone';
  return (
    <div data-testid={`${prefix}-list`} style={{ width: desktop ? 320 : 390 }}>
      {view.chats.map((item) => (
        <div
          key={item.room.id}
          data-room={item.room.name}
          data-expanded={dropdowns.expanded.has(item.room.id)}
        >
          <ConversationRow
            item={item}
            now={1_790_001_000_000}
            onPress={() => undefined}
            onPin={() => undefined}
            desktop={desktop}
            cornersExpanded={dropdowns.expanded.has(item.room.id)}
            onToggleCorners={() => dropdowns.toggle(item.room.id)}
            onLongPressCorners={() => undefined}
            testID={`${prefix}-row-${item.room.name}`}
          />
          {(item.cornerCount ?? 0) > 0 && dropdowns.expanded.has(item.room.id) && (
            <DesktopRoomCorners
              item={item}
              mobile={!desktop}
              onOpen={() => undefined}
              renderDrag={(_, children) =>
                desktop ? React.createElement('div', { draggable: true }, children) : children
              }
            />
          )}
        </div>
      ))}
    </div>
  );
}

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
/** Wait until both lists show the dropdown open or closed, up to a second. */
async function settleOpen(open: boolean, prefixes = ['phone', 'desktop']) {
  for (let waited = 0; waited < 1000; waited += 20) {
    if (prefixes.every((prefix) => snapshot(prefix).open === open)) break;
    await pause(20);
  }
  await pause(20);
}
const lines: string[] = [];
let pass = true;
const progress = () => {
  document.getElementById('result')!.textContent = `PENDING\n${lines.join('\n')}`;
};
window.addEventListener('error', (event) => {
  lines.push(`FAIL page error ${event.message}`);
  progress();
});
const check = (ok: boolean, text: string) => {
  pass &&= ok;
  lines.push(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
  progress();
};

function snapshot(prefix: string) {
  const list = document.querySelector<HTMLElement>(`[data-testid="${prefix}-list"]`)!;
  const rooms = Array.from(list.querySelectorAll<HTMLElement>('[data-room]')).map(
    (node) => node.dataset.room!,
  );
  const rail = list.querySelector<HTMLElement>('[data-testid^="desktop-room-corners-"]');
  const rows = Array.from(list.querySelectorAll<HTMLElement>('[aria-label^="Open corner"]'));
  const railRight = rail
    ? rail.getBoundingClientRect().right - parseFloat(getComputedStyle(rail).paddingRight)
    : 0;
  const corners = rows.map((row) => {
    const texts = Array.from(row.querySelectorAll<HTMLElement>('div, span')).filter(
      (node) => node.children.length === 0 && node.textContent,
    );
    const name = texts[0]!;
    const label = texts[texts.length - 1]!;
    return {
      state: label.textContent!,
      labelGap: Math.round(railRight - label.getBoundingClientRect().right),
      nameCut: name.scrollWidth > name.clientWidth,
      labelCut: label.scrollWidth > label.clientWidth,
      pulsing: label.closest('[data-testid="corner-waiting-pulse"]') !== null,
    };
  });
  return { rooms, open: Boolean(rail), corners };
}

function describe(prefix: string, step: string) {
  const s = snapshot(prefix);
  lines.push(
    `${prefix} ${step}: rooms=[${s.rooms.join(',')}] dropdown=${s.open ? 'open' : 'closed'}` +
      (s.open
        ? ' ' +
          s.corners
            .map(
              (c) =>
                `${c.state}(gap ${c.labelGap}px${c.pulsing ? ', pulse' : ''}${c.nameCut ? ', name cut' : ''})`,
            )
            .join(' ')
        : ''),
  );
  return s;
}

function tap(prefix: string, room: string) {
  document.querySelector<HTMLElement>(`[data-testid="${prefix}-row-${room}-corners"]`)!.click();
}

async function flows() {
  const root = createRoot(document.getElementById('root')!);
  root.render(
    <div style={{ display: 'flex', gap: 40 }}>
      <RoomList desktop={false} />
      <RoomList desktop />
    </div>,
  );
  await pause(150);
  for (const prefix of ['phone', 'desktop']) {
    const s = describe(prefix, '1 nothing waiting');
    check(s.rooms.join() === 'beta,alpha' && !s.open, `${prefix}: collapsed, alpha below beta`);
    check(
      document
        .querySelector(`[data-testid="${prefix}-row-alpha-corners"]`)
        ?.getAttribute('aria-label') === 'Expand 4 corners',
      `${prefix}: accessible count matches the four listed viewer corners, not all five`,
    );
  }
  setView(readChatListView(response('waiting'))!);
  await settleOpen(true);
  for (const prefix of ['phone', 'desktop']) {
    const s = describe(prefix, '2 my corner waiting');
    check(s.rooms.join() === 'alpha,beta', `${prefix}: alpha moved to the top`);
    check(s.open, `${prefix}: dropdown opened on its own`);
    check(
      s.corners.map((c) => c.state).join() === 'waiting,working,working,review',
      `${prefix}: only my corners, waiting first`,
    );
    check(
      s.corners.every((c) => c.labelGap === 0),
      `${prefix}: every status label ends on the right edge`,
    );
    check(
      s.corners.some((c) => c.nameCut) && s.corners.every((c) => !c.labelCut),
      `${prefix}: long name truncates, status never`,
    );
    check(
      s.corners.every((c) => c.pulsing === (c.state === 'waiting')),
      `${prefix}: only waiting pulses`,
    );
  }
  for (const prefix of ['phone', 'desktop']) {
    tap(prefix, 'alpha');
    await settleOpen(false, [prefix]);
    check(!describe(prefix, '3 tap mark').open, `${prefix}: tapping the mark closes it`);
    tap(prefix, 'alpha');
    await settleOpen(true, [prefix]);
    check(describe(prefix, '4 tap mark again').open, `${prefix}: tapping again opens it`);
  }
  // The viewer opened the corner: it still waits on them, but stops pulling
  // the dropdown open.
  setView(readChatListView(response('seen'))!);
  await settleOpen(false);
  for (const prefix of ['phone', 'desktop']) {
    const s = describe(prefix, '5 seen');
    check(!s.open && s.rooms.join() === 'alpha,beta', `${prefix}: seen, closes on its own`);
    tap(prefix, 'alpha');
    await settleOpen(true, [prefix]);
    const opened = describe(prefix, '6 seen, tap mark');
    check(opened.corners[0]?.state === 'waiting', `${prefix}: seen corner still reads waiting`);
    tap(prefix, 'alpha');
    await settleOpen(false, [prefix]);
  }
  // The corner finished with nothing owed to anyone: idle, quiet, closed.
  setView(readChatListView(response('idle'))!);
  await pause(150);
  for (const prefix of ['phone', 'desktop']) {
    const s = describe(prefix, '7 idle');
    check(!s.open && s.rooms.join() === 'beta,alpha', `${prefix}: idle, stays closed`);
    tap(prefix, 'alpha');
    await settleOpen(true, [prefix]);
    const opened = describe(prefix, '8 idle, tap mark');
    check(
      opened.corners.map((c) => c.state).join() === 'working,working,review,idle' &&
        opened.corners.every((c) => !c.pulsing),
      `${prefix}: idle reads idle and does not pulse`,
    );
    tap(prefix, 'alpha');
    await settleOpen(false, [prefix]);
  }
  setView(readChatListView(response('waiting'))!);
  await settleOpen(true);
  for (const prefix of ['phone', 'desktop'])
    check(describe(prefix, '9 waiting again').open, `${prefix}: a new ask opens it again`);
  setView(readChatListView(response('working'))!);
  await settleOpen(false);
  for (const prefix of ['phone', 'desktop']) {
    const s = describe(prefix, '10 answered');
    check(!s.open && s.rooms.join() === 'beta,alpha', `${prefix}: closes once none is waiting`);
  }
  // CM-1: the Room still has open corners, but none belongs in the viewer's dropdown.
  for (const openCorners of [[{ id: uuid(5), name: 'theirs', state: 'working' }], [], undefined]) {
    const next = response('working');
    const room = next.chats.find((item) => item.room.id === alpha)!;
    setView(
      readChatListView({
        ...next,
        chats: next.chats.map((item) =>
          item === room ? { ...item, unread: true, openCorners } : item,
        ),
      })!,
    );
    await pause(100);
    for (const prefix of ['phone', 'desktop']) {
      const mark = document.querySelector<HTMLElement>(
        `[data-testid="${prefix}-row-alpha-corners"]`,
      );
      // On the unfixed branch this performs the human's tap and exposes the empty expansion.
      mark?.click();
      await pause();
      const list = document.querySelector(`[data-testid="${prefix}-list"]`)!;
      const expanded = list.querySelector('[data-room="alpha"]')?.getAttribute('data-expanded');
      const rows = list.querySelectorAll('[aria-label^="Open corner"]').length;
      const unread = Boolean(list.querySelector(`[data-testid="${prefix}-row-alpha-unread"]`));
      lines.push(
        `CM-1 ${prefix}: openCorners=${openCorners === undefined ? 'missing' : openCorners.length ? 'others only' : 'empty'} mark=${Boolean(mark)} expanded=${expanded ?? 'absent'} dropdownRows=${rows} unread=${unread}`,
      );
      check(!mark && rows === 0 && unread, `CM-1 ${prefix}: no empty toggle; unread dot retained`);
    }
  }
  root.unmount();
}

async function pulse() {
  // The dropdown's waiting label and the corner list page's waiting word,
  // mounted 500 ms apart, sampled together every 40 ms.
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const waitingItem = readChatListView(response('waiting'))!.chats[0]!;
  const pageItem = {
    corner: { id: uuid(4), name: 'needs you', workspaceId, parentId: alpha },
    lifecycle: { lifecycle: 'working', checks: 'unknown' },
    state: 'waiting',
    stateAt: 1_790_000_900,
    initiator: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Me' },
  };
  const render = (withPage: boolean) =>
    root.render(
      <div>
        <DesktopRoomCorners item={waitingItem} onOpen={() => undefined} renderDrag={(_, c) => c} />
        {withPage && (
          <RoomCornersList
            parentRoomId={alpha}
            parentRoomName="alpha"
            viewerPubkey={'a'.repeat(64)}
            corners={[pageItem as never]}
          />
        )}
      </div>,
    );
  render(false);
  await pause(500);
  render(true);
  await pause(300);
  const pulses = () =>
    Array.from(host.querySelectorAll<HTMLElement>('[data-testid="corner-waiting-pulse"]'));
  check(
    pulses().length === 2,
    `pulse: dropdown and corner list page each pulse waiting (${pulses().length})`,
  );
  const samples: number[][] = [];
  const started = performance.now();
  while (performance.now() - started < WAITING_PULSE_CYCLE) {
    await pause(40);
    samples.push(pulses().map((node) => Number(getComputedStyle(node).opacity)));
  }
  const spread = Math.max(...samples.map((s) => Math.abs(s[0]! - s[1]!)));
  const all = samples.map((s) => s[0]!);
  const low = Math.min(...all);
  const high = Math.max(...all);
  lines.push(
    `pulse: ${samples.length} samples, opacity ${low.toFixed(2)}..${high.toFixed(2)}, max difference between the two labels ${spread.toFixed(3)}, cycle ${WAITING_PULSE_CYCLE} ms`,
  );
  check(spread < 0.02, 'pulse: labels mounted 500 ms apart breathe in one phase');
  check(WAITING_PULSE_CYCLE > 1120, 'pulse: slower than the 1120 ms mock cycle');
  root.unmount();
}

async function run() {
  await flows();
  await pulse();
  document.getElementById('result')!.textContent =
    `RESULT ${pass ? 'PASS' : 'FAIL'}\n${lines.join('\n')}`;
}

run().catch((error) => {
  document.getElementById('result')!.textContent = `FAIL ${String(error)}\n${lines.join('\n')}`;
});
