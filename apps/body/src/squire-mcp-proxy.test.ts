import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { parseSquireAuthentication } from '../../../scripts/verify-beeline-install.mjs';

const temporaryDirectories: string[] = [];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

afterAll(async () => {
  for (const path of temporaryDirectories) {
    await rm(path, { recursive: true, force: true });
  }
});

function runProxy(path: string, port: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [path, '127.0.0.1', String(port), 'beeline-install-proxy-token'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new Error('proxy test timed out'));
    }, 10_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new Error(`proxy exited code=${code} signal=${signal}\n${stderr}`));
    });
    child.stdin.end('proxy-request\n');
  });
}

describe('bundled Squire MCP proxy', () => {
  it('runs when Node resolves the main module through the active-release symlink', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-squire-proxy-'));
    temporaryDirectories.push(root);
    const realProxy = resolve(root, 'release', 'squire-mcp-proxy.mjs');
    const activeProxy = resolve(root, 'active', 'squire-mcp-proxy.mjs');
    await mkdir(dirname(realProxy), { recursive: true });
    await mkdir(dirname(activeProxy), { recursive: true });
    await build({
      entryPoints: [resolve(repoRoot, 'apps/body/src/squire-mcp-proxy.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile: realProxy,
    });
    await symlink(realProxy, activeProxy);

    let received = '';
    const broker = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        received += chunk;
        if (received.includes('\nproxy-request\n')) socket.end('proxy-response\n');
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      broker.once('error', rejectListen);
      broker.listen(0, '127.0.0.1', resolveListen);
    });
    try {
      const address = broker.address();
      if (!address || typeof address === 'string') throw new Error('broker did not bind');
      const result = await runProxy(activeProxy, address.port);
      expect(parseSquireAuthentication(received, activeProxy)).toEqual({
        token: 'beeline-install-proxy-token',
      });
      expect(received.trim().split('\n')[1]).toBe('proxy-request');
      expect(result.stdout).toBe('proxy-response\n');
    } finally {
      await new Promise<void>((resolveClose) => broker.close(() => resolveClose()));
    }
  });

  it('names the proxy path when its authentication frame is empty or malformed', () => {
    const proxyPath = '/prefix/lib/beeline/lib/beeline/squire-mcp-proxy.mjs';
    expect(() => parseSquireAuthentication('', proxyPath)).toThrow(
      `installed Squire proxy ${proxyPath} returned an empty authentication frame`,
    );
    expect(() => parseSquireAuthentication('{', proxyPath)).toThrow(
      `installed Squire proxy ${proxyPath} returned invalid authentication JSON`,
    );
  });
});
