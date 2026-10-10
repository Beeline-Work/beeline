import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';

/**
 * Paints the real Room route (`beeline/chat/[channelId]`) opened from a
 * notification whose message is not in the Room's tail, then reports what the
 * reader sees while the read around that message is pending and after it
 * answers or fails. The shimmed RoomViewClient parks `historyAround` on
 * `globalThis.__around`; `?mode=` decides what happens to it:
 *   stall   — never answers
 *   answer  — answers once the room is on screen
 *   missing — rejects with a 404 once the room is on screen
 *   landed-then-missing — answers, then a second tap names a message the
 *     server answers with a 404
 *   warm — the Room is open with no notification (`?warm=1`); then a tap
 *     names `?target=`, and any read around it answers at once
 *   warm-retap — `warm`, then the reader returns to the newest rows and a
 *     second tap with a new response id names the same target
 *   cold — the tap opens the Room on `?target=`; reads answer at once
 *   first   — the target is the Room's first message: answers with it and
 *     fewer newer rows than one screen, and `historyAfter` serves the rest
 * `?cache=1` paints a saved Room response first; `?roomDelay=` delays the
 * Room read by that many ms. `?deep=1` serves a Room whose target is 40
 * messages back (see the test's fixture).
 */
type Around = {
  calls: number;
  pending: { resolve(value: unknown): void; reject(error: unknown): void }[];
  page: unknown;
  firstPage: unknown;
  serveNewer: boolean;
  afterCalls: number;
  makeMissing(): unknown;
};
const around = () => (globalThis as unknown as { __around: Around }).__around;
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (text: string) => {
  document.getElementById('result')!.textContent = text;
};
const list = () => document.querySelector<HTMLElement>('[data-testid="chat-messages"]');
const leaves = (root: Element | null) =>
  Array.from(root?.querySelectorAll<HTMLElement>('*') ?? []).filter(
    (node) => node.childElementCount === 0 && node.textContent?.trim(),
  );
const pageHasText = (text: string) =>
  leaves(document.getElementById('root')).some((node) => node.textContent!.includes(text));

/** Transcript rows (by their fixture text) whose box intersects the list's viewport, top to bottom. */
function visibleRows() {
  const viewport = list()?.getBoundingClientRect();
  if (!viewport) return [];
  const top = Math.max(viewport.top, 0);
  const bottom = Math.min(viewport.bottom, innerHeight);
  return leaves(list())
    .filter((node) =>
      /^(Tail|Around) message \d+$|^TARGET MESSAGE$|^Ann deleted a message$/.test(
        node.textContent!.trim(),
      ),
    )
    .map((node) => ({ text: node.textContent!.trim(), box: node.getBoundingClientRect() }))
    .filter(({ box }) => box.bottom > top && box.top < bottom && box.height > 0)
    .sort((a, b) => a.box.top - b.box.top)
    .map(({ text }) => text);
}

function composer() {
  const host = document.querySelector<HTMLElement>('[data-testid^="chat-composer"]');
  const field =
    (host?.matches('textarea, input') ? host : null) ??
    host?.querySelector<HTMLTextAreaElement>('textarea, input') ??
    document.querySelector<HTMLTextAreaElement>(
      '[data-testid^="chat-composer"] textarea, textarea[data-testid^="chat-composer"]',
    );
  return field as HTMLTextAreaElement | HTMLInputElement | null;
}

async function typeIntoComposer(text: string) {
  const field = composer();
  if (!field) return { present: false, typed: null as string | null };
  const proto = Object.getPrototypeOf(field) as object;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, text);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await pause();
  return { present: true, typed: composer()?.value ?? null };
}

const targetText = new URLSearchParams(location.search).get('targetText') ?? 'TARGET MESSAGE';

function target() {
  const viewport = list()?.getBoundingClientRect();
  const node = leaves(list()).find((leaf) => leaf.textContent!.trim() === targetText);
  if (!node || !viewport)
    return {
      present: Boolean(node),
      flashed: false,
      flashColor: null,
      flashOpacity: null,
      top: null,
      textTop: null,
    };
  // The row's ground is the nearest ancestor that holds the flash fill.
  let row: HTMLElement | null = node;
  let flash: HTMLElement | null = null;
  while (row && row !== list()) {
    flash = row.querySelector<HTMLElement>(':scope > [data-testid="arrival-flash-ground"]');
    if (flash) break;
    row = row.parentElement;
  }
  const box = (flash ? row! : node).getBoundingClientRect();
  const fill = flash ? getComputedStyle(flash) : null;
  const flashOpacity = fill ? Number(fill.opacity) : null;
  return {
    present: true,
    // The fill is mounted for the whole cycle; it shows only while opaque.
    flashed: Boolean(
      fill && flashOpacity! > 0 && !/^rgba\(.*,\s*0\)$|transparent/.test(fill.backgroundColor),
    ),
    flashColor: fill?.backgroundColor ?? null,
    flashOpacity,
    top: Math.round(box.top - viewport.top),
    textTop: Math.round(node.getBoundingClientRect().top - viewport.top),
  };
}

