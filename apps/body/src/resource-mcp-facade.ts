/** Host MCP transport gate. Authorization belongs to each call, not the harness session. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

export const RESOURCE_FACADE_FLAG = '--resource-mcp-facade';
export function resourceFacadeArgs(): string[] {
  const meta = import.meta.url;
  if (meta.startsWith('beeline:')) {
    if (!process.argv[1]) throw new Error('resource facade entry is unavailable');
    return [process.argv[1], RESOURCE_FACADE_FLAG];
  }
  const js = fileURLToPath(new URL('./resource-mcp-facade.js', meta));
  if (existsSync(js)) return [js];
  return [
    '--import',
    createRequire(meta).resolve('tsx'),
    fileURLToPath(new URL('./resource-mcp-facade.ts', meta)),
  ];
}

const DISCOVERY = new Set(['initialize', 'ping', 'tools/list']);

export async function authorizeResourceMessage(
  message: Record<string, unknown>,
  target: string,
  authFile: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!message || Array.isArray(message) || typeof message !== 'object') return false;
  if (typeof message.method !== 'string') return 'result' in message || 'error' in message;
  if (
    [
      'notifications/initialized',
      'notifications/cancelled',
      'notifications/progress',
      'notifications/roots/list_changed',
    ].includes(message.method) ||
    DISCOVERY.has(message.method)
  )
    return true;
  const auth = JSON.parse(await readFile(authFile, 'utf8')) as {
    baseUrl: string;
    daemonToken: string;
    turnContextPath: string;
  };
  const context = JSON.parse(await readFile(auth.turnContextPath, 'utf8')) as Record<
    string,
    unknown
  >;
  if (
    ![context.roomId, context.requestId, context.generationId].every(
      (value) => typeof value === 'string' && value.length > 0,
    )
  )
    return false;
  const response = await fetchImpl(
    new URL('/v1/daemon/operations/authorizeResourceCall', auth.baseUrl),
    {
      method: 'POST',
      headers: { authorization: `Bearer ${auth.daemonToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...context, target }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  return response.ok && ((await response.json()) as { allowed?: boolean }).allowed === true;
}

export function runResourceFacade(env: NodeJS.ProcessEnv = process.env): void {
  const target = env.BEELINE_RESOURCE_TARGET;
  const authFile = env.BEELINE_RESOURCE_AUTH_FILE;
  if (!target || !authFile || !env.BEELINE_RESOURCE_LAUNCH)
    throw new Error('resource route authorization is unavailable');
  const launch = JSON.parse(env.BEELINE_RESOURCE_LAUNCH) as {
    command?: string;
    cmd?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    envs?: Record<string, string>;
  };
  const childEnv = { ...env, ...launch.env, ...launch.envs };
  delete childEnv.BEELINE_RESOURCE_LAUNCH;
  delete childEnv.BEELINE_RESOURCE_AUTH_FILE;
  const command = launch.command ?? launch.cmd;
  const child = command
    ? spawn(command, launch.args ?? [], { env: childEnv, stdio: ['pipe', 'pipe', 'inherit'] })
    : undefined;
  if (!child && !launch.url) throw new Error('resource transport is unavailable');
  child?.stdout.pipe(process.stdout);
  child?.on('error', () => {
    process.exitCode = 1;
    process.stdin.destroy();
  });
  child?.on('exit', (code) => {
    process.exitCode = code ?? 1;
    process.stdin.destroy();
  });
  let session: string | undefined;
  const lines = createInterface({ input: process.stdin });
  // Serialize calls so Once cannot be used by two requests before consumption.
  let pending = Promise.resolve();
  lines.on('line', (line) => {
    pending = pending.then(async () => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      try {
        if (!(await authorizeResourceMessage(message, target, authFile)))
          throw new Error('resource approval required');
        if (child) {
          child.stdin.write(`${line}\n`);
          return;
        }
        const response = await fetch(launch.url!, {
          method: 'POST',
          headers: {
            ...launch.headers,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(session ? { 'mcp-session-id': session } : {}),
          },
          body: line,
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) throw new Error('resource transport refused the call');
        session = response.headers.get('mcp-session-id') ?? session;
        if (response.status === 202 || response.status === 204) return;
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          const reader = response.body?.getReader();
          if (!reader) return;
          let buffer = '';
          const decoder = new TextDecoder();
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              buffer += decoder.decode(chunk.value, { stream: true });
              let end: number;
              while ((end = buffer.indexOf('\n')) >= 0) {
                const row = buffer.slice(0, end).trimEnd();
                buffer = buffer.slice(end + 1);
                if (!row.startsWith('data:')) continue;
                const data = row.slice(5).trim();
                const result = JSON.parse(data) as { id?: unknown };
                process.stdout.write(`${data}\n`);
                if (result.id === message.id) return;
              }
            }
          } finally {
            await reader.cancel();
          }
        } else {
          const body = await response.text();
          if (body) process.stdout.write(`${body}\n`);
        }
      } catch {
        if (message.id !== undefined)
          process.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Resource access requires approval from its owner for this requester, or the resource is unavailable.' } })}\n`,
          );
      }
    });
  });
  lines.on('close', () => {
    void pending.finally(() => child?.stdin.end());
  });
  process.on('SIGTERM', () => {
    child?.kill();
    process.exit();
  });
}

if (/resource-mcp-facade\.(?:js|ts)$/.test(process.argv[1] ?? '')) runResourceFacade();
