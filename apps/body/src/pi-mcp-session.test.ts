import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { piMcpDirectToolSelection, preparePiMcpSession } from './pi-mcp-session.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Pi MCP generated-extension route', () => {
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
    expect(extension).toContain('createMcpAdapter');
    expect(extension).toContain('"directTools": true');
    expect(extension).toContain('"disableProxyTool": true');
    expect(extension).toContain('"scriptMode": false');
    expect(extension).toContain('"DUPLICATE": "last"');
    expect(extension).toContain('λ');
    expect((await stat(resolve(session, 'extensions', 'beeline-mcp.ts'))).mode & 0o777).toBe(0o600);
    await expect(stat(resolve(session, 'settings.json'))).rejects.toThrow();
    await expect(stat(resolve(session, 'mcp.json'))).rejects.toThrow();
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
