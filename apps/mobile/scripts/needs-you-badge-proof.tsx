import React, { useState } from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import TrayScreen from '../sources/app/(app)/beeline/tray';
import { RoomListToolbar } from '../sources/components/buzz/RoomListToolbar';
import { useNeedsYouCount } from '../sources/buzz/needs-you-store';

/**
 * The Room-list tray badge, wired as the sidebar wires it, beside the real
 * Tray screen. The page drives a clear, a failed clear, a gap and an account
 * switch against the shimmed server and live socket, and reads the badge and
 * the list back from the DOM after each step.
 */
type Proof = typeof window & {
  __server: {
    viewer: string;
    items: Record<string, { messageId: string; workspaceId: string; roomId: string; roomName: string;
      roomKind: 'room'; text: string; createdAt: number }[]>;
    failClear: boolean;
    countDelayMs: number;
  };
  __emit: (live: unknown) => void;
  __switchViewer: (viewer: string) => void;
};
const proof = window as Proof;

const pause = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};

let setTrayOpen: (open: boolean) => void = () => undefined;

function Badge() {
  const count = useNeedsYouCount('workspace-1', 'surface-1');
  return (
    <RoomListToolbar desktop filter="all" onFilter={() => undefined} query="" onQuery={() => undefined}
      needsYouCount={count} onTray={() => undefined} />
  );
}

function App() {
  const [trayOpen, setOpen] = useState(false);
  setTrayOpen = setOpen;
  return (
    <>
      <Badge />
      {trayOpen ? <TrayScreen /> : null}
    </>
  );
}

const badge = () => Number(document.querySelector('[data-testid="tray-needs-you-count"]')?.textContent ?? 0);
const list = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="needs-you-item-"]'))
  .map((cell) => cell.dataset.testid!.slice('needs-you-'.length));
const steps: string[] = [];
const failures: string[] = [];
function record(step: string, expected: { badge: number; list?: number }) {
  const shown = list();
  const line = `${step}: badge ${badge()}, list ${trayShown() ? `${shown.length} [${shown.join(',')}]` : 'closed'}`;
  steps.push(line);
  if (badge() !== expected.badge) failures.push(`${line} (badge should be ${expected.badge})`);
  if (expected.list !== undefined && shown.length !== expected.list)
    failures.push(`${line} (list should be ${expected.list})`);
  if (trayShown() && shown.length !== badge()) failures.push(`${line} (badge and list differ)`);
}
const trayShown = () => document.querySelector('[data-testid="tray-list"]') != null;

function hover(messageId: string) {
  const cell = document.querySelector<HTMLElement>(`[data-testid="needs-you-${messageId}"]`)!;
  for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter'])
    cell.dispatchEvent(new PointerEvent(type, { bubbles: type.endsWith('over'), pointerType: 'mouse' }));
}

async function clickDismiss(messageId: string) {
  hover(messageId);
  await pause(100);
  const button = document.querySelector<HTMLElement>(`[data-testid="needs-you-dismiss-${messageId}"]`);
  if (!button) throw new Error(`no DISMISS on ${messageId}`);
  button.click();
  await pause();
}

async function run() {
  createRoot(document.getElementById('root')!).render(<App />);
  await pause();
  record('1 tray closed, server count', { badge: 3 });

  setTrayOpen(true);
  await pause(500);
  record('2 tray open', { badge: 3, list: 3 });

  await clickDismiss('item-a1');
  record('3 dismiss item-a1', { badge: 2, list: 2 });

  proof.__server.failClear = true;
  await clickDismiss('item-a2');
  record('4 failed clear of item-a2, restored', { badge: 2, list: 2 });
  proof.__server.failClear = false;

  // Another device clears item-a3 and item-a4 arrives; both deltas are lost.
  const alice = proof.__server.items.alice!;
  proof.__server.items.alice = [...alice.filter((item) => item.messageId !== 'item-a3'),
    { ...alice[0]!, messageId: 'item-a4', roomId: 'room-4', text: 'Missed while offline?' }];
  record('5 deltas lost, before the gap signal', { badge: 2, list: 2 });
  proof.__emit({ type: 'invalidate', reason: 'needs-you-gap' });
  await pause(500);
  record('6 needs-you-gap reload', { badge: 2, list: 2 });

  setTrayOpen(false);
  await pause();
  record('7 tray closed as alice', { badge: 2 });
  proof.__server.countDelayMs = 400;
  proof.__switchViewer('bob');
  // Let React render the reset before reading; the DOM before that is never painted.
  await pause(0);
  const seen = new Set<number>();
  for (let tick = 0; tick < 12; tick += 1) {
    seen.add(badge());
    await pause(50);
  }
  seen.add(badge());
  steps.push(`8 badge values while bob's count loads: ${[...seen].join(',')}`);
  if (seen.has(2)) failures.push("the badge showed alice's 2 after the switch");
  record('9 switched to bob, tray closed', { badge: 1 });
  setTrayOpen(true);
  await pause(500);
  record('10 tray open as bob', { badge: 1, list: 1 });

  report(`${failures.length ? 'FAIL' : 'PASS'} ${[...failures, ...steps].join(' | ')}`);
}

run().catch((error) => report(`FAIL ${String(error)} | ${steps.join(' | ')}`));
