import { afterEach, expect, it, vi } from 'vitest';
import { abandonRoomDraw, beginRoomDraw, finishRoomDraw, isOptionalRoomRequest,
  configureRoomDrawScheduler, observeVisibleRoomRows, openingRoomResponseReady,
  requireOpeningRoomResponse, roomDrawGeneration, waitForRoomDraw } from './room-draw-barrier';

afterEach(() => {
  vi.unstubAllGlobals();
  abandonRoomDraw(roomDrawGeneration());
  configureRoomDrawScheduler((_visit, work) => work());
});

it('a failed opening response never releases work before a frame', async () => {
  beginRoomDraw();
  requireOpeningRoomResponse();
  const sent = vi.fn();
  const waiting = waitForRoomDraw()!.then(sent);
  openingRoomResponseReady(undefined);
  await Promise.resolve();
  expect(sent).not.toHaveBeenCalled();
  finishRoomDraw('cached-row');
  observeVisibleRoomRows('room', ['cached-row']);
  await waiting;
  expect(sent).toHaveBeenCalledOnce();
});

it('a failed read releases optional work after an already drawn cached frame', async () => {
  beginRoomDraw();
  requireOpeningRoomResponse();
  const waiting = waitForRoomDraw()!;
  finishRoomDraw('cached-row');
  observeVisibleRoomRows('room', ['cached-row']);
  openingRoomResponseReady(undefined);
  await waiting;
});

it('holds requests past a stale cached frame until the opening response draws', async () => {
  beginRoomDraw();
  requireOpeningRoomResponse();
  const sent = vi.fn();
  const waiting = waitForRoomDraw()!.then(sent);
  finishRoomDraw('old-row');
  observeVisibleRoomRows('room', ['old-row']);
  await Promise.resolve();
  expect(sent).not.toHaveBeenCalled();
  openingRoomResponseReady('new-row');
  finishRoomDraw('old-row');
  await Promise.resolve();
  expect(sent).not.toHaveBeenCalled();
  observeVisibleRoomRows('room', ['new-row']);
  finishRoomDraw('new-row');
  await waiting;
  expect(sent).toHaveBeenCalledOnce();
});

it('releases on leaving an unfinished open without releasing the next visit', async () => {
  beginRoomDraw();
  const oldVisit = roomDrawGeneration();
  beginRoomDraw();
  const sent = vi.fn();
  const waiting = waitForRoomDraw()!.then(sent);
  abandonRoomDraw(oldVisit);
  await Promise.resolve();
  expect(sent).not.toHaveBeenCalled();
  abandonRoomDraw(roomDrawGeneration());
  await waiting;
  expect(sent).toHaveBeenCalledOnce();
});

it('holds all optional requests until after the Room frame and releases together', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  beginRoomDraw();
  const sent: string[] = [];
  const paths = ['/v1/phone/operations/readStarPrompt', '/v1/phone/workspaces/workspace',
    '/v1/phone/workspaces/workspace/chats', '/v1/phone/rooms/room/read', '/v1/phone/observations/page-load'];
  const requests = paths.map(async path => {
    expect(isOptionalRoomRequest(`https://test${path}`)).toBe(true);
    await waitForRoomDraw();
    sent.push(path);
  });
  await Promise.resolve();
  expect(sent).toEqual([]);
  finishRoomDraw('row');
  expect(frames).toHaveLength(0);
  observeVisibleRoomRows('room', ['row']);
  frames.shift()!(0);
  await Promise.resolve();
  expect(sent).toEqual([]);
  frames.shift()!(16);
  await Promise.all(requests);
  expect(sent).toEqual(paths);
  expect(isOptionalRoomRequest('https://test/v1/phone/rooms/room')).toBe(false);
  expect(isOptionalRoomRequest('https://test/v1/phone/workspaces')).toBe(false);
  expect(isOptionalRoomRequest('https://test/v1/phone/operations/sendRoomMessage')).toBe(false);
});

it('requires the current Room viewport and waits for navigation before the commit margin', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  let settled: (() => void) | undefined;
  configureRoomDrawScheduler((_visit, work) => { settled = work; });
  beginRoomDraw('current');
  const sent = vi.fn();
  const waiting = waitForRoomDraw()!.then(sent);
  finishRoomDraw('row', 'previous');
  observeVisibleRoomRows('previous', ['row']);
  expect(settled).toBeUndefined();
  finishRoomDraw('row', 'current');
  expect(settled).toBeUndefined();
  observeVisibleRoomRows('current', ['row']);
  expect(settled).toBeTypeOf('function');
  expect(frames).toHaveLength(0);
  settled!();
  frames.shift()!(0);
  await Promise.resolve();
  expect(sent).not.toHaveBeenCalled();
  frames.shift()!(16);
  await waiting;
  expect(sent).toHaveBeenCalledOnce();
});

it('an old Room frame cannot release a newer open; aborted requests stop waiting', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  beginRoomDraw();
  finishRoomDraw();
  beginRoomDraw();
  const sent = vi.fn();
  const waiting = waitForRoomDraw()!.then(sent);
  frames.shift()!(0);
  frames.shift()!(16);
  await Promise.resolve();
  expect(sent).not.toHaveBeenCalled();
  const abort = new AbortController();
  const cancelled = waitForRoomDraw(abort.signal)!;
  abort.abort();
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  finishRoomDraw();
  frames.shift()!(32);
  frames.shift()!(48);
  await waiting;
  expect(sent).toHaveBeenCalledOnce();
});
