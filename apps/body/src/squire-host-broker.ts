import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { McpServerWire } from './acp.js';
import {
  SQUIRE_GOVERNED_TOOLS,
  SQUIRE_MCP_PACKAGE,
  SQUIRE_READ_ONLY_TOOLS,
  squireArgumentsDigest,
} from './external-mcp-capabilities.js';

const MAX_MESSAGE_BYTES = 1024 * 1024;
export const SQUIRE_AUTHORIZATION_TTL_MS = 60_000;
const GOVERNED = new Set<string>(SQUIRE_GOVERNED_TOOLS);

interface BrokerChannel {
  token: string;
  endpoint?: McpServerWire;
  connection?: BrokerConnection;
}

interface BrokerConnection {
  socket: Socket;
  child: ChildProcessWithoutNullStreams;
  authorizations: Map<string, Array<{ id: string; expiresAt: number }>>;
}

type SpawnSquire = () => ChildProcessWithoutNullStreams;

const SQUIRE_HOST_ENV_ALLOWLIST = new Set([
  'HOME',
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'NODE_EXTRA_CA_CERTS',
]);

export function squireHostEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) => value !== undefined && SQUIRE_HOST_ENV_ALLOWLIST.has(name),
    ),
  );
}

export class SquireHostBroker {
  private server?: Server;
  private readonly channels = new Map<string, BrokerChannel>();
  private readonly children = new Set<ChildProcessWithoutNullStreams>();

  constructor(
    private readonly spawnSquire: SpawnSquire = () =>
      spawn('npx', ['-y', SQUIRE_MCP_PACKAGE, 'server'], {
        env: squireHostEnv(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    private readonly now: () => number = Date.now,
  ) {}

  authorize(
    channelId: string,
    tool: string,
    argumentsDigest: string,
    expiresAt = this.now() + SQUIRE_AUTHORIZATION_TTL_MS,
  ): string | undefined {
    const channel = this.channels.get(channelId);
    const authorizations = channel?.connection?.authorizations;
    if (!authorizations || expiresAt <= this.now()) return undefined;
    const key = this.authorizationKey(tool, argumentsDigest);
    const live = (authorizations.get(key) ?? []).filter(
      (authorization) => authorization.expiresAt > this.now(),
    );
    const id = randomBytes(24).toString('hex');
    live.push({ id, expiresAt });
    authorizations.set(key, live);
    return id;
  }

  revoke(channelId: string, authorizationId: string): void {
    const authorizations = this.channels.get(channelId)?.connection?.authorizations;
    if (!authorizations) return;
    for (const [key, entries] of authorizations) {
      const remaining = entries.filter((entry) => entry.id !== authorizationId);
      if (remaining.length) authorizations.set(key, remaining);
      else authorizations.delete(key);
    }
  }

  revokeAuthorizations(channelId: string): void {
    this.channels.get(channelId)?.connection?.authorizations.clear();
  }

  revokeChannel(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    this.revokeAuthorizations(channelId);
    this.channels.delete(channelId);
    channel.connection?.socket.destroy();
  }

  async mcpServer(channelId: string): Promise<McpServerWire> {
    const existing = this.channels.get(channelId);
    if (existing?.endpoint) return existing.endpoint;
    if (!this.server) {
      this.server = createServer((socket) => this.accept(socket));
      await new Promise<void>((resolvePromise, rejectPromise) => {
        this.server!.once('error', rejectPromise);
        this.server!.listen(0, '127.0.0.1', () => {
          this.server!.off('error', rejectPromise);
          this.server!.unref();
          resolvePromise();
        });
      });
    }
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Squire broker has no TCP endpoint');
    const channel =
      existing ??
      {
        token: randomBytes(32).toString('hex'),
      };
    const endpoint = {
      name: 'squire',
      command: process.execPath,
      args: [
        fileURLToPath(new URL('./squire-mcp-proxy.js', import.meta.url)),
        '127.0.0.1',
        String(address.port),
        channel.token,
      ],
      env: [],
    };
    channel.endpoint = endpoint;
    this.channels.set(channelId, channel);
    return endpoint;
  }

  private accept(socket: Socket): void {
    socket.setEncoding('utf8');
    let channel: BrokerChannel | undefined;
    let buffer = '';
    let connection: BrokerConnection | undefined;
    const close = () => {
      socket.destroy();
      connection?.child.kill('SIGTERM');
    };
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) return close();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!channel) {
          let token: unknown;
          try {
            token = (JSON.parse(line) as { token?: unknown }).token;
          } catch {
            return close();
          }
          if (typeof token !== 'string') return close();
          channel = [...this.channels.values()].find((candidate) =>
            this.matchesToken(token as string, candidate.token),
          );
          if (!channel || channel.connection) return close();
          const child = this.spawnSquire();
          connection = { socket, child, authorizations: new Map() };
          channel.connection = connection;
          channel.token = '';
          this.children.add(child);
          child.stdout.pipe(socket);
          child.stderr.on('data', (data) => process.stderr.write(data));
          child.once('close', () => {
            this.children.delete(child);
            socket.end();
          });
          child.once('error', close);
          continue;
        }
        if (connection && this.allowLine(line, socket, connection.authorizations)) {
          connection.child.stdin.write(`${line}\n`);
        }
      }
    });
    socket.once('close', () => {
      if (channel && channel.connection === connection) {
        channel.connection = undefined;
        channel.token = randomBytes(32).toString('hex');
        if (channel.endpoint?.args) channel.endpoint.args[channel.endpoint.args.length - 1] = channel.token;
      }
      if (connection) this.children.delete(connection.child);
      connection?.child.kill('SIGTERM');
    });
    socket.once('error', close);
  }

  private matchesToken(candidate: string, expected: string): boolean {
    const left = Buffer.from(candidate);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private allowLine(
    line: string,
    socket: Socket,
    authorizations: Map<string, Array<{ id: string; expiresAt: number }>>,
  ): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const message = parsed as Record<string, unknown>;
    if (message.method !== 'tools/call') return true;
    const params = message.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      this.reject(socket, message.id, 'invalid Trusty Squire tool request');
      return false;
    }
    const { name, arguments: args } = params as Record<string, unknown>;
    if (typeof name !== 'string') {
      this.reject(socket, message.id, 'invalid Trusty Squire tool name');
      return false;
    }
    if (SQUIRE_READ_ONLY_TOOLS.has(name)) return true;
    if (!GOVERNED.has(name)) {
      this.reject(socket, message.id, 'Trusty Squire tool is not enabled by Beeline');
      return false;
    }
    let digest: string;
    try {
      digest = squireArgumentsDigest(args);
    } catch {
      this.reject(socket, message.id, 'invalid Trusty Squire arguments');
      return false;
    }
    const key = this.authorizationKey(name, digest);
    const live = (authorizations.get(key) ?? []).filter(
      (authorization) => authorization.expiresAt > this.now(),
    );
    if (live.length < 1) {
      authorizations.delete(key);
      this.reject(socket, message.id, 'exact P1 factory permission is required');
      return false;
    }
    live.shift();
    if (live.length) authorizations.set(key, live);
    else authorizations.delete(key);
    return true;
  }

  private authorizationKey(tool: string, argumentsDigest: string): string {
    return `${tool}\0${argumentsDigest}`;
  }

  private reject(socket: Socket, id: unknown, message: string): void {
    socket.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message } })}\n`,
    );
  }

  async close(): Promise<void> {
    for (const channelId of [...this.channels.keys()]) this.revokeChannel(channelId);
    for (const child of this.children) child.kill('SIGTERM');
    this.children.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}
