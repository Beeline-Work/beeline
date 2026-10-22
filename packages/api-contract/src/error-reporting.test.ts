import { expect, it } from 'vitest';
import { privateErrorEvent } from './error-reporting.js';

it('keeps actionable exception frames and removes user/request/content/credential data', () => {
  const event = privateErrorEvent({
    event_id: 'id', release: 'sha', platform: 'node',
    exception: { values: [{ type: 'Error', value: 'Failed https://provider.test/?secret=abc Bearer opaque user@example.com sk-secret',
      stacktrace: { frames: [{ filename: '/home/alice/repo/app.ts', function: 'serve', lineno: 42, colno: 8, in_app: true,
        vars: { password: 'private' }, context_line: 'sensitive source', pre_context: ['private'] }] } }] },
    user: { email: 'private@example.com', ip_address: '127.0.0.1' },
    request: { headers: { authorization: 'secret' }, data: 'chat text' },
    breadcrumbs: [{ message: 'conversation text' }], contexts: { device: { name: 'Alice phone' } },
    extra: { args: ['private'] }, tags: { surface: 'server', room_id: 'private', error_scope: 'voice-join' },
  });
  expect(event).toMatchObject({ event_id: 'id', release: 'sha', exception: { values: [{
    value: 'Failed [url] Bearer [redacted] [email] [token]',
    stacktrace: { frames: [{ filename: '[home]/repo/app.ts', function: 'serve', lineno: 42, colno: 8, in_app: true }] },
  }] }, tags: { surface: 'server', error_scope: 'voice-join' } });
  const encoded = JSON.stringify(event);
  for (const forbidden of ['private', 'opaque', 'chat text', 'sensitive source', 'Alice', '127.0.0.1', 'sk-secret', 'user@example.com']) {
    expect(encoded).not.toContain(forbidden);
  }
});

it('bounds messages, frame count, and ignores arbitrary nested extras', () => {
  const event = privateErrorEvent({ exception: { values: [{ type: 'Error', value: 'x'.repeat(8000),
    stacktrace: { frames: Array.from({ length: 100 }, () => ({ filename: 'app.js', vars: { content: 'private' } })) },
  }] }, tags: { error_scope: 'arbitrary user content' } });
  expect(event.exception.values[0]!.value).toHaveLength(2048);
  expect(event.exception.values[0]!.stacktrace.frames).toHaveLength(64);
  expect(event.tags).toEqual({});
});

it('R-SENTRY-REPEAT: suppresses numeric variants for a full rolling hour without extending on repeats', async () => {
  const { createErrorEventFilter } = await import('./error-reporting.js');
  let now = 0;
  const filter = createErrorEventFilter(() => now);
  const event = (pid: number) => ({ exception: { values: [{ type: 'Error', value: `previous runtime owner ${pid} still alive` }] } });
  expect(filter(event(695))).not.toBeNull();
  now = 3_599_999;
  expect(filter(event(901))).toBeNull();
  now = 3_600_000;
  expect(filter(event(902))).not.toBeNull();
  expect(filter(event(903))).toBeNull();
});

it('keeps different types and messages reportable and strips private data before admission', async () => {
  const { createErrorEventFilter } = await import('./error-reporting.js');
  const filter = createErrorEventFilter();
  const event = (type: string, value: string) => ({ exception: { values: [{ type, value }] }, user: { email: 'secret' } });
  expect(filter(event('Error', 'failure 12'))).toEqual(privateErrorEvent(event('Error', 'failure 12')));
  expect(filter(event('TypeError', 'failure 12'))).not.toBeNull();
  expect(filter(event('Error', 'another failure 12'))).not.toBeNull();
  expect(filter(event('Error', 'failure 34'))).toBeNull();
  expect(filter({ message: 'Bearer secret user@example.com' })).toMatchObject({ message: 'Bearer [redacted] [email]' });
  expect(filter({ message: 'Bearer other other@example.com' })).toBeNull();
});

it('caps novel errors at 100 per rolling hour with bounded state and independent instances', async () => {
  const { createErrorEventFilter } = await import('./error-reporting.js');
  let now = 0;
  const filter = createErrorEventFilter(() => now);
  const event = (index: number) => ({ message: `failure ${String.fromCharCode(1000 + index)}` });
  for (let index = 0; index < 100; index++) {
    now = index;
    expect(filter(event(index))).not.toBeNull();
  }
  expect(filter(event(100))).toBeNull();
  expect(createErrorEventFilter(() => now)(event(100))).not.toBeNull();
  now = 3_600_000;
  expect(filter(event(100))).not.toBeNull();
  expect(filter(event(101))).toBeNull();
  now++;
  expect(filter(event(101))).not.toBeNull();
});
