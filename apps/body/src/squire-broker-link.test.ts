import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import type { Socket } from 'node:net';
import { runSquireBrokerLink } from './squire-broker-link.js';
import {
  startFakeMcpBroker,
  stopFakeMcpBroker,
} from './squire-broker-link.test-support.js';
import { SQUIRE_BROKER_UNAVAILABLE, TRUSTY_SQUIRE_BROKER_UNIT_NAME } from './squire-host.js';

// squire-broker-link.ts imports no `node:child_process` (grep it, or see its
// own docblock): every path in this suite is pure socket/stream code that
// cannot spawn anything by construction. The end-to-end proof that a real
// spawned façade process never touches `npx` lives in squire-host.test.ts's
// GREEN test, which spies on the actual PATH `npx` a façade would resolve.

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeLine(stream: PassThrough, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

async function readLine(stream: PassThrough): Promise<Record<string, unknown>> {
  return await new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end < 0) return;
      stream.off('data', onData);
      resolve(JSON.parse(buffer.subarray(0, end).toString('utf8')) as Record<string, unknown>);
    };
    stream.on('data', onData);
  });
}

class RelayPeer extends EventEmitter {
  readonly writes: string[] = [];
  private closed = false;

  write(value: string) {
    this.writes.push(value);
    return true;
  }

  destroy() {
    if (!this.closed) {
      this.closed = true;
      this.emit('close');
    }
    return this;
  }
}

