/** Optional Room reads share one gate, independent of diagnostic tracing. */
let pending: Promise<void> | undefined;
let release: (() => void) | undefined;
let generation = 0;
let awaitingResponse = false;
let expectedNewest: string | undefined;
let sawDraw = false;
let drawnNewest: string | undefined;

export function beginRoomDraw(): void {
  generation += 1;
  awaitingResponse = false;
  expectedNewest = undefined;
  sawDraw = false;
  drawnNewest = undefined;
  if (!pending) pending = new Promise<void>(resolve => { release = resolve; });
}

export function ensureRoomDraw(): void {
  if (!pending) beginRoomDraw();
}

/** A stale cached transcript must not release work ahead of the tapped row. */
export function requireOpeningRoomResponse(visit = generation): void {
  if (visit === generation) awaitingResponse = true;
}
export function openingRoomResponseReady(newest?: string, visit = generation): void {
  if (visit !== generation) return;
  awaitingResponse = false;
  expectedNewest = newest;
  if (sawDraw && (newest === undefined || drawnNewest === newest)) finishRoomDraw(drawnNewest);
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

export function finishRoomDraw(newest?: string): void {
  if (!pending) return;
  sawDraw = true;
  drawnNewest = newest;
  if (awaitingResponse || (expectedNewest !== undefined && newest !== expectedNewest)) return;
  const current = generation;
  const finish = () => {
    if (current !== generation) return;
    const resolve = release;
    pending = undefined;
    release = undefined;
    resolve?.();
  };
  // The Room's JS ready mark precedes native frame commitment. Leave two
  // further frames for that buffer before optional work competes with it.
  if (typeof requestAnimationFrame === 'function')
    requestAnimationFrame(() => requestAnimationFrame(finish));
  else finish();
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
    path === '/v1/phone/operations/readStarPrompt';
}
