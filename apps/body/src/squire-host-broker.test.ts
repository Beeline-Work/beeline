import { EventEmitter, once } from 'node:events';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { SquireHostBroker, squireMcpProxyEntrypoint } from './squire-host-broker.js';
import { trustySquireHostEnv } from './trusty-squire-storage.js';

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

async function connectedBroker(allowedTools: string[]) {
  const child = new FakeSquireProcess();
  const broker = new SquireHostBroker(
    '/runtime/squire-config',
    () => child as unknown as ChildProcessWithoutNullStreams,
  );
  brokers.push(broker);
  const profile = await broker.mcpServer('room-1', new Set(allowedTools));
  const [, host, rawPort, token] = profile.args;
  const socket = connect({ host, port: Number(rawPort) });
  await once(socket, 'connect');
  socket.write(`${JSON.stringify({ token })}\n`);
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  return { broker, child, profile, socket };
}

describe('Trusty Squire host broker', () => {
  it('resolves the proxy beside source and bundled CLI entrypoints', () => {
    expect(squireMcpProxyEntrypoint('/workspace/apps/body/dist/cli.js')).toBe(
      '/workspace/apps/body/dist/squire-mcp-proxy.js',
    );
    expect(squireMcpProxyEntrypoint('/opt/beeline/lib/beeline/beeline-cli.mjs')).toBe(
      '/opt/beeline/lib/beeline/squire-mcp-proxy.mjs',
    );
  });

  it('never hands daemon push credentials to the credential process', () => {
    expect(
      trustySquireHostEnv(
        {
          HOME: '/home/operator',
          PATH: '/usr/bin',
          XDG_CONFIG_HOME: '/home/operator/alternate-config',
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
          GH_TOKEN: 'push-token',
          GITHUB_TOKEN: 'push-token',
          SSH_AUTH_SOCK: '/run/agent.sock',
        },
        '/runtime/squire-config',
      ),
    ).toEqual({
      HOME: '/home/operator',
      PATH: '/usr/bin',
      XDG_CONFIG_HOME: '/runtime/squire-config',
      TRUSTY_SQUIRE_SESSION_FILE: '1',
    });
  });

  it('keeps Squire host-side and forwards profile-selected tools as standing authority', async () => {
    const { child, profile, socket } = await connectedBroker([
      'list_app_access',
      'use_credential',
      'grant_app_access',
    ]);
    expect(profile.command).toBe(process.execPath);
    expect(profile.args).not.toContain('@trusty-squire/mcp@1.1.12');

    for (const [id, name] of [
      [1, 'use_credential'],
      [2, 'grant_app_access'],
    ] as const) {
      const forwarded = once(child.stdin, 'data');
      socket.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: { service: 'github' } },
        })}\n`,
      );
      const [bytes] = (await forwarded) as [Buffer];
      expect(JSON.parse(bytes.toString())).toMatchObject({ id, params: { name } });
    }
    socket.end();
  });

  it('filters inventory and refuses tools outside the selected standing profile', async () => {
    const { child, socket } = await connectedBroker(['list_credentials', 'use_credential']);
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    await once(child.stdin, 'data');
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            { name: 'use_credential' },
            { name: 'grant_app_access' },
            { name: 'revoke_app_access' },
          ],
        },
      })}\n`,
    );
    const [inventory] = (await once(socket, 'data')) as [Buffer];
    expect(JSON.parse(inventory.toString()).result.tools).toEqual([{ name: 'use_credential' }]);

    socket.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'grant_app_access', arguments: {} },
      })}\n`,
    );
    const [unselected] = (await once(socket, 'data')) as [Buffer];
    expect(JSON.parse(unselected.toString())).toHaveProperty(
      'error.message',
      'Trusty Squire tool is not enabled for this capability',
    );
    socket.end();
  });
});
