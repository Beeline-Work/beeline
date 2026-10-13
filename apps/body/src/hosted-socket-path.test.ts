import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { BrowserShareHost, browserShareHostPath } from './browser-share-host.js';
import { RegistryMcpHostBroker, registryMcpBrokerSocketPath } from './registry-mcp.js';

function invalidRequest(path: string): Promise<{ error: string }> {
  return new Promise((done, reject) => {
    const socket = createConnection(path);
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(1000, () => socket.destroy(new Error('hosted socket did not answer')));
    socket.once('connect', () => socket.end('{}'));
    socket.on('data', (chunk) => {
      input += chunk;
    });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        done(JSON.parse(input));
      } catch (error) {
        reject(error);
      }
    });
  });
}

it('starts and answers through both hosted sockets for a long Unicode home', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-hosted-sockets-'));
  const home = resolve(root, '長'.repeat(80), 'operator');
  const agent = '12345678a';
  const browserPath = browserShareHostPath(home, agent);
  const registryPath = registryMcpBrokerSocketPath(home, agent);
  const browser = new BrowserShareHost(browserPath);
  const registry = new RegistryMcpHostBroker(home, undefined, undefined, registryPath);
  try {
    await browser.start();
    await registry.start();
    for (const path of [browserPath, registryPath]) {
      expect(Buffer.byteLength(path)).toBeLessThan(104);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await invalidRequest(path)).error).toBeTruthy();
    }
    expect(browserPath).not.toBe(registryPath);
    expect(browserPath).not.toBe(browserShareHostPath(home, '12345678b'));
    expect(registryPath).not.toBe(registryMcpBrokerSocketPath(home, '12345678b'));
  } finally {
    await browser.stop();
    await registry.stop();
    for (const path of [browserPath, registryPath])
      await rm(dirname(path), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