describe('runSquireBrokerLink', () => {
  it('does not retry an initial refused connection across 24 idle hours', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const connect = vi.fn(() => {
      const peer = new RelayPeer();
      queueMicrotask(() => peer.destroy());
      return peer as unknown as Socket;
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const result = runSquireBrokerLink({ agentId: 'synthetic', socketPath: '/synthetic.sock',
      input, output, connect, logError: () => {}, onShutdownSignal: () => {} });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(await result).toEqual({ ok: false });
    expect(connect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('relays a real MCP session through the shared socket and never spawns a process', async () => {
    const home = await scratch('beeline-squire-link-ok-');
    const path = join(home, 'mcp.sock');
    const broker = await startFakeMcpBroker(path);
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const linkPromise = runSquireBrokerLink({ agentId: 'agent-a', socketPath: path, input, output });

      writeLine(input, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      const initReply = await readLine(output);
      expect((initReply.result as { serverInfo: { name: string } }).serverInfo.name).toBe('fake-mcp-broker');

      writeLine(input, { jsonrpc: '2.0', method: 'notifications/initialized' });
      writeLine(input, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const toolsReply = await readLine(output);
      expect((toolsReply.result as { tools: unknown[] }).tools).toHaveLength(1);

      input.end();
      const { ok } = await linkPromise;
      expect(ok).toBe(true);
    } finally {
      await stopFakeMcpBroker(broker);
    }
  });

  it('forwards an unsolicited broker notification such as approval_decided', async () => {
    const home = await scratch('beeline-squire-link-notify-');
    const path = join(home, 'mcp.sock');
    const broker = await startFakeMcpBroker(path);
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const linkPromise = runSquireBrokerLink({ agentId: 'agent-a', socketPath: path, input, output });
      writeLine(input, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      await readLine(output);
      writeLine(input, { jsonrpc: '2.0', method: 'notifications/initialized' });

      const notification = {
        jsonrpc: '2.0',
        method: 'notifications/approval_decided',
        params: { approval_id: 'fetch-1', status: 'approved' },
      };
      for (const socket of broker.sockets) socket.write(`${JSON.stringify(notification)}\n`);
      expect(await readLine(output)).toEqual(notification);

      input.end();
      expect((await linkPromise).ok).toBe(true);
    } finally {
      await stopFakeMcpBroker(broker);
    }
  });

  it('replaces one dropped connection, replaying only initialize, without spawning', async () => {
    const home = await scratch('beeline-squire-link-reconnect-');
    const path = join(home, 'mcp.sock');
    const broker = await startFakeMcpBroker(path);
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const linkPromise = runSquireBrokerLink({
        agentId: 'agent-a', socketPath: path, input, output,
      });

      writeLine(input, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      await readLine(output);
      writeLine(input, { jsonrpc: '2.0', method: 'notifications/initialized' });

      const replacement = once(broker.server, 'connection');
      broker.dropConnections();
      await replacement;

      writeLine(input, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const toolsReply = await readLine(output);
      expect((toolsReply.result as { tools: unknown[] }).tools).toHaveLength(1);

      input.end();
      const { ok } = await linkPromise;
      expect(ok).toBe(true);
    } finally {
      await stopFakeMcpBroker(broker);
    }
  }, 10_000);

  it('fails a refused initial connection and queued or late calls immediately', async () => {
    const home = await scratch('beeline-squire-link-giveup-');
    // Nothing ever listens here — the broker is genuinely gone for the
    // whole test, the way it was for the 292-restart-loop incident.
    const path = join(home, 'mcp.sock');
    const errors: string[] = [];
    const input = new PassThrough();
    const output = new PassThrough();
    const linkPromise = runSquireBrokerLink({
      agentId: 'agent-a', socketPath: path, input, output,
      logError: (message) => errors.push(message),
    });

    // Queued before any connection ever succeeds — must still fail, not hang.
    writeLine(input, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const failReply = await readLine(output);
    expect((failReply.error as { message: string }).message).toMatch(/connection lost/);

    const { ok } = await linkPromise;
    expect(ok).toBe(false);
    expect(errors.some((message) => message.includes(TRUSTY_SQUIRE_BROKER_UNIT_NAME))).toBe(true);
    expect(errors.some((message) => message.includes(SQUIRE_BROKER_UNAVAILABLE))).toBe(true);

    // A call arriving after give-up also fails immediately, not silently.
    const lateResponse = readLine(output);
    writeLine(input, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const lateReply = await lateResponse;
    expect((lateReply.error as { message: string }).message).toMatch(/connection lost/);
  });

  it.each([false, true])('spends one replacement without replaying calls (connected=%s)', async (replacementConnects) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const peers: RelayPeer[] = [];
    const connect = vi.fn(() => {
      const peer = new RelayPeer();
      peers.push(peer);
      return peer as unknown as Socket;
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const replies: Array<{ id: number; error?: { data: { outcome: string } } }> = [];
    output.on('data', (chunk: Buffer) => replies.push(JSON.parse(chunk.toString())));
    const result = runSquireBrokerLink({ agentId: 'synthetic', socketPath: '/synthetic.sock',
      input, output, connect, logError: () => {}, onShutdownSignal: () => {} });
    peers[0]!.emit('connect');
    writeLine(input, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    peers[0]!.emit('data', Buffer.from(' {"jsonrpc":"2.0","id":1,"result":{}}\n'));
    writeLine(input, { jsonrpc: '2.0', method: 'notifications/initialized' });
    writeLine(input, { jsonrpc: '2.0', id: 2, method: 'tools/call' });
    peers[0]!.destroy();
    expect(connect).toHaveBeenCalledTimes(2);
    peers[0]!.emit('data', Buffer.from('{"id":999,"result":{}}\n'));
    expect(replies.some((reply) => reply.id === 999)).toBe(false);
    expect(replies.find((reply) => reply.id === 2)?.error?.data.outcome).toBe('unknown');
    writeLine(input, { jsonrpc: '2.0', id: 3, method: 'tools/call' });
    if (replacementConnects) {
      peers[1]!.emit('connect');
      const replay = JSON.parse(peers[1]!.writes[1]!);
      expect(replay.method).toBe('initialize');
      peers[1]!.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: replay.id, result: {} })}\n`));
      expect(peers[1]!.writes.some((line) => line.includes('notifications/initialized'))).toBe(true);
    }
    peers[1]!.destroy();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(await result).toEqual({ ok: false });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(replies.find((reply) => reply.id === 3)?.error?.data.outcome).toBe(replacementConnects ? 'unknown' : 'not-sent');
    expect(peers[0]!.writes.filter((line) => line.includes('"id":2'))).toHaveLength(1);
    expect(peers[1]!.writes.some((line) => line.includes('"id":2'))).toBe(false);
  });
});
