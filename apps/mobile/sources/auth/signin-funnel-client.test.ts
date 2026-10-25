import { expect, it, vi } from 'vitest';
import { createSigninFunnelClient } from '../../../../packages/api-contract/src/signin-funnel-client';
import {
  parseSigninFunnelEvent,
  type SigninFunnelEvent,
} from '../../../../packages/api-contract/src/signin-funnel';
function setup(
  platform: SigninFunnelEvent['platform'] = 'ios',
  environment: SigninFunnelEvent['environment'] = 'production',
) {
  const items = new Map<string, string>(),
    send = vi.fn(async (_event: SigninFunnelEvent, _authorization?: string) => {});
  let id = 0,
    time = Date.now();
  const input = {
    storage: {
      getItem: async (k: string) => items.get(k) ?? null,
      setItem: async (k: string, v: string) => {
        items.set(k, v);
      },
    },
    uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    platform,
    version: '0.2.22',
    environment,
    send,
    now: () => time,
  };
  return {
    client: createSigninFunnelClient(input),
    send,
    items,
    input,
    advance: () => (time += 31 * 60_000),
  };
}
it.each(['ios', 'android', 'web', 'macos', 'windows', 'linux'] as const)(
  'sends each action step once with no personal fields on %s',
  async (platform) => {
    const { client, send } = setup(platform);
    await client.opened(false);
    await client.opened(false);
    await client.screen();
    await client.screen();
    const attempt = await client.begin('github');
    await client.callback('success');
    await client.callback('success');
    await client.signedIn('private-session');
    await client.signedIn('private-session');
    await client.activation('workspace_created', 'private-session');
    await client.activation('first_message_sent', 'private-session');
    await client.activation('first_message_sent', 'private-session');
    expect(send.mock.calls.map((c) => (c[0] as SigninFunnelEvent).event)).toEqual([
      'app_opened',
      'signin_screen_shown',
      'provider_tapped',
      'callback_result',
      'signed_in',
      'workspace_created',
      'first_message_sent',
    ]);
    for (const call of send.mock.calls) {
      const event = call[0] as SigninFunnelEvent;
      expect(event.platform).toBe(platform);
      expect(parseSigninFunnelEvent(event)).not.toBeNull();
      expect(JSON.stringify(event)).not.toContain('private-session');
      expect(
        Object.keys(event).every((k) =>
          [
            'event',
            'installId',
            'attemptId',
            'platform',
            'version',
            'environment',
            'provider',
            'outcome',
            'errorCode',
            'timestamp',
          ].includes(k),
        ),
      ).toBe(true);
    }
    expect((send.mock.calls.at(-1) as unknown[])[1]).toBe('private-session');
    expect(attempt?.attemptId).not.toBe(attempt?.installId);
    const before = send.mock.calls.length;
    await client.opened(true, true);
    expect(send).toHaveBeenCalledTimes(before);
    await client.opened(false, true);
    expect(send).toHaveBeenCalledTimes(before + 1);
  },
);
it('persists install and attempt across a callback reload, deduplicates outcomes, and expires old attempts', async () => {
  const { client, send, input, advance } = setup();
  await client.opened(false);
  const attempt = await client.begin('google');
  const reloaded = createSigninFunnelClient(input);
  expect((await reloaded.pending())?.installId).toBe(attempt?.installId);
  await reloaded.callback('cancelled');
  await client.callback('error', 'unknown');
  expect(
    send.mock.calls.filter((c) => (c[0] as SigninFunnelEvent).event === 'callback_result'),
  ).toHaveLength(1);
  advance();
  expect(await reloaded.pending()).toBeUndefined();
});
it.each(['development', 'preview', 'lab', 'review'] as const)(
  'drops %s events',
  async (environment) => {
    const { client, send } = setup('android', environment);
    await client.opened(false);
    await client.screen();
    await client.begin('github');
    await client.callback('error', 'unknown');
    await client.signedIn('auth');
    expect(send).not.toHaveBeenCalled();
  },
);
it('suppresses review flow, and measurement failure never interrupts sign-in', async () => {
  const { client, send } = setup();
  client.suppress();
  await client.screen();
  expect(await client.begin('github')).toBeUndefined();
  expect(send).not.toHaveBeenCalled();
  const other = setup();
  other.send.mockRejectedValue(new Error('offline'));
  await expect(other.client.begin('github')).resolves.toBeDefined();
});
it('rejects corrupted stored context containing personal fields before any callback or URL context leaves the device', async () => {
  const { client, items, send } = setup();
  await client.begin('github');
  send.mockClear();
  const key = 'beeline.funnel.attempt.v1';
  const pending = JSON.parse(items.get(key)!);
  pending.context.email = 'private@example.com';
  items.set(key, JSON.stringify(pending));
  expect(await client.pending()).toBeUndefined();
  await client.callback('success');
  await client.signedIn('session');
  expect(send).not.toHaveBeenCalled();
});

