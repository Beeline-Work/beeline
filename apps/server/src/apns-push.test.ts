import { generateKeyPairSync } from 'node:crypto';
import { connect, createServer, type Http2Server } from 'node:http2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApnsPushProvider,
  apnsPushRequest,
  buildApnsProviderToken,
  classifyApnsResponse,
  createApnsPushSender,
} from './apns-push.js';

function privateKey(): string {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString();
}

function decodePart(token: string, index: number): unknown {
  return JSON.parse(Buffer.from(token.split('.')[index]!, 'base64url').toString('utf8'));
}

async function listen(server: Http2Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake APNs server did not listen');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(() => vi.useRealTimers());

describe('APNs provider token and request', () => {
  it('builds an ES256 provider JWT with the required claims', () => {
    const token = buildApnsProviderToken('KEY123', 'TEAM123', privateKey(), 1_789_000_000);
    expect(token.split('.')).toHaveLength(3);
    expect(decodePart(token, 0)).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(decodePart(token, 1)).toEqual({ iss: 'TEAM123', iat: 1_789_000_000 });
    expect(Buffer.from(token.split('.')[2]!, 'base64url')).toHaveLength(64);
  });

  it('builds APNs headers and a routing payload matching Firebase custom data', () => {
    const request = apnsPushRequest(
      'device/token',
      {
        messageId: 'message-1',
        workspaceId: 'workspace-1',
        roomId: 'room-1',
        channelId: 'corner-1',
        cornerId: 'corner-1',
        target: 'corner',
        type: 'message',
        text: 'hello',
      },
      'app.usebeeline.mobile',
      'provider-token',
    );

    expect(request.headers).toMatchObject({
      ':method': 'POST',
      ':path': '/3/device/device%2Ftoken',
      authorization: 'bearer provider-token',
      'apns-topic': 'app.usebeeline.mobile',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': '0',
      'apns-collapse-id': 'room-1',
    });
    expect(request.payload).toEqual({
      aps: {
        alert: { title: 'Beeline', body: 'hello' },
        sound: 'default',
        'thread-id': 'room-1',
      },
      type: 'channel-activity',
      target: 'corner',
      workspaceId: 'workspace-1',
      roomId: 'room-1',
      channelId: 'corner-1',
      cornerId: 'corner-1',
      threadId: 'room-1',
      messageId: 'message-1',
    });
  });

  it('names the inline-action category so iOS offers Reply or the grant choices', () => {
    const request = apnsPushRequest(
      'device-token',
      {
        messageId: 'message-1',
        workspaceId: 'workspace-1',
        roomId: 'dm-1',
        channelId: 'dm-1',
        target: 'message',
        type: 'message',
        text: 'Maya: are you there?',
        action: { kind: 'reply', authorName: 'Maya' },
      },
      'app.usebeeline.mobile',
      'provider-token',
    );
    expect(request.payload).toMatchObject({
      aps: { category: 'beeline-reply' },
      categoryId: 'beeline-reply',
      authorName: 'Maya',
    });
  });

  it.each([
    [200, '', 'success'],
    [400, 'BadDeviceToken', 'unregistered'],
    [400, 'Unregistered', 'unregistered'],
    [410, 'Unregistered', 'unregistered'],
    [400, 'PayloadEmpty', 'permanent'],
    [429, 'TooManyRequests', 'retryable'],
    [500, 'InternalServerError', 'retryable'],
  ] as const)('classifies %s %s as %s', (status, reason, expected) => {
    expect(classifyApnsResponse(status, reason)).toBe(expected);
  });

  it('logs once and stays disabled when the APNs key is absent', () => {
    const log = vi.fn();
    expect(createApnsPushSender({}, log)).toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      '[push] iOS APNs delivery disabled: APNS_KEY_P8_BASE64 is not set',
    );
  });

  it('fails configuration immediately when a configured APNs key is unusable', () => {
    expect(() =>
      createApnsPushSender({
        APNS_KEY_ID: 'KEY123',
        APNS_KEY_P8_BASE64: Buffer.from('not a private key').toString('base64'),
      }),
    ).toThrow();
  });
});

describe('APNs HTTP/2 provider', () => {
  it('posts to an injected cleartext authority and refreshes its JWT after 50 minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
    const received: Array<{ authorization: string; body: unknown }> = [];
    const server = createServer();
    server.on('stream', (stream, headers) => {
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        body += chunk;
      });
      stream.on('end', () => {
        received.push({
          authorization: String(headers.authorization),
          body: JSON.parse(body),
        });
        stream.respond({ ':status': 200 });
        stream.end();
      });
    });
    const authority = await listen(server);
    const provider = new ApnsPushProvider({
      authority,
      bundleId: 'app.usebeeline.mobile',
      connect: (target) => connect(target),
      keyId: 'KEY123',
      privateKey: privateKey(),
      teamId: 'TEAM123',
    });
    const message = { messageId: 'test', type: 'test' as const, text: 'ready' };

    try {
      await provider.send('device-token', message);
      vi.advanceTimersByTime(49 * 60 * 1000);
      await provider.send('device-token', message);
      vi.advanceTimersByTime(2 * 60 * 1000);
      await provider.send('device-token', message);

      expect(received).toHaveLength(3);
      expect(received[0]!.body).toEqual({
        aps: { alert: { title: 'Beeline', body: 'ready' }, sound: 'default' },
        type: 'test',
      });
      expect(received[1]!.authorization).toBe(received[0]!.authorization);
      expect(received[2]!.authorization).not.toBe(received[0]!.authorization);
    } finally {
      provider.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
