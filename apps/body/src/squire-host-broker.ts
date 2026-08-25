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
const GOVERNED = new Set<string>(SQUIRE_GOVERNED_TOOLS);

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
  private readonly channels = new Map<
    string,
    { token: string; endpoint?: McpServerWire; authorizedDigests: Map<string, number> }
  >();
  private readonly children = new Set<ChildProcessWithoutNullStreams>();

  constructor(
    private readonly spawnSquire: SpawnSquire = () =>
      spawn('npx', ['-y', SQUIRE_MCP_PACKAGE, 'server'], {
        env: squireHostEnv(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
  ) {}

  authorize(channelId: string, argumentsDigest: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    channel.authorizedDigests.set(
      argumentsDigest,
      (channel.authorizedDigests.get(argumentsDigest) ?? 0) + 1,
    );
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
        authorizedDigests: new Map<string, number>(),
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
    let channel: { authorizedDigests: Map<string, number> } | undefined;
    let buffer = '';
    let child: ChildProcessWithoutNullStreams | undefined;
    const close = () => {
      socket.destroy();
      child?.kill('SIGTERM');
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
          if (!channel) return close();
          child = this.spawnSquire();
          this.children.add(child);
          child.stdout.pipe(socket);
          child.stderr.on('data', (data) => process.stderr.write(data));
          child.once('close', () => {
            this.children.delete(child!);
            socket.end();
          });
          child.once('error', close);
          continue;
        }
        if (child && this.allowLine(line, socket, channel.authorizedDigests)) {
          child.stdin.write(`${line}\n`);
        }
      }
    });
    socket.once('close', () => {
      if (child) this.children.delete(child);
      child?.kill('SIGTERM');
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
    authorizedDigests: Map<string, number>,
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
    const remaining = authorizedDigests.get(digest) ?? 0;
    if (remaining < 1) {
      this.reject(socket, message.id, 'exact P1 factory permission is required');
      return false;
    }
    if (remaining === 1) authorizedDigests.delete(digest);
    else authorizedDigests.set(digest, remaining - 1);
    return true;
  }

  private reject(socket: Socket, id: unknown, message: string): void {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message } })}\n`);
  }

  async close(): Promise<void> {
    this.channels.clear();
    for (const child of this.children) child.kill('SIGTERM');
    this.children.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}
