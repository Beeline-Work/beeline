import {
  execFile,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBwrapArgv, sandboxMountPlan } from './bwrap-sandbox.js';
import type { BodyConfig } from './config.js';
import {
  CODEGRAPH_MCP_SERVER_NAME,
  codegraphFingerprintServers,
  codegraphIndexDirectory,
  codegraphMcpServer,
  prepareCodegraphIndex,
} from './codegraph.js';

const execFileAsync = promisify(execFile);
const codegraphCommand = resolve(process.cwd(), '../../node_modules/.bin/codegraph');
const gitCommand = spawnSync('/usr/bin/git', ['--version']).status === 0 ? '/usr/bin/git' : 'git';
const canRunBwrap =
  process.platform === 'linux' &&
  spawnSync('/usr/bin/bwrap', ['--ro-bind', '/', '/', '--', '/bin/true']).status === 0;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class TestMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private stderr = '';

  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => (this.stderr += chunk));
    this.child.once('exit', (code) => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(
          new Error(`CodeGraph MCP exited (${String(code)}): ${this.stderr.trim() || 'no stderr'}`),
        );
      }
      this.pending.clear();
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'beeline-codegraph-test', version: '1' },
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  close(): void {
    this.child.kill();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (message.id === undefined) continue;
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message ?? 'MCP error'));
      else entry.resolve(message.result);
    }
  }
}

describe('CodeGraph Room Tools', () => {
  let root: string;
  const config = { codegraphCommand } as BodyConfig;

  beforeAll(async () => {
    await access(codegraphCommand);
    root = await mkdtemp(join(tmpdir(), 'beeline-codegraph-'));
    await execFileAsync(gitCommand, ['init', root]);
    await writeFile(
      join(root, 'names.ts'),
      [
        'export function formatName(name: string): string {',
        '  return `Hello, ${name}!`;',
        '}',
        '',
        'export function greet(name: string): string {',
        '  return formatName(name);',
        '}',
        '',
      ].join('\n'),
    );
    expect(await prepareCodegraphIndex(config, root)).toBe(true);
  }, 60_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('adds the mounted server to retained-session fingerprints', () => {
    expect(codegraphFingerprintServers(config, ['beeline-agent'])).toEqual([
      'beeline-agent',
      CODEGRAPH_MCP_SERVER_NAME,
    ]);
    expect(codegraphFingerprintServers({} as BodyConfig, ['beeline-agent'])).toEqual([
      'beeline-agent',
    ]);
    expect(codegraphFingerprintServers(config, ['beeline-agent'], false)).toEqual([
      'beeline-agent',
    ]);
    expect(
      sandboxMountPlan({
        mode: 'readonly',
        cwd: root,
        additionalWritablePaths: [codegraphIndexDirectory(root)],
      }).writable,
    ).toContain(codegraphIndexDirectory(root));
  });

  it.each([
    ['Room', true],
    ['corner', false],
  ] as const)(
    'discovers and queries the real MCP on the %s surface',
    async (_surface, readonly) => {
      const server = codegraphMcpServer(config, root, { readonly });
      expect(server).toBeDefined();
      expect(server?.args).toEqual([
        'serve',
        '--mcp',
        '--path',
        root,
        ...(readonly ? ['--no-watch'] : []),
      ]);
      const client = new TestMcpClient(
        server!.command,
        server!.args,
        root,
        Object.fromEntries([
          ...Object.entries(process.env),
          ...server!.env.map(({ name, value }) => [name, value]),
        ]),
      );
      try {
        await client.initialize();
        const listed = (await client.request('tools/list', {})) as {
          tools?: Array<{ name?: string }>;
        };
        expect(listed.tools?.map(({ name }) => name)).toContain('codegraph_explore');
        const result = (await client.request('tools/call', {
          name: 'codegraph_explore',
          arguments: { query: 'How does greet use formatName?', projectPath: root },
        })) as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
        expect(result.isError).not.toBe(true);
        const text = result.content?.map((entry) => entry.text ?? '').join('\n') ?? '';
        expect(text).toContain('greet');
        expect(text).toContain('formatName');
        expect(await readFile(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain(
          '.codegraph/',
        );
      } finally {
        client.close();
      }
    },
    60_000,
  );

  it.runIf(canRunBwrap)(
    'answers through the same read-only OS sandbox used by Rooms',
    async () => {
      const server = codegraphMcpServer(config, root, { readonly: true })!;
      const wrapped = buildBwrapArgv({
        bwrapPath: '/usr/bin/bwrap',
        plan: sandboxMountPlan({
          mode: 'readonly',
          cwd: root,
          additionalWritablePaths: [codegraphIndexDirectory(root)],
        }),
        cwd: root,
        command: server.command,
        args: server.args,
      });
      const client = new TestMcpClient(
        wrapped.command,
        wrapped.args,
        root,
        Object.fromEntries([
          ...Object.entries(process.env),
          ...server.env.map(({ name, value }) => [name, value]),
        ]),
      );
      try {
        await client.initialize();
        const result = (await client.request('tools/call', {
          name: 'codegraph_explore',
          arguments: { query: 'How does greet use formatName?', projectPath: root },
        })) as { isError?: boolean; content?: Array<{ text?: string }> };
        expect(result.isError).not.toBe(true);
        expect(result.content?.map(({ text }) => text ?? '').join('\n')).toContain('formatName');
      } finally {
        client.close();
      }
    },
    60_000,
  );
});
