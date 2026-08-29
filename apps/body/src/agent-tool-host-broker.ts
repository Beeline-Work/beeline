import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerWire } from './acp.js';
import {
  BEELINE_AGENT_TOOL_DEFINITIONS,
  BEELINE_AGENT_TOOL_SCHEMA_VERSION,
  BEELINE_AGENT_TOOL_SERVER_NAME,
  isBeelineAgentToolName,
  type BeelineAgentToolName,
} from './agent-tool-contract.js';

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export interface AgentToolSessionBinding {
  channelId: string;
  invoke(tool: BeelineAgentToolName, args: Record<string, unknown>): Promise<unknown>;
}

interface BrokerSession {
  token: string;
  binding: AgentToolSessionBinding;
  endpoint: McpServerWire;
  connection?: Socket;
}

export function agentToolMcpProxyEntrypoint(cliEntrypoint: string = process.argv[1] ?? ''): string {
  if (!cliEntrypoint) throw new Error('Beeline CLI entrypoint is unavailable');
  const extension = extname(cliEntrypoint) === '.mjs' ? '.mjs' : '.js';
  const sibling = resolve(dirname(cliEntrypoint), `agent-tool-mcp-proxy${extension}`);
  if (existsSync(sibling)) return sibling;
  try {
    const source = resolve(dirname(fileURLToPath(import.meta.url)), 'agent-tool-mcp-proxy.ts');
    if (existsSync(source)) return source;
  } catch {
    // Bundled import.meta.url is intentionally synthetic; use the sibling.
  }
  return sibling;
}

export class AgentToolHostBroker {
  private server?: Server;
  private readonly sessions = new Map<string, BrokerSession>();

  constructor(private readonly proxyEntrypoint: string = agentToolMcpProxyEntrypoint()) {}

  async mcpServer(binding: AgentToolSessionBinding): Promise<McpServerWire> {
    await this.ensureServer();
    const address = this.server!.address();
    if (!address || typeof address === 'string') throw new Error('agent-tool broker unavailable');
    const previous = this.sessions.get(binding.channelId);
    previous?.connection?.destroy();
    const token = randomBytes(32).toString('hex');
    const proxyArgs = [this.proxyEntrypoint, '127.0.0.1', String(address.port), token];
    const endpoint: McpServerWire = {
      name: BEELINE_AGENT_TOOL_SERVER_NAME,
      command: process.execPath,
      args: this.proxyEntrypoint.endsWith('.ts') ? ['--import', 'tsx', ...proxyArgs] : proxyArgs,
      env: [],
    };
    this.sessions.set(binding.channelId, { token, binding, endpoint });
    return endpoint;
  }

  revoke(channelId: string): void {
    const session = this.sessions.get(channelId);
    this.sessions.delete(channelId);
    session?.connection?.destroy();
  }

  private async ensureServer(): Promise<void> {
    if (this.server) return;
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

  private accept(socket: Socket): void {
    socket.setEncoding('utf8');
    let session: BrokerSession | undefined;
    let buffer = '';
    let processing = Promise.resolve();
    const close = (): void => {
      socket.destroy();
    };
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) return close();
      const lines: string[] = [];
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      processing = processing
        .then(async () => {
          for (const line of lines) {
            if (!session) {
              const token = this.authenticationToken(line);
              session = [...this.sessions.values()].find((candidate) =>
                this.matchesToken(token, candidate.token),
              );
              if (!session) return close();
              // MCP clients may probe and immediately reconnect the same
              // configured transport. Keep exactly one live connection while
              // preserving the per-session capability for that reconnect.
              session.connection?.destroy();
              session.connection = socket;
              continue;
            }
            // MCP request ids make calls independently addressable. Do not
            // serialize a truth read behind a slow corner provision: the
            // caller may be using that read to recover after open_corner's
            // client-side deadline elapsed.
            void this.handleLine(session, socket, line).catch(close);
          }
        })
        .catch(close);
    });
    socket.once('close', () => {
      if (session?.connection === socket) {
        session.connection = undefined;
      }
    });
    socket.once('error', close);
  }

  private authenticationToken(line: string): string {
    try {
      const token = (JSON.parse(line) as { token?: unknown }).token;
      return typeof token === 'string' ? token : '';
    } catch {
      return '';
    }
  }

  private matchesToken(candidate: string, expected: string): boolean {
    const left = Buffer.from(candidate);
    const right = Buffer.from(expected);
    return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
  }

  private async handleLine(session: BrokerSession, socket: Socket, line: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    if (message.method === 'initialize') {
      this.reply(socket, message.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: BEELINE_AGENT_TOOL_SERVER_NAME,
          version: String(BEELINE_AGENT_TOOL_SCHEMA_VERSION),
        },
      });
      return;
    }
    if (message.method === 'tools/list') {
      this.reply(socket, message.id, { tools: BEELINE_AGENT_TOOL_DEFINITIONS });
      return;
    }
    if (message.method !== 'tools/call') {
      this.reject(socket, message.id, -32601, 'method not found');
      return;
    }
    const params = this.object(message.params);
    const name = params?.name;
    const args = this.object(params?.arguments) ?? {};
    if (!isBeelineAgentToolName(name)) {
      this.reject(socket, message.id, -32602, 'unknown Beeline agent tool');
      return;
    }
    try {
      const result = await session.binding.invoke(name, args);
      this.reply(socket, message.id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      });
    } catch {
      this.reply(socket, message.id, {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'failed',
              code: 'tool_dispatch_failed',
              retryable: false,
              message: 'The Beeline host refused this tool call.',
            }),
          },
        ],
      });
    }
  }

  private object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private reply(socket: Socket, id: unknown, result: unknown): void {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  private reject(socket: Socket, id: unknown, code: number, message: string): void {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
  }

  async close(): Promise<void> {
    for (const channelId of [...this.sessions.keys()]) this.revoke(channelId);
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}
