import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateDaemonTransport,
  DaemonApiClient,
  DaemonApiError,
  type DaemonWebSocketFactory,
} from './daemon-api-client.js';
import {
  identityFromKey,
  readRuntimeRecord,
  writeRuntimeRecord,
  type AgentRuntimeRecord,
} from './runtime.js';

const roots: string[] = [];

function stored(name: string) {
  const identity = identityFromKey(undefined, name);
  return {
    name,
    secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
    publicKey: identity.publicKey,
  };
}

async function stagedRuntime(origin = 'http://127.0.0.1:43123') {
  const supervisorRoot = await mkdtemp(join(tmpdir(), 'beeline-daemon-api-'));
  roots.push(supervisorRoot);
  const runtime: AgentRuntimeRecord = {
    version: 2,
    communityId: '11111111-1111-4111-8111-111111111111',
    pairedBy: 'a'.repeat(64),
    agent: stored('agent'),
    body: stored('body'),
    rooms: [],
    supervisorRoot,
    transport: { kind: 'monolith', baseUrl: origin, exchangeToken: `bde_${'x'.repeat(43)}` },
    agentBinary: 'buzz-agent',
    mcpBinary: 'buzz-dev-mcp',
    createdAt: new Date(0).toISOString(),
  };
  const configPath = await writeRuntimeRecord(runtime);
  return { runtime, configPath };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DaemonApiClient', () => {
  class FakeWebSocket {
    static readonly OPEN = 1;
    static readonly instances: FakeWebSocket[] = [];
    readyState = 0;
    readonly sent: string[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    onclose?: () => void;

    constructor(
      readonly url: string,
      readonly protocols: string[],
    ) {
      FakeWebSocket.instances.push(this);
    }

    open(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }

    send(value: string): void {
      this.sent.push(value);
    }

    message(value: unknown): void {
      this.onmessage?.({ data: JSON.stringify(value) });
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  it('promotes a one-use exchange into a durable opaque token before operations run', async () => {
    const { runtime, configPath } = await stagedRuntime();
    const request = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/v1/auth/daemon/exchange')) {
        expect(init?.headers).toEqual({ 'content-type': 'application/json' });
        return Response.json({
          daemonToken: `bdt_${'y'.repeat(43)}`,
          agentId: runtime.agent.publicKey,
        });
      }
      expect(init?.headers).toEqual({
        authorization: `Bearer bdt_${'y'.repeat(43)}`,
        'content-type': 'application/json',
      });
      return Response.json({ workspaceIds: [runtime.communityId], rooms: [] });
    });

    const activated = await activateDaemonTransport(configPath, request);
    expect(activated).toBeDefined();
    await expect(
      activated!.client.execute('getDaemonBootstrap', { agentId: runtime.agent.publicKey }),
    ).resolves.toEqual({ workspaceIds: [runtime.communityId], rooms: [] });

    const persisted = await readRuntimeRecord(configPath);
    expect(persisted.transport).toEqual({
      kind: 'monolith',
      baseUrl: 'http://127.0.0.1:43123',
      daemonToken: `bdt_${'y'.repeat(43)}`,
    });
    expect(await readFile(configPath, 'utf8')).not.toContain('bde_');

    await activateDaemonTransport(configPath, request);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('fails closed on a token for another agent without consuming local state', async () => {
    const { configPath } = await stagedRuntime();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ daemonToken: `bdt_${'y'.repeat(43)}`, agentId: 'f'.repeat(64) }),
      );
    await expect(activateDaemonTransport(configPath, request)).rejects.toThrow(
      'invalid runtime identity',
    );
    expect((await readRuntimeRecord(configPath)).transport).toHaveProperty('exchangeToken');
  });

  it('rejects cross-agent operations locally and classifies retryable server failures', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: 'temporarily_unavailable' }, { status: 503 }));
    const client = new DaemonApiClient(
      'http://127.0.0.1:43123',
      `bdt_${'y'.repeat(43)}`,
      'b'.repeat(64),
      request,
    );
    await expect(
      client.execute('getAgentPresence', {
        agentId: 'c'.repeat(64),
        roomId: '22222222-2222-4222-8222-222222222222',
      }),
    ).rejects.toThrow('does not match');
    await expect(
      client.execute('getDaemonBootstrap', { agentId: 'b'.repeat(64) }),
    ).rejects.toMatchObject<Partial<DaemonApiError>>({ status: 503, retryable: true });
  });

  it('reconnects the one live socket by cursor and de-duplicates replayed ids', async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances.length = 0;
    const client = new DaemonApiClient(
      'http://127.0.0.1:43123',
      `bdt_${'y'.repeat(43)}`,
      'b'.repeat(64),
      fetch,
      ((url, protocols) => new FakeWebSocket(url, protocols)) as DaemonWebSocketFactory,
    );
    const delivered: string[] = [];
    const release = client.liveSubscribe('room-1', '1000,' + 'a'.repeat(64), (items) =>
      delivered.push(...items.map((item) => item.id)),
    );
    const first = FakeWebSocket.instances[0]!;
    first.open();
    expect(first.sent).toEqual([
      JSON.stringify({ type: 'subscribe', roomId: 'room-1', cursor: `1000,${'a'.repeat(64)}` }),
    ]);

    first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const second = FakeWebSocket.instances[1]!;
    second.open();
    expect(second.sent).toEqual(first.sent);
    const items = ['1', '2', '3'].map((id) => ({
      id,
      authorId: 'a',
      createdAt: 1,
      type: 'message',
      body: id,
      mentionIds: [],
      attachments: [],
    }));
    second.message({ type: 'inbox', roomId: 'room-1', cursor: `2000,${'b'.repeat(64)}`, items });
    second.message({ type: 'inbox', roomId: 'room-1', cursor: `2000,${'b'.repeat(64)}`, items });

    expect(delivered).toEqual(['1', '2', '3']);
    release();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('counts poll-only deliveries per Room after the push grace window', async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances.length = 0;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const client = new DaemonApiClient(
      'http://127.0.0.1:43123',
      `bdt_${'y'.repeat(43)}`,
      'b'.repeat(64),
      fetch,
      ((url, protocols) => new FakeWebSocket(url, protocols)) as DaemonWebSocketFactory,
    );
    const release = client.liveSubscribe('room-1');
    FakeWebSocket.instances[0]!.open();
    const item = {
      id: 'poll-only',
      authorId: 'a',
      createdAt: 1,
      type: 'message',
      body: 'hello',
      mentionIds: [],
      attachments: [],
    };
    client.notePolled('room-1', [item]);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(client.pushParityMissCount('room-1')).toBe(1);
    expect(info).toHaveBeenCalledWith('[thin-core] push parity room=room-1 poll_only=0');
    expect(warning).toHaveBeenCalledWith('[thin-core] push parity miss room=room-1 count=1');
    FakeWebSocket.instances[0]!.message({
      type: 'inbox',
      roomId: 'room-1',
      items: [item],
    });
    expect(client.pushParityMissCount('room-1')).toBe(0);
    release();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
