import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, extname, resolve } from 'node:path';
import type { McpServerWire } from './acp.js';
import {
  SQUIRE_GOVERNED_TOOLS,
  SQUIRE_MCP_PACKAGE,
  SQUIRE_READ_ONLY_TOOLS,
  squireArgumentsDigest,
} from './external-mcp-capabilities.js';
import { trustySquireHostEnv } from './trusty-squire-storage.js';

const MAX_MESSAGE_BYTES = 1024 * 1024;
export const SQUIRE_AUTHORIZATION_TTL_MS = 60_000;
const GOVERNED = new Set<string>(SQUIRE_GOVERNED_TOOLS);

interface BrokerChannel {
  id: string;
  token: string;
  allowedTools: Set<string>;
  endpoint?: McpServerWire;
  connection?: BrokerConnection;
}

interface BrokerAuthorization {
  id: string;
  expiresAt: number;
  verify: () => Promise<boolean>;
}

interface BrokerConnection {
  socket: Socket;
  child: ChildProcessWithoutNullStreams;
  authorizations: Map<string, BrokerAuthorization[]>;
  pendingToolLists: Set<string>;
}

type SpawnSquire = () => ChildProcessWithoutNullStreams;

export function squireMcpProxyEntrypoint(cliEntrypoint: string = process.argv[1] ?? ''): string {
  if (!cliEntrypoint) throw new Error('Beeline CLI entrypoint is unavailable');
  const extension = extname(cliEntrypoint) === '.mjs' ? '.mjs' : '.js';
  return resolve(dirname(cliEntrypoint), `squire-mcp-proxy${extension}`);
}

export class SquireHostBroker {
  private server?: Server;
  private readonly channels = new Map<string, BrokerChannel>();
  private readonly children = new Set<ChildProcessWithoutNullStreams>();

  constructor(
    private readonly configRoot: string,
    private readonly spawnSquire: SpawnSquire = () =>
      spawn('npx', ['-y', SQUIRE_MCP_PACKAGE, 'server'], {
        env: trustySquireHostEnv(process.env, configRoot),
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    private readonly now: () => number = Date.now,
    private readonly proxyEntrypoint: string = squireMcpProxyEntrypoint(),
  ) {}

  authorize(
    channelId: string,
    tool: string,
    argumentsDigest: string,
    verify: () => Promise<boolean>,
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
    live.push({ id, expiresAt, verify });
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

  async mcpServer(channelId: string, allowedTools: ReadonlySet<string>): Promise<McpServerWire> {
    const existing = this.channels.get(channelId);
    if (existing?.endpoint) {
      existing.allowedTools = new Set(allowedTools);
      return existing.endpoint;
    }
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
    if (!address || typeof address === 'string')
      throw new Error('Squire broker has no TCP endpoint');
    const channel = existing ?? {
      id: channelId,
      token: randomBytes(32).toString('hex'),
      allowedTools: new Set(allowedTools),
    };
    channel.allowedTools = new Set(allowedTools);
    const endpoint = {
      name: 'squire',
      command: process.execPath,
      args: [this.proxyEntrypoint, '127.0.0.1', String(address.port), channel.token],
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
    let processing = Promise.resolve();
    const close = () => {
      socket.destroy();
      connection?.child.kill('SIGTERM');
    };
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) return close();
      let newline: number;
      const lines: string[] = [];
      while ((newline = buffer.indexOf('\n')) >= 0) {
        lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      processing = processing
        .then(async () => {
          for (const line of lines) {
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
              connection = {
                socket,
                child,
                authorizations: new Map(),
                pendingToolLists: new Set(),
              };
              channel.connection = connection;
              channel.token = '';
              this.children.add(child);
              this.pipeChildOutput(connection, channel.allowedTools);
              child.stderr.on('data', (data) => process.stderr.write(data));
              child.once('close', () => {
                this.children.delete(child);
                socket.end();
              });
              child.once('error', close);
              continue;
            }
            if (
              connection &&
              channel &&
              (await this.allowLine(line, socket, connection, channel))
            ) {
              connection.child.stdin.write(`${line}\n`);
            }
          }
        })
        .catch(close);
    });
    socket.once('close', () => {
      if (channel && channel.connection === connection) {
        channel.connection = undefined;
        channel.token = randomBytes(32).toString('hex');
        if (channel.endpoint?.args)
          channel.endpoint.args[channel.endpoint.args.length - 1] = channel.token;
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

  private async allowLine(
    line: string,
    socket: Socket,
    connection: BrokerConnection,
    channel: BrokerChannel,
  ): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const message = parsed as Record<string, unknown>;
    if (message.method === 'tools/list') {
      connection.pendingToolLists.add(this.rpcId(message.id));
      return true;
    }
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
    if (!channel.allowedTools.has(name)) {
      this.reject(socket, message.id, 'Trusty Squire tool is not enabled for this capability');
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
    const live = (connection.authorizations.get(key) ?? []).filter(
      (authorization) => authorization.expiresAt > this.now(),
    );
    if (live.length < 1) {
      connection.authorizations.delete(key);
      this.reject(socket, message.id, 'exact P1 factory permission is required');
      return false;
    }
    const authorization = live.shift()!;
    if (live.length) connection.authorizations.set(key, live);
    else connection.authorizations.delete(key);
    const current = await authorization.verify().catch(() => false);
    if (!current) {
      this.reject(socket, message.id, 'current P1 factory permission was revoked');
      return false;
    }
    if (
      authorization.expiresAt <= this.now() ||
      socket.destroyed ||
      !socket.writable ||
      connection.socket !== socket ||
      this.channels.get(channel.id) !== channel ||
      channel.connection !== connection ||
      !channel.allowedTools.has(name)
    ) {
      this.reject(socket, message.id, 'Trusty Squire authorization expired or session ended');
      return false;
    }
    connection.child.stdin.write(`${line}\n`);
    return false;
  }

  private pipeChildOutput(connection: BrokerConnection, allowedTools: ReadonlySet<string>): void {
    let buffer = '';
    connection.child.stdout.setEncoding('utf8');
    connection.child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        connection.socket.destroy();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let output = line;
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          const id = this.rpcId(message.id);
          if (connection.pendingToolLists.delete(id)) {
            const result = message.result;
            if (result && typeof result === 'object' && !Array.isArray(result)) {
              const tools = (result as Record<string, unknown>).tools;
              if (Array.isArray(tools)) {
                output = JSON.stringify({
                  ...message,
                  result: {
                    ...(result as Record<string, unknown>),
                    tools: tools.filter(
                      (tool) =>
                        tool !== null &&
                        typeof tool === 'object' &&
                        !Array.isArray(tool) &&
                        allowedTools.has(String((tool as Record<string, unknown>).name)),
                    ),
                  },
                });
              }
            }
          }
        } catch {
          output = line;
        }
        connection.socket.write(`${output}\n`);
      }
    });
  }

  private rpcId(id: unknown): string {
    return JSON.stringify(id ?? null);
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
