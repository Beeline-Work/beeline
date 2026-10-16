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
