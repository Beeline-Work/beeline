/**
 * A minimal stand-in for Squire's own shared MCP socket
 * (`bot/broker/mcp-socket.js` `listenSharedMcp`): real Unix sockets, no
 * mocked framing. Speaks exactly the wire protocol `runSquireBrokerLink`
 * (`squire-broker-link.ts`) and Squire's own `dist/relay.js` both expect —
 * one identity line, then newline-delimited JSON-RPC — so a test can stand
 * in for a real broker without starting one. Test-only.
 */
import { createServer, type Server, type Socket } from 'node:net';

export type FakeMcpBroker = {
  readonly server: Server;
  readonly sockets: Set<Socket>;
  /** Drop every live connection without closing the listener — a mid-session hiccup. */
  dropConnections(): void;
};

function respond(socket: Socket, id: unknown, method: string): void {
  if (method === 'initialize') {
    socket.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp-broker', version: '0.0.0' },
        },
      })}\n`,
    );
    return;
  }
  if (method === 'tools/list') {
    socket.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [{ name: 'operate_start' }] } })}\n`,
    );
    return;
  }
  if (id !== undefined) socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: {} })}\n`);
}

/** Bind and start listening on `path`; resolves once accepting connections. */
export async function startFakeMcpBroker(path: string): Promise<FakeMcpBroker> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = Buffer.alloc(0);
    let gotIdentity = false;
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf(10);
        if (end < 0) return;
        const line = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 1);
        if (!gotIdentity) {
          gotIdentity = true;
          continue;
        }
        let frame: { id?: unknown; method?: string };
        try {
          frame = JSON.parse(line) as { id?: unknown; method?: string };
        } catch {
          continue;
        }
        if (frame.method) respond(socket, frame.id, frame.method);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  return {
    server,
    sockets,
    dropConnections: () => {
      for (const socket of sockets) socket.destroy();
    },
  };
}

export async function stopFakeMcpBroker(broker: FakeMcpBroker): Promise<void> {
  broker.dropConnections();
  await new Promise<void>((resolve) => broker.server.close(() => resolve()));
}
