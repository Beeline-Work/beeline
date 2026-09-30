import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';

let directory: string | undefined;
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('bundled beeline-readonly-mcp', () => {
  it('answers each request exactly once', async () => {
    directory = await mkdtemp(join(tmpdir(), 'readonly-mcp-bundle-'));
    const outfile = join(directory, 'beeline-readonly-mcp.mjs');
    // Same shape as scripts/build-beeline-bundle.mjs: no import.meta.url define.
    await build({
      entryPoints: [fileURLToPath(new URL('./read-only-mcp.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile,
      logLevel: 'silent',
    });
    const child = spawn(process.execPath, [outfile], {
      env: { ...process.env, BEELINE_MCP_SURFACE: 'agent' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const requests = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't' } },
      },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'no_such_tool' } },
    ];
    child.stdin.end(requests.map((request) => JSON.stringify(request)).join('\n') + '\n');
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    child.kill();
    const responses = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: number; result?: Record<string, unknown> });
    expect(responses.map((response) => response.id)).toEqual([1, 2, 3]);
    expect(responses[0].result?.serverInfo).toMatchObject({ name: 'beeline-agent' });
    expect(responses[2].result?.isError).toBe(true);
  }, 60_000);
});