/** The list's scroll node: where it sits and how far it could move. */
function scrollState() {
  const nodes = [list(), ...Array.from(list()?.querySelectorAll<HTMLElement>('*') ?? [])].filter(
    (node): node is HTMLElement =>
      Boolean(
        node &&
        node.scrollHeight > node.clientHeight + 1 &&
        /auto|scroll/.test(getComputedStyle(node).overflowY),
      ),
  );
  const node = nodes[0];
  return node
    ? {
        scrollTop: Math.round(node.scrollTop),
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        transform: getComputedStyle(node).transform,
      }
    : null;
}

function observe() {
  return {
    locating: pageHasText('Locating message'),
    noLongerAvailable: pageHasText('That message is no longer available'),
    rows: visibleRows(),
    composer: Boolean(composer()),
    target: target(),
    historyAroundCalls: around().calls,
    historyAfterCalls: around().afterCalls,
    scroll: scrollState(),
    listTop: Math.round(list()?.getBoundingClientRect().top ?? 0),
    listHeight: Math.round(list()?.getBoundingClientRect().height ?? 0),
    errors: (window as never as { __console: string[] }).__console.filter((line) =>
      line.startsWith('error'),
    ),
  };
}

async function waitFor(check: () => boolean, ms: number) {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await pause(50);
  return check();
}

/**
 * Headless Chrome under `--virtual-time-budget` never produces a frame, so
 * neither `requestAnimationFrame` nor `ResizeObserver` (react-native-web's
 * `onLayout`) ever fires. Stand in a timer-driven frame clock for both, the
 * way a device's display would drive them; nothing above the host changes.
 */
function installFrameClock() {
  const frames = new Map<number, ReturnType<typeof setTimeout>>();
  let next = 0;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    const handle = ++next;
    frames.set(
      handle,
      setTimeout(() => {
        frames.delete(handle);
        callback(performance.now());
      }, 16),
    );
    return handle;
  };
  globalThis.cancelAnimationFrame = (handle: number) => {
    clearTimeout(frames.get(handle));
    frames.delete(handle);
  };
  class FrameResizeObserver {
    private readonly sizes = new Map<Element, string>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(element: Element) {
      if (!this.sizes.has(element)) this.sizes.set(element, '');
      this.schedule();
    }
    unobserve(element: Element) {
      this.sizes.delete(element);
    }
    disconnect() {
      this.sizes.clear();
    }
    private schedule() {
      if (this.timer !== null) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        const entries: ResizeObserverEntry[] = [];
        for (const [element, previous] of this.sizes) {
          if (!element.isConnected) continue;
          const box = element.getBoundingClientRect();
          const size = `${box.width}x${box.height}`;
          if (size === previous) continue;
          this.sizes.set(element, size);
          entries.push({ target: element, contentRect: box } as unknown as ResizeObserverEntry);
        }
        if (entries.length) this.callback(entries, this as unknown as ResizeObserver);
        if (this.sizes.size) this.schedule();
      }, 16);
    }
  }
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = FrameResizeObserver;
}

async function run() {
  installFrameClock();
  const mode = new URLSearchParams(location.search).get('mode') ?? 'stall';
  // Metro gives the web bundle a `process.env`; expo-modules-core reads it at module scope.
  (globalThis as { process?: unknown }).process ??= {
    env: { NODE_ENV: 'development', EXPO_OS: 'web' },
  };
  const { default: BuzzChat } = await import('../sources/app/(app)/beeline/chat/[channelId]');
  // Expo's web shell gives the app root the window's height, as a phone screen does.
  const root = document.getElementById('root')!;
  root.style.cssText = 'height:100vh;display:flex;flex-direction:column;overflow:hidden';
  createRoot(root).render(<BuzzChat />);
  if (mode === 'warm' || mode === 'warm-retap' || mode === 'warm-edit' || mode === 'cold') {
    await warm(mode);
    return;
  }
  const shown = await waitFor(() => visibleRows().length > 0 && around().calls > 0, 4000);
  await pause(300);
  const pending = { ...observe(), shown };
  const typing = await typeIntoComposer('still typing');
  if (mode === 'stall') {
    report(JSON.stringify({ mode, pending, typing }));
    return;
  }
  if (mode === 'landed-then-missing') {
    around()
      .pending.splice(0)
      .forEach(({ resolve }) => resolve(around().page));
    await waitFor(() => target().flashed, 2000);
    await pause(1500);
    const landed = observe();
    const query = new URLSearchParams(location.search);
    (globalThis as unknown as { __setParams(next: unknown): void }).__setParams({
      channelId: query.get('room'),
      notificationResponseId: 'push-2',
      notificationMessageId: query.get('gone'),
    });
    await waitFor(() => around().calls > 1, 2000);
    around()
      .pending.splice(0)
      .forEach(({ reject }) => reject(around().makeMissing()));
    await waitFor(() => pageHasText('That message is no longer available'), 2000);
    await pause(500);
    report(JSON.stringify({ mode, pending, typing, landed, settled: observe() }));
    return;
  }
  if (mode === 'first') {
    around().serveNewer = true;
    around()
      .pending.splice(0)
      .forEach(({ resolve }) => resolve(around().firstPage));
    await waitFor(() => target().flashed, 2000);
    const settled = observe();
    await pause(3000);
    report(JSON.stringify({ mode, pending, typing, settled, later: observe() }));
    return;
  }
  if (mode === 'answer') around().pending.forEach(({ resolve }) => resolve(around().page));
  else around().pending.forEach(({ reject }) => reject(around().makeMissing()));
  if (mode === 'answer') await waitFor(() => target().flashed, 2000);
  else await waitFor(() => pageHasText('That message is no longer available'), 2000);
  const settled = observe();
  await pause(1500);
  const later = observe();
  report(
    JSON.stringify({
      mode,
      pending,
      typing,
      settled,
      later,
    }),
  );
}

