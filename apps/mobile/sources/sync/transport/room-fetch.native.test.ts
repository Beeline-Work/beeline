import { afterEach, expect, it, vi } from 'vitest';
import { fetchOpeningRoom } from './room-fetch.native';

let current: FakeXHR;
class FakeXHR {
  responseType = '';
  responseText = '{"messages":[{"id":"new"}]}';
  status = 200;
  statusText = 'OK';
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  ontimeout?: () => void;
  headers: Record<string, string> = {};
  constructor() { current = this; }
  open = vi.fn();
  setRequestHeader = (name: string, value: string) => { this.headers[name] = value; };
  getAllResponseHeaders = () => 'Content-Type: application/json\r\nServer-Timing: app;dur=8';
  send = vi.fn();
  abort = vi.fn(() => this.onabort?.());
}
afterEach(() => vi.unstubAllGlobals());

it('reads authorized Room JSON directly from text, retaining HTTP status and headers', async () => {
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  const pending = fetchOpeningRoom('https://server.test/v1/phone/rooms/room', {
    headers: { authorization: 'Bearer fixture' },
  });
  expect(current.responseType).toBe('text');
  expect(current.headers.authorization).toBe('Bearer fixture');
  current.status = 404;
  current.onload?.();
  const response = await pending;
  expect(response.status).toBe(404);
  expect(response.headers.get('server-timing')).toBe('app;dur=8');
  await expect(response.json()).resolves.toEqual({ messages: [{ id: 'new' }] });
});

it('aborts the native request when its session deadline expires', async () => {
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  const controller = new AbortController();
  const pending = fetchOpeningRoom('https://server.test/room', { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(current.abort).toHaveBeenCalledOnce();
});

it('does not send an already aborted request and reports native network failures', async () => {
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  const controller = new AbortController();
  controller.abort();
  await expect(fetchOpeningRoom('https://server.test/room', { signal: controller.signal }))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(current.send).not.toHaveBeenCalled();
  const pending = fetchOpeningRoom('https://server.test/room');
  current.onerror?.();
  await expect(pending).rejects.toThrow('Network request failed');
});
