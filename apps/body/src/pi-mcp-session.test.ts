import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PI_MCP_SESSION_ADAPTER_NAME,
  PI_MCP_REQUEST_TIMEOUT_MS,
  piMcpDirectToolSelection,
  preparePiMcpSession,
} from './pi-mcp-session.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Pi MCP generated-extension route', () => {
  it('keeps the direct-tool deadline above bounded corner provisioning', () => {
    expect(PI_MCP_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });
  it('keeps Pi host modules external to the release-owned adapter bundle', async () => {
    const buildScript = await readFile(
      resolve(process.cwd(), '../../scripts/build-beeline-bundle.mjs'),
      'utf8',
    );
    expect(buildScript).toContain("'--minify'");
    expect(buildScript).toContain("'--external:@earendil-works/pi-*'");
    expect(buildScript).toContain("'--external:typebox'");
    expect(buildScript).toContain("'--external:typebox/*'");
  });

  it('selects the exact mounted inventory for the startup readiness barrier', () => {
    expect(
      piMcpDirectToolSelection([
        { name: 'beeline-agent-tools', command: '/bin/true' },
        { name: 'buzz-readonly-mcp', command: '/bin/true' },
      ]),
    ).toBe('beeline-agent-tools,buzz-readonly-mcp');
  });

  it('materializes the exact session inventory with data-only serialization', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-pi-mcp-'));
    roots.push(root);
    const baseDir = resolve(root, 'pi');
    await mkdir(resolve(baseDir, 'skills'), { recursive: true });
    await writeFile(resolve(baseDir, 'auth.json'), '{}');
    const adapter = resolve(root, 'pi-mcp-adapter.mjs');
    await writeFile(adapter, 'export const createMcpAdapter = (value) => value;\n');
    const session = await preparePiMcpSession({
      baseDir,
      channelId: 'corner/id with spaces',
      adapterEntrypoint: adapter,
      mcpServers: [
        {
          name: 'beeline-agent-tools',
          command: '/release/bin/node',
          args: ['adapter', `quote'\"`, 'λ'],
          env: [
            { name: 'TOKEN', value: `secret'\"` },
            { name: 'DUPLICATE', value: 'first' },
            { name: 'DUPLICATE', value: 'last' },
          ],
        },
      ],
    });
    const extension = await readFile(resolve(session, 'extensions', 'beeline-mcp.ts'), 'utf8');
    const sessionAdapter = resolve(session, 'extensions', PI_MCP_SESSION_ADAPTER_NAME);
    expect(extension).toContain('createMcpAdapter');
    expect(extension).toContain(`./${PI_MCP_SESSION_ADAPTER_NAME}`);
    expect(extension).not.toContain(adapter);
    expect(await readFile(sessionAdapter, 'utf8')).toContain('createMcpAdapter');
    expect(extension).toContain('"directTools": true');
    expect(extension).toContain('"disableProxyTool": true');
    expect(extension).toContain('"scriptMode": false');
    expect(extension).toContain(`"requestTimeoutMs": ${PI_MCP_REQUEST_TIMEOUT_MS}`);
    expect(extension).toContain('"DUPLICATE": "last"');
    expect(extension).toContain('λ');
    expect((await stat(resolve(session, 'extensions', 'beeline-mcp.ts'))).mode & 0o777).toBe(0o600);
    expect((await stat(sessionAdapter)).mode & 0o777).toBe(0o600);
    await expect(stat(resolve(session, 'settings.json'))).rejects.toThrow();
    await expect(stat(resolve(session, 'mcp.json'))).rejects.toThrow();
  });

  it('replaces adapter bytes from the running bundle on every activation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-pi-mcp-'));
    roots.push(root);
    const baseDir = resolve(root, 'pi');
    await mkdir(baseDir, { recursive: true });
    const adapter = resolve(root, 'pi-mcp-adapter.mjs');
    await writeFile(adapter, 'export const release = "newer";\n');
    const first = await preparePiMcpSession({
      baseDir,
      channelId: 'room',
      adapterEntrypoint: adapter,
      mcpServers: [],
    });
    await writeFile(resolve(first, 'extensions', PI_MCP_SESSION_ADAPTER_NAME), 'stale\n');
    await writeFile(adapter, 'export const release = "rolled-back";\n');

    const second = await preparePiMcpSession({
      baseDir,
      channelId: 'room',
      adapterEntrypoint: adapter,
      mcpServers: [],
    });

    expect(second).toBe(first);
    expect(await readFile(resolve(second, 'extensions', PI_MCP_SESSION_ADAPTER_NAME), 'utf8')).toBe(
      'export const release = "rolled-back";\n',
    );
  });

  it('isolates concurrent physical session inventories', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-pi-mcp-'));
    roots.push(root);
    const baseDir = resolve(root, 'pi');
    await mkdir(baseDir, { recursive: true });
    const adapter = resolve(root, 'pi-mcp-adapter.mjs');
    await writeFile(adapter, 'export const createMcpAdapter = (value) => value;\n');
    const [room, corner] = await Promise.all([
      preparePiMcpSession({
        baseDir,
        channelId: 'room',
        adapterEntrypoint: adapter,
        mcpServers: [{ name: 'room-only', command: '/bin/true' }],
      }),
      preparePiMcpSession({
        baseDir,
        channelId: 'corner',
        adapterEntrypoint: adapter,
        mcpServers: [{ name: 'corner-only', command: '/bin/true' }],
      }),
    ]);
    expect(room).not.toBe(corner);
    expect(await readFile(resolve(room, 'extensions', 'beeline-mcp.ts'), 'utf8')).toContain(
      'room-only',
    );
    expect(await readFile(resolve(corner, 'extensions', 'beeline-mcp.ts'), 'utf8')).toContain(
      'corner-only',
    );
  });
});