it('keeps activation attribution after sign-in across a later session and sends each milestone once', async () => {
  const { client, input, send, advance } = setup();
  const attempt = await client.begin('google');
  await client.signedIn('session');
  advance();
  const reloaded = createSigninFunnelClient(input);
  await reloaded.activation('workspace_created', 'session');
  await reloaded.activation('first_message_sent', 'session');
  const again = createSigninFunnelClient(input);
  await again.activation('first_message_sent', 'session');
  const milestones = send.mock.calls.map(([event]) => event).filter(event => ['workspace_created', 'first_message_sent'].includes(event.event));
  expect(milestones.map(event => event.event)).toEqual(['workspace_created', 'first_message_sent']);
  expect(milestones.every(event => event.attemptId === attempt?.attemptId)).toBe(true);
});

it('sends each screen change in the 10 minutes after sign-in, including revisits, and none after', async () => {
  const { input, send } = setup();
  let time = Date.now();
  input.now = () => time;
  const timed = createSigninFunnelClient(input);
  const auth = async () => 'session';
  await timed.screenShown('beeline/tray', auth);
  expect(send).not.toHaveBeenCalled();
  const attempt = await timed.begin('github');
  await timed.signedIn('session');
  send.mockClear();
  await timed.screenShown('beeline/tray', auth);
  // Re-rendering the same screen is not a change.
  await timed.screenShown('beeline/tray', auth);
  time += 9 * 60_000;
  await createSigninFunnelClient(input).screenShown('beeline/chat/[channelId]', auth);
  // A revisit after a reload still counts as the latest screen.
  await createSigninFunnelClient(input).screenShown('beeline/tray', auth);
  expect(send.mock.calls.map(([event]) => [event.event, event.screen])).toEqual([
    ['screen_shown', 'beeline/tray'],
    ['screen_shown', 'beeline/chat/[channelId]'],
    ['screen_shown', 'beeline/tray'],
  ]);
  for (const [event, authorization] of send.mock.calls) {
    expect(parseSigninFunnelEvent(event)).not.toBeNull();
    expect(event.attemptId).toBe(attempt?.attemptId);
    expect(authorization).toBe('session');
  }
  time += 60_000;
  await timed.screenShown('beeline/settings', auth);
  await createSigninFunnelClient(input).screenShown('beeline/members', auth);
  expect(send).toHaveBeenCalledTimes(3);
});
it('caps screen sends in one first session', async () => {
  const { client, send } = setup();
  await client.begin('github');
  await client.signedIn('session');
  send.mockClear();
  for (let i = 0; i < 40; i++) {
    await client.screenShown('beeline/tray', async () => 'session');
    await client.screenShown('beeline/channels', async () => 'session');
  }
  expect(send).toHaveBeenCalledTimes(64);
});
it('sends no screen event without a session', async () => {
  const { client, send } = setup();
  await client.begin('github');
  await client.signedIn('session');
  send.mockClear();
  await client.screenShown('beeline/tray', async () => undefined);
  await client.screenShown('beeline/tray', async () => { throw new Error('signed out'); });
  expect(send).not.toHaveBeenCalled();
  await client.screenShown('beeline/tray', async () => 'session');
  expect(send).toHaveBeenCalledTimes(1);
});
it('stamps screen changes with strictly increasing device times, even within one millisecond', async () => {
  const { client, send } = setup();
  await client.begin('github');
  await client.signedIn('session');
  send.mockClear();
  for (const screen of ['beeline/tray', 'beeline/chat/[channelId]', 'beeline/tray'] as const)
    await client.screenShown(screen, async () => 'session');
  const times = send.mock.calls.map(([event]) => Date.parse(event.timestamp));
  expect(times).toHaveLength(3);
  expect(times[0]! < times[1]! && times[1]! < times[2]!).toBe(true);
});
