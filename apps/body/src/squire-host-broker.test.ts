import { EventEmitter, once } from 'node:events';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { squireArgumentsDigest } from './external-mcp-capabilities.js';
import { SquireHostBroker, squireHostEnv } from './squire-host-broker.js';

class FakeSquireProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(): boolean {
    this.emit('close', 0, null);
    return true;
  }
}

const brokers: SquireHostBroker[] = [];
afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});

describe('Trusty Squire host broker', () => {
  it('never hands daemon push credentials to the credential process', () => {
    expect(
      squireHostEnv({
        HOME: '/home/operator',
        PATH: '/usr/bin',
        GH_TOKEN: 'push-token',
        GITHUB_TOKEN: 'push-token',
        SSH_AUTH_SOCK: '/run/agent.sock',
      }),
    ).toEqual({ HOME: '/home/operator', PATH: '/usr/bin' });
  });

  it('keeps the credential process host-side and forwards only an exact authorized effect', async () => {
    const child = new FakeSquireProcess();
    const broker = new SquireHostBroker(() => child as unknown as ChildProcessWithoutNullStreams);
    brokers.push(broker);
    const profile = await broker.mcpServer('room-1');
    expect(profile.command).toBe(process.execPath);
    expect(profile.args).not.toContain('@trusty-squire/mcp@1.1.12');

    const [, host, rawPort, token] = profile.args;
    const socket = connect({ host, port: Number(rawPort) });
    await once(socket, 'connect');
    socket.write(`${JSON.stringify({ token })}\n`);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    const competing = connect({ host, port: Number(rawPort) });
    await once(competing, 'connect');
    competing.write(`${JSON.stringify({ token })}\n`);
    await once(competing, 'close');

    const args = {
      service: 'github',
      http: { method: 'GET', url: 'https://api.github.com/user' },
    };
    const request = (id: number, name = 'use_credential') =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      });
    socket.write(`${request(1)}\n`);
    const [rejection] = (await once(socket, 'data')) as [Buffer];
    expect(JSON.parse(rejection.toString())).toMatchObject({
      id: 1,
      error: { message: 'exact P1 factory permission is required' },
    });
    expect(child.stdin.readableLength).toBe(0);

    broker.authorize('room-1', 'grant_app_access', squireArgumentsDigest(args));
    socket.write(`${request(2)}\n`);
    const [substitution] = (await once(socket, 'data')) as [Buffer];
    expect(JSON.parse(substitution.toString())).toMatchObject({
      id: 2,
      error: { message: 'exact P1 factory permission is required' },
    });

    socket.write(`${request(3, 'grant_app_access')}\n`);
    const [forwarded] = (await once(child.stdin, 'data')) as [Buffer];
    expect(JSON.parse(forwarded.toString())).toMatchObject({
      id: 3,
      method: 'tools/call',
      params: { name: 'grant_app_access' },
    });
    socket.end();
  });

  it('expires and explicitly revokes unused authorizations', async () => {
    let now = 1_000;
    const child = new FakeSquireProcess();
    const broker = new SquireHostBroker(
      () => child as unknown as ChildProcessWithoutNullStreams,
      () => now,
    );
    brokers.push(broker);
    const profile = await broker.mcpServer('room-1');
    const [, host, rawPort, token] = profile.args;
    const socket = connect({ host, port: Number(rawPort) });
    await once(socket, 'connect');
    socket.write(`${JSON.stringify({ token })}\n`);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    const args = { grant_id: 'grant-1' };
    const digest = squireArgumentsDigest(args);
    const request = (id: number) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'revoke_app_access', arguments: args },
      });

    broker.authorize('room-1', 'revoke_app_access', digest, now + 10);
    now += 11;
    socket.write(`${request(1)}\n`);
    const [expired] = (await once(socket, 'data')) as [Buffer];
    expect(JSON.parse(expired.toString())).toHaveProperty(
      'error.message',
      'exact P1 factory permission is required',
    );

    const authorizationId = broker.authorize('room-1', 'revoke_app_access', digest);
    expect(authorizationId).toBeTruthy();
    broker.revoke('room-1', authorizationId!);
    socket.write(`${request(2)}\n`);
    const [revoked] = (await once(socket, 'data')) as [Buffer];
    expect(JSON.parse(revoked.toString())).toHaveProperty(
      'error.message',
      'exact P1 factory permission is required',
    );

    broker.authorize('room-1', 'revoke_app_access', digest);
    broker.revokeChannel('room-1');
    await once(socket, 'close');
  });
});
