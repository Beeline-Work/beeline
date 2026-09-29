import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runSquireBrokerLink, SQUIRE_RELAY_GIVE_UP_MS } from './squire-broker-link.js';
import {
  startFakeMcpBroker,
  stopFakeMcpBroker,
  type FakeMcpBroker,
} from './squire-broker-link.test-support.js';
import { SQUIRE_BROKER_UNAVAILABLE, TRUSTY_SQUIRE_BROKER_UNIT_NAME } from './squire-host.js';

// squire-broker-link.ts imports no `node:child_process` (grep it, or see its
// own docblock): every path in this suite is pure socket/stream code that
// cannot spawn anything by construction. The end-to-end proof that a real
// spawned façade process never touches `npx` lives in squire-host.test.ts's
// GREEN test, which spies on the actual PATH `npx` a façade would resolve.

const roots: string[] = [];
afterEach(async () => {
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

describe('runSquireBrokerLink', () => {
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

  it('reconnects across a mid-session broker restart, replaying initialize, and never spawns a process', async () => {
    const home = await scratch('beeline-squire-link-reconnect-');
    const path = join(home, 'mcp.sock');
    let broker: FakeMcpBroker = await startFakeMcpBroker(path);
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const linkPromise = runSquireBrokerLink({
        agentId: 'agent-a', socketPath: path, input, output, giveUpMs: 5_000,
      });

      writeLine(input, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      await readLine(output);
      writeLine(input, { jsonrpc: '2.0', method: 'notifications/initialized' });

      // Simulate the production incident: the broker dies mid-session (its
      // whole listener goes away, not just one connection) while systemd
      // restarts it — here, standing up a fresh listener on the same path a
      // little later, the way `trusty-squire-broker.service`'s
      // `RestartSec=5s` would.
      await stopFakeMcpBroker(broker);
      await new Promise((resolve) => setTimeout(resolve, 150));
      broker = await startFakeMcpBroker(path);

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

  it('gives up after the bound, names the broker unit, fails every pending and queued call, and never spawns a process', async () => {
    const home = await scratch('beeline-squire-link-giveup-');
    // Nothing ever listens here — the broker is genuinely gone for the
    // whole test, the way it was for the 292-restart-loop incident.
    const path = join(home, 'mcp.sock');
    const errors: string[] = [];
    const input = new PassThrough();
    const output = new PassThrough();
    const linkPromise = runSquireBrokerLink({
      agentId: 'agent-a', socketPath: path, input, output, giveUpMs: 150,
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
    writeLine(input, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const lateReply = await readLine(output);
    expect((lateReply.error as { message: string }).message).toMatch(/connection lost/);
  });

  it('defaults the give-up bound to the documented 10 seconds', () => {
    expect(SQUIRE_RELAY_GIVE_UP_MS).toBe(10_000);
  });
});