/** A tap that opens the Room (`cold`), or that reaches a Room screen already open. */
async function warm(mode: string) {
  const query = new URLSearchParams(location.search);
  const setParams = (globalThis as unknown as { __setParams(next: unknown): void }).__setParams;
  const answerReads = () =>
    around()
      .pending.splice(0)
      .forEach(({ resolve }) => resolve(around().page));
  // The target's place and flash every 50 ms after the latest tap.
  let timeline: ReturnType<typeof target>[] = [];
  /** The server answers each read around the target as soon as it is asked. */
  const twoSecondsLater = async () => {
    timeline = [];
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      answerReads();
      timeline.push(target());
      await pause(50);
    }
    return observe();
  };
  const tap = (responseId: string) => {
    setParams({
      channelId: query.get('room'),
      notificationResponseId: responseId,
      notificationMessageId: query.get('target'),
    });
    return twoSecondsLater();
  };
  if (mode === 'cold') {
    const landed = await twoSecondsLater();
    const roomCalls = (globalThis as unknown as { __roomCalls?: number }).__roomCalls ?? 0;
    report(JSON.stringify({ mode, landed, roomCalls }));
    return;
  }
  const opened = await waitFor(() => visibleRows().length > 0, 4000);
  await pause(500);
  const beforeTap = { ...observe(), opened };
  const landed = await tap('push-1');
  if (mode === 'warm') {
    report(JSON.stringify({ mode, beforeTap, landed, timeline }));
    return;
  }
  if (mode === 'warm-edit') {
    // The landed row, rendered anywhere in the list, by its exact text.
    const rowText = (text: string) =>
      leaves(list()).some((node) => node.textContent!.trim() === text);
    const before = await waitFor(() => rowText(targetText), 4000);
    // Another client edits the landed message; the server sends its row.
    const emit = (globalThis as unknown as { __emit(event: unknown): void }).__emit;
    const room = query.get('room')!;
    const messageId = query.get('target')!;
    emit({
      monolithLive: {
        type: 'message-delta',
        roomId: room,
        message: {
          id: messageId,
          text: 'TARGET MESSAGE (edited)',
          createdAt: Number(query.get('targetAt')),
          author: JSON.parse(query.get('author')!),
          presentation: 'message',
          reference: { channelId: room, eventId: messageId, rootId: messageId },
        },
      },
    });
    const after = await waitFor(() => rowText('TARGET MESSAGE (edited)'), 2000);
    report(
      JSON.stringify({ mode, beforeTap, landed, edit: { before, after, stale: rowText(targetText) } }),
    );
    return;
  }
  // The reader scrolls back down to the newest rows. The inverted list's
  // newest end is its scroll offset 0.
  const scrollNode = [list(), ...Array.from(list()?.querySelectorAll<HTMLElement>('*') ?? [])].find(
    (node): node is HTMLElement =>
      Boolean(
        node &&
        node.scrollHeight > node.clientHeight + 1 &&
        /auto|scroll/.test(getComputedStyle(node).overflowY),
      ),
  );
  for (let step = 0; step < 20 && !visibleRows().includes('Tail message 29'); step += 1) {
    scrollNode?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 400 }));
    if (scrollNode) scrollNode.scrollTop = 0;
    scrollNode?.dispatchEvent(new Event('scroll'));
    await pause(150);
  }
  await pause(500);
  const atNewest = observe();
  const relanded = await tap('push-2');
  report(JSON.stringify({ mode, beforeTap, landed, atNewest, relanded }));
}

run().catch((error: unknown) =>
  report(`ERROR ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`),
);
