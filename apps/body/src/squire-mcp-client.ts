/**
 * The REAL Squire MCP client — one stdio JSON-RPC session with the Squire MCP
 * server process on this helper. Everything the connector lifecycle does
 * (`list_credentials`, `audit_log`, `list_app_access`, `revoke_app_access`)
 * goes through `call()`, shaped to the `SquireMcpClient` interface
 * (`connector-squire.ts`) so the assignment loop stays Squire-shaped and
 * tests keep driving a mock.
 *
 * The server is spawned on demand as `npx -y @trusty-squire/mcp@latest server`
 * under `squireConnectProcessEnv()`, which already points it at the host
 * broker socket, profile and config — this client runs OUTSIDE every sandbox,
 * so the non-electing façade (which a sandboxed agent gets through its Squire
 * route grant) would only add a process and a refusal when no broker is up.
 * It is initialized once and left running for the helper's lifetime; a failed
 * call or a dead child tears the session down so the next call starts a fresh
 * one. Tests may inject a command; omitting `server` on a raw npx spawn runs
 * Squire's connect CLI instead of the vault MCP.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { squireConnectProcessEnv } from './connector-squire.js';
import { SQUIRE_SERVER_ARGS } from './squire-host.js';

const INITIALIZE_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;

export type SquireMcpClientOptions = {
  /** Spawn command; defaults to the published package through npx. */
  readonly command?: string;
  readonly args?: readonly string[];
  readonly log?: (message: string) => void;
  /** Spawn implementation; defaults to node:child_process (tests fake it). */
  readonly spawn?: typeof spawn;
  /** Process env for the MCP server; defaults to the helper chrome profile. */
  readonly env?: NodeJS.ProcessEnv;
};

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class StdioSquireMcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private buffer = '';
  private initialized?: Promise<void>;
  private closed = false;
  private readonly log: (message: string) => void;

  constructor(private readonly options: SquireMcpClientOptions = {}) {
    this.log = options.log ?? (() => {});
  }

  /** One Squire MCP tool call; resolves with the tool's parsed result. */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureSession();
    const response = (await this.request('tools/call', { name: tool, arguments: args })) as {
      isError?: boolean;
      content?: readonly { type?: string; text?: string }[];
    };
    if (response.isError) {
      const text = response.content?.find((entry) => entry.type === 'text')?.text ?? 'tool error';
      throw new Error(`${tool} failed: ${text}`);
    }
    const text = response.content?.find((entry) => entry.type === 'text')?.text;
    if (typeof text !== 'string') return response;
    try {
      return JSON.parse(text);
    } catch {
      return response;
    }
  }

  /** Tear the session down; safe to call repeatedly. */
  close(): void {
    this.closed = true;
    this.initialized = undefined;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Squire MCP session closed'));
    }
    this.pending.clear();
    this.child?.kill();
    this.child = undefined;
  }

  private ensureSession(): Promise<void> {
    if (this.closed) throw new Error('Squire MCP client is closed');
    this.initialized ??= this.initialize().catch((error) => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  private initialize(): Promise<void> {
    const child = (this.options.spawn ?? spawn)(
      this.options.command ?? 'npx',
      [...(this.options.args ?? SQUIRE_SERVER_ARGS)],
      { env: this.options.env ?? squireConnectProcessEnv() },
    ) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.on('data', (chunk: string) => this.log(`squire mcp stderr: ${chunk.trim()}`));
    child.on('exit', (code) => {
      this.log(`squire mcp exited (${String(code)})`);
      this.initialized = undefined;
      this.child = undefined;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Squire MCP server exited'));
      }
      this.pending.clear();
    });
    return this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'beeline-helper', version: '1.0.0' },
    }).then(() => {
      this.notify('notifications/initialized');
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const child = this.child;
    if (!child) return Promise.reject(new Error('Squire MCP session is not running'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        },
        method === 'initialize' ? INITIALIZE_TIMEOUT_MS : CALL_TIMEOUT_MS,
      );
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = typeof message.id === 'number' ? message.id : undefined;
      if (id === undefined) continue; // notification
      const entry = this.pending.get(id);
      if (!entry) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (message.error) {
        const error = message.error as { message?: string };
        entry.reject(new Error(error.message ?? 'Squire MCP error'));
      } else {
        entry.resolve(message.result);
      }
    }
  }
}

/**
 * The one Squire MCP client the helper loop uses. Injectable so tests drive a
 * mock; the real helper gets one lazily-spawned stdio session.
 */
export function defaultSquireMcpClient(): SquireMcpClientContract {
  return new StdioSquireMcpClient();
}

/** The shape `connector-squire.ts` speaks, re-declared to avoid a cycle. */
export interface SquireMcpClientContract {
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
}
