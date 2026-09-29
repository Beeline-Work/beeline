import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('Chrome push service worker', () => {
  it('suppresses the open Room in a focused tab but shows background and other-Room pushes', async () => {
    const handlers = new Map<string, (event: any) => void>();
    const showNotification = vi.fn(async () => undefined);
    const client = {
      url: 'http://localhost:8082/beeline/chat/room-1',
      focused: true,
      visibilityState: 'visible',
      postMessage: (_message: unknown, ports: Array<{ reply: (value: unknown) => void }>) =>
        ports[0]!.reply({ channelId: 'room-1' }),
    };
    class FakeMessageChannel {
      port1 = { onmessage: null as null | ((event: { data: unknown }) => void), close: vi.fn() };
      port2 = { reply: (data: unknown) => this.port1.onmessage?.({ data }) };
    }
    const self = {
      location: { origin: 'http://localhost:8082' },
      registration: { showNotification },
      clients: { matchAll: vi.fn(async () => [client]) },
      addEventListener: (name: string, handler: (event: any) => void) =>
        handlers.set(name, handler),
    };
    runInNewContext(readFileSync(new URL('../../public/push-sw.js', import.meta.url), 'utf8'), {
      self,
      URL,
      MessageChannel: FakeMessageChannel,
      setTimeout,
      clearTimeout,
    });
    const push = async (channelId: string) => {
      let pending: Promise<unknown> = Promise.resolve();
      handlers.get('push')!({
        data: {
          json: () => ({
            body: 'Hello',
            channelId,
            roomId: channelId,
            url: `/beeline/chat/${channelId}`,
          }),
        },
        waitUntil: (promise: Promise<unknown>) => {
          pending = promise;
        },
      });
      await pending;
    };
    await push('room-1');
    expect(showNotification).not.toHaveBeenCalled();
    await push('room-2');
    expect(showNotification).toHaveBeenCalledTimes(1);
    client.focused = false;
    client.visibilityState = 'hidden';
    await push('room-1');
    expect(showNotification).toHaveBeenCalledTimes(2);
  });

  it('shows a notification for a message and opens its same-origin destination', async () => {
    const handlers = new Map<string, (event: any) => void>();
    const showNotification = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => undefined);
    const focus = vi.fn(async () => undefined);
    const client = { url: 'http://localhost:8082/beeline/channels', navigate, focus };
    const self = {
      location: { origin: 'http://localhost:8082' },
      registration: { showNotification },
      clients: { matchAll: vi.fn(async () => [client]), openWindow: vi.fn() },
      addEventListener: (name: string, handler: (event: any) => void) =>
        handlers.set(name, handler),
    };
    runInNewContext(readFileSync(new URL('../../public/push-sw.js', import.meta.url), 'utf8'), {
      self,
      URL,
      setTimeout,
      clearTimeout,
    });
    let pending: Promise<unknown> = Promise.resolve();
    handlers.get('push')!({
      data: {
        json: () => ({
          body: 'Test teammate: Hello',
          url: '/beeline/chat/room-1?communityId=workspace-1',
        }),
      },
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;
    expect(showNotification).toHaveBeenCalledWith(
      'Beeline',
      expect.objectContaining({
        body: 'Test teammate: Hello',
        data: { path: '/beeline/chat/room-1?communityId=workspace-1' },
      }),
    );
    const displayed = showNotification.mock.calls[0]![1];
    handlers.get('notificationclick')!({
      notification: { data: displayed.data, close: vi.fn() },
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;
    expect(navigate).toHaveBeenCalledWith(
      'http://localhost:8082/beeline/chat/room-1?communityId=workspace-1',
    );
    expect(focus).toHaveBeenCalledOnce();
  });
});
