import { afterEach, expect, it, vi } from 'vitest';
import { Room, ConnectionErrorReason } from 'livekit-client';
import { createRequire } from 'node:module';

const CommonJSRoom = createRequire(import.meta.url)('livekit-client').Room as typeof Room;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  ['ESM cancellation', Room, false],
  ['CommonJS cancellation', CommonJSRoom, false],
  ['ESM timeout', Room, true],
  ['CommonJS timeout', CommonJSRoom, true],
  ['ESM cancellation without AbortSignal.reason', Room, false, true],
  ['CommonJS cancellation without AbortSignal.reason', CommonJSRoom, false, true],
] as const)('%s works without a global Event', async (_name, RoomConstructor, timeout, legacySignal) => {
  vi.useFakeTimers();
  let socketCreated!: () => void;
  const ready = new Promise<void>(resolve => { socketCreated = resolve; });
  vi.stubGlobal('WebSocket', class {
    static CLOSED = 3;
    readyState = 0;
    constructor() { socketCreated(); }
    addEventListener() {}
    removeEventListener() {}
    close() { this.readyState = 3; }
  });
  const room = new RoomConstructor();
  // Exercise the distributed SDK used by Metro, including its real abort listener.
  const client = (room as unknown as { engine: { client: {
    join(...args: unknown[]): Promise<unknown>;
  } } }).engine.client;
  const controller = new AbortController();
  if (legacySignal) Object.defineProperty(controller.signal, 'reason', { value: undefined });
  let abortResult: Promise<unknown> | undefined;
  const add = controller.signal.addEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((type: string, listener: (event: Event) => unknown) => {
    add(type, event => {
      abortResult = Promise.resolve(listener(event));
      void abortResult.catch(() => {});
    });
  }) as typeof controller.signal.addEventListener;
  vi.stubGlobal('Event', undefined);
  Reflect.deleteProperty(globalThis, 'Event');
  const result = client.join('ws://localhost:7880', 'fixture-token', {
    autoSubscribe: true, maxRetries: 0, e2eeEnabled: false,
    websocketTimeout: 1000, singlePeerConnection: false,
  }, controller.signal, true).catch(error => error);
  await ready;
  if (timeout) {
    await vi.advanceTimersByTimeAsync(1000);
  } else {
    controller.abort('user left the call');
    await abortResult;
  }
  const error = await result;
  expect(error).toMatchObject({ reason: timeout ? ConnectionErrorReason.Timeout : ConnectionErrorReason.Cancelled });
  expect(error.message).toContain(timeout ? 'room connection has timed out' : legacySignal ? 'Abort handler called' : 'user left the call');
  expect(globalThis.Event).toBeUndefined();
});
