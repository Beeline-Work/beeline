import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOperatorMcpServers, operatorMcpServersForCorners } from './operator-mcp.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function runtimeDirWith(content: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'operator-mcp-'));
  if (content !== undefined) {
    writeFileSync(join(dir, 'operator-mcp.json'), content);
  }
  return dir;
}

describe('readOperatorMcpServers', () => {
  it('reads a well-formed operator server list', () => {
    const dir = runtimeDirWith(
      JSON.stringify([
        { name: 'squire', command: 'npx', args: ['-y', '@trusty-squire/mcp'], env: [] },
        { name: 'project-tools', command: '/usr/local/bin/project-mcp' },
      ]),
    );
    try {
      const servers = readOperatorMcpServers(dir);
      expect(servers).toEqual([
        { name: 'squire', command: 'npx', args: ['-y', '@trusty-squire/mcp'], env: [] },
        { name: 'project-tools', command: '/usr/local/bin/project-mcp', args: [], env: [] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty for a missing file, a malformed file, and a non-array document', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const missing = mkdtempSync(join(tmpdir(), 'operator-mcp-'));
    const malformed = runtimeDirWith('{not json');
    const nonArray = runtimeDirWith('{"name":"squire"}');
    try {
      expect(readOperatorMcpServers(missing)).toEqual([]);
      expect(readOperatorMcpServers(malformed)).toEqual([]);
      expect(readOperatorMcpServers(nonArray)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      for (const dir of [missing, malformed, nonArray]) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('drops entries without a name or command, and names reserved by Beeline', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = runtimeDirWith(
      JSON.stringify([
        { command: 'npx' },
        { name: 'no-command' },
        { name: 'buzz-dev-mcp', command: 'evil' },
        { name: 'good', command: 'good-bin' },
      ]),
    );
    try {
      const servers = readOperatorMcpServers(dir);
      expect(servers).toEqual([{ name: 'good', command: 'good-bin', args: [], env: [] }]);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the first of duplicate names only', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = runtimeDirWith(
      JSON.stringify([
        { name: 'dup', command: 'first' },
        { name: 'dup', command: 'second' },
      ]),
    );
    try {
      expect(readOperatorMcpServers(dir)).toEqual([
        { name: 'dup', command: 'first', args: [], env: [] },
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('operatorMcpServersForCorners', () => {
  const configured = [{ name: 'squire', command: 'npx', args: ['-y'], env: [] }];

  it('mounts operator servers only for a creator-policy agent', () => {
    expect(operatorMcpServersForCorners('creator', configured)).toEqual(configured);
    expect(operatorMcpServersForCorners('everyone', configured)).toEqual([]);
    expect(operatorMcpServersForCorners(undefined, configured)).toEqual([]);
  });

  it('never lets an operator entry shadow a Beeline-mounted server name', () => {
    const shadowing = [
      { name: 'buzz-dev-mcp', command: 'shadow', env: [] },
      ...configured,
    ];
    expect(operatorMcpServersForCorners('creator', shadowing)).toEqual(configured);
  });
});
