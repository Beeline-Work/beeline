/** Optional Room reads share one gate, independent of diagnostic tracing. */
import { scheduleAnimationFrame } from './host-scheduler';

let pending: Promise<void> | undefined;
let release: (() => void) | undefined;
let generation = 0;
let awaitingResponse = false;
let expectedNewest: string | undefined;
let sawDraw = false;
let drawnNewest: string | undefined;
let roomId: string | undefined;
let visibleIds = new Set<string>();
let releaseScheduled = false;

export function beginRoomDraw(id?: string): void {
  generation += 1;
  awaitingResponse = false;
  expectedNewest = undefined;
  sawDraw = false;
  drawnNewest = undefined;
  roomId = id;
  visibleIds = new Set();
  releaseScheduled = false;
  if (!pending) pending = new Promise<void>(resolve => { release = resolve; });
}

export function ensureRoomDraw(id?: string): void {
  if (!pending || (id !== undefined && id !== roomId)) beginRoomDraw(id);
}

/** A stale cached transcript must not release work ahead of the tapped row. */
export function requireOpeningRoomResponse(visit = generation): void {
  if (visit === generation) awaitingResponse = true;
}
export function openingRoomResponseReady(newest?: string, visit = generation): void {
  if (visit !== generation) return;
  if (awaitingResponse) expectedNewest = newest;
  awaitingResponse = false;
  if (sawDraw) finishRoomDraw(drawnNewest);
}

/** A data-ready animation callback alone does not prove that the row mounted. */
export function observeVisibleRoomRows(id: string, ids: readonly string[]): void {
  if (!pending || (roomId !== undefined && roomId !== id)) return;
  visibleIds = new Set(ids);
  if (sawDraw) finishRoomDraw(drawnNewest);
}

export function roomDrawGeneration(): number { return generation; }
export function abandonRoomDraw(visit: number): void {
  if (visit !== generation) return;
  const resolve = release;
  pending = undefined;
  release = undefined;
  awaitingResponse = false;
  expectedNewest = undefined;
  resolve?.();
}

export function finishRoomDraw(newest?: string, id?: string): void {
  if (!pending || (id !== undefined && roomId !== id)) return;
  sawDraw = true;
  drawnNewest = newest;
  const ready = () => !awaitingResponse && (expectedNewest !== undefined
    ? visibleIds.has(expectedNewest) : drawnNewest === undefined || visibleIds.size > 0);
  if (releaseScheduled || !ready()) return;
  releaseScheduled = true;
  const current = generation;
  const finish = () => {
    if (current !== generation || !pending) return;
    if (!ready()) { releaseScheduled = false; return; }
    const resolve = release;
    pending = undefined;
    release = undefined;
    resolve?.();
  };
  // Visible rows establish readiness; leave a frame-commit margin without
  // waiting on interaction handles that can survive an interrupted transition.
  const committed = () => { globalThis.setTimeout(finish, 100); };
  if (!scheduleAnimationFrame(() => { if (!scheduleAnimationFrame(committed)) finish(); })) finish();
}

export function waitForRoomDraw(signal?: AbortSignal | null): Promise<void> | undefined {
  if (!pending) return;
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal?.removeEventListener('abort', abort);
      const error = new Error('The request was aborted.');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    void pending!.then(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    });
  });
}

export function isOptionalRoomRequest(input: string): boolean {
  const path = new URL(input).pathname;
  // Workspace discovery is required during cold sign-in; only the Room's
  // roster and list enrichment are optional.
  return /^\/v1\/phone\/workspaces\/[^/]+(?:\/chats)?$/.test(path) ||
    /^\/v1\/phone\/rooms\/[^/]+\/read$/.test(path) ||
    path === '/v1/phone/operations/readStarPrompt' ||
    path === '/v1/phone/observations/page-load';
}
