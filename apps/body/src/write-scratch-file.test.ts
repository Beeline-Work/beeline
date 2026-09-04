import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonApiClient } from './daemon-api-client.js';
import { beelineAgentMcpServer } from './room-session.js';
import {
  attachFile,
  attachFileDepsFromEnv,
  resolveWriteScratchPath,
  writeScratchFile,
  writeScratchFileDepsFromEnv,
  type WriteScratchFileDeps,
} from './read-only-mcp.js';

describe('beeline-agent write_scratch_file', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'write-scratch-root-'));
    outside = mkdtempSync(join(tmpdir(), 'write-scratch-outside-'));
  });

  it('resolves a top-level and nested path inside the session area', () => {
    expect(resolveWriteScratchPath(root, 'note.txt')).toBe(join(root, 'note.txt'));
    expect(resolveWriteScratchPath(root, 'a/b/c.txt')).toBe(join(root, 'a', 'b', 'c.txt'));
  });

  it('refuses an absolute path', () => {
    expect(() => resolveWriteScratchPath(root, join(outside, 'x.txt'))).toThrow(
      /writable session area/,
    );
    expect(() => resolveWriteScratchPath(root, '/etc/passwd')).toThrow(/writable session area/);
  });

  it('refuses traversal outside the session area', () => {
    expect(() => resolveWriteScratchPath(root, '../escape.txt')).toThrow(/writable session area/);
    expect(() => resolveWriteScratchPath(root, 'a/../../escape.txt')).toThrow(
      /writable session area/,
    );
  });

  it('refuses a symlink escape through an existing ancestor directory', () => {
    symlinkSync(outside, join(root, 'linkdir'));
    expect(() => resolveWriteScratchPath(root, 'linkdir/x.txt')).toThrow(
      /writable session area/,
    );
  });

  it('refuses writing through a pre-existing symlink at the leaf', () => {
    const target = join(outside, 'secret.txt');
    writeFileSync(target, 'secret');
    symlinkSync(target, join(root, 'leak.txt'));
    expect(() => resolveWriteScratchPath(root, 'leak.txt')).toThrow(/symlink/);
  });

  it('creates missing parent directories', () => {
    const resolved = resolveWriteScratchPath(root, 'nested/dir/file.txt');
    expect(resolved).toBe(join(root, 'nested', 'dir', 'file.txt'));
  });

  it('writes text content and round-trips base64', async () => {
    const deps: WriteScratchFileDeps = { root };
    const textMessage = await writeScratchFile({ path: 'hello.txt', content: 'hi there' }, deps);
    expect(textMessage).toMatch(/Wrote 8 bytes/);
    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('hi there');

    const bytes = Buffer.from([0, 1, 2, 255, 254]);
    const b64Message = await writeScratchFile(
      { path: 'bin/data.bin', content: bytes.toString('base64'), encoding: 'base64' },
      deps,
    );
    expect(b64Message).toMatch(/Wrote 5 bytes/);
    expect(readFileSync(join(root, 'bin', 'data.bin'))).toEqual(bytes);
  });

  it('refuses content over the attachment size cap', async () => {
    const deps: WriteScratchFileDeps = { root };
    const huge = 'x'.repeat(25 * 1024 * 1024 + 1);
    await expect(writeScratchFile({ path: 'huge.txt', content: huge }, deps)).rejects.toThrow(
      /attachment limit/,
    );
  });

  it('refuses a bad encoding value and missing content', async () => {
    const deps: WriteScratchFileDeps = { root };
    await expect(
      writeScratchFile({ path: 'a.txt', content: 'x', encoding: 'utf16' }, deps),
    ).rejects.toThrow(/encoding/);
    await expect(writeScratchFile({ path: 'a.txt' }, deps)).rejects.toThrow(/content/);
  });

  it('a written file attaches through the same session area root', async () => {
    const deps: WriteScratchFileDeps = { root };
    const message = await writeScratchFile({ path: 'report/out.md', content: '# hi' }, deps);
    const path = message.match(/Wrote \d+ bytes to (\S+);/)?.[1];
    expect(path).toBe(join(root, 'report', 'out.md'));

    const uploads: Array<{ bytes: Buffer; mimeType: string; name: string }> = [];
    const queued: unknown[] = [];
    const attached = await attachFile(
      { path: 'report/out.md' },
      {
        roots: [root],
        baseUrl: 'https://server.example',
        token: 'token',
        roomId: 'room-1',
        upload: async (bytes, mimeType, name) => {
          uploads.push({ bytes, mimeType, name });
          return { url: 'https://server.example/v1/media/abc', name, mimeType, size: bytes.length };
        },
        queue: async (attachment) => {
          queued.push(attachment);
        },
      },
    );
    expect(attached).toMatch(/Attached out\.md/);
    expect(queued).toHaveLength(1);
  });

  describe('end to end from beelineAgentMcpServer through env wiring', () => {
    const savedEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...savedEnv };
    });

    it('the scratch root wired for attach_file is the same root write_scratch_file uses', () => {
      const attachRoot = mkdtempSync(join(tmpdir(), 'write-scratch-checkout-'));
      const scratchRoot = mkdtempSync(join(tmpdir(), 'write-scratch-home-'));
      const api = new DaemonApiClient('https://server.example', 'daemon-secret', 'agent-id');
      const server = beelineAgentMcpServer(
        {
          agentBinary: 'agent',
          mcpBinary: 'unused',
          readonlyMcpCommand: '/bin/beeline-mcp',
          agentEnv: {},
          workspaceRoot: '/room',
          autoApprovePermissions: false,
        },
        api,
        {
          roomId: 'room-1',
          workspaceId: 'workspace-1',
          attachRoot,
          attachScratchRoot: scratchRoot,
        },
      );
      for (const { name, value } of server.env) process.env[name] = value;
      const writeDeps = writeScratchFileDepsFromEnv();
      expect(writeDeps.root).toBe(scratchRoot);
      const attachDeps = attachFileDepsFromEnv();
      expect(attachDeps.roots).toEqual([attachRoot, scratchRoot]);

      // A corner worktree passed as attachRoot must never become a write
      // target: writes stay pinned to the session scratch root only.
      mkdirSync(join(attachRoot, 'src'), { recursive: true });
      expect(() => resolveWriteScratchPath(writeDeps.root, join(attachRoot, 'src', 'x.txt'))).toThrow(
        /writable session area/,
      );
    });
  });
});
