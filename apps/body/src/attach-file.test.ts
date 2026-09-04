import { mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachFile, resolveAttachPath, type AttachFileDeps } from './read-only-mcp.js';

describe('beeline-agent attach_file', () => {
  let root: string;
  let scratch: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'attach-root-'));
    scratch = mkdtempSync(join(tmpdir(), 'attach-scratch-'));
    outside = mkdtempSync(join(tmpdir(), 'attach-outside-'));
    writeFileSync(join(root, 'report.txt'), 'hello');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'data.json'), '{}');
    writeFileSync(join(scratch, 'lunch.png'), 'fake-png');
  });
  afterEach(() => {
    // Temp dirs are disposable; no cleanup needed on tmpdir.
  });

  it('resolves a file inside the checkout', () => {
    expect(resolveAttachPath([root], 'report.txt')).toBe(join(root, 'report.txt'));
    expect(resolveAttachPath([root], 'sub/data.json')).toBe(join(root, 'sub', 'data.json'));
    expect(resolveAttachPath([root], join(root, 'sub', 'data.json'))).toBe(
      join(root, 'sub', 'data.json'),
    );
  });

  it('resolves a file inside the session scratch root', () => {
    expect(resolveAttachPath([root, scratch], 'lunch.png')).toBe(join(scratch, 'lunch.png'));
    expect(resolveAttachPath([root, scratch], join(scratch, 'lunch.png'))).toBe(
      join(scratch, 'lunch.png'),
    );
    // The checkout root is still legal alongside the scratch root.
    expect(resolveAttachPath([root, scratch], 'report.txt')).toBe(join(root, 'report.txt'));
  });

  it('refuses paths outside both roots, including symlink escapes', () => {
    expect(() => resolveAttachPath([root, scratch], '../escape.txt')).toThrow();
    const outsideFile = join(outside, 'escape.txt');
    writeFileSync(outsideFile, 'outside');
    expect(() => resolveAttachPath([root, scratch], outsideFile)).toThrow(
      /checkout or scratch directory/,
    );
    expect(() => resolveAttachPath([root, scratch], '/etc/hostname')).toThrow(
      /checkout or scratch directory/,
    );
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'secret');
    symlinkSync(secret, join(root, 'leak.txt'));
    expect(() => resolveAttachPath([root, scratch], 'leak.txt')).toThrow(
      /checkout or scratch directory/,
    );
    symlinkSync('/etc', join(root, 'etc-link'));
    expect(() => resolveAttachPath([root, scratch], 'etc-link/hostname')).toThrow(
      /checkout or scratch directory/,
    );
    // A symlink from the scratch root escaping both roots is refused too.
    symlinkSync(secret, join(scratch, 'scratch-leak.txt'));
    expect(() => resolveAttachPath([root, scratch], 'scratch-leak.txt')).toThrow(
      /checkout or scratch directory/,
    );
    // The refusal message names both roots.
    try {
      resolveAttachPath([root, scratch], outsideFile);
      throw new Error('expected resolveAttachPath to throw');
    } catch (error) {
      expect((error as Error).message).toContain(root);
      expect((error as Error).message).toContain(scratch);
    }
  });

  it('refuses directories and missing files', () => {
    expect(() => resolveAttachPath([root], 'sub')).toThrow(/not a regular file/);
    expect(() => resolveAttachPath([root], 'nope.txt')).toThrow();
    expect(() => resolveAttachPath([root], '')).toThrow();
  });

  it('uploads the file and queues the attachment for the final reply', async () => {
    const uploads: Array<{ bytes: Buffer; mimeType: string; name: string }> = [];
    const queued: unknown[] = [];
    const deps: AttachFileDeps = {
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
    };
    const message = await attachFile({ path: 'sub/data.json' }, deps);
    expect(message).toMatch(/Attached data\.json/);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.mimeType).toBe('application/json');
    expect(queued).toEqual([
      {
        url: 'https://server.example/v1/media/abc',
        name: 'data.json',
        mimeType: 'application/json',
        size: 2,
      },
    ]);
  });

  it('uploads a file the agent generated in the session scratch root', async () => {
    const uploads: Array<{ bytes: Buffer; mimeType: string; name: string }> = [];
    const queued: unknown[] = [];
    const deps: AttachFileDeps = {
      roots: [root, scratch],
      baseUrl: 'https://server.example',
      token: 'token',
      roomId: 'room-1',
      upload: async (bytes, mimeType, name) => {
        uploads.push({ bytes, mimeType, name });
        return { url: 'https://server.example/v1/media/xyz', name, mimeType, size: bytes.length };
      },
      queue: async (attachment) => {
        queued.push(attachment);
      },
    };
    const message = await attachFile({ path: 'lunch.png' }, deps);
    expect(message).toMatch(/Attached lunch\.png/);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.mimeType).toBe('image/png');
    expect(queued).toEqual([
      {
        url: 'https://server.example/v1/media/xyz',
        name: 'lunch.png',
        mimeType: 'image/png',
        size: 8,
      },
    ]);
  });

  it('queues several attachments per turn and falls back to octet-stream', async () => {
    const queued: unknown[] = [];
    const deps: AttachFileDeps = {
      roots: [root],
      baseUrl: 'https://server.example',
      token: 'token',
      roomId: 'room-1',
      upload: async (bytes, mimeType, name) => ({
        url: 'https://server.example/v1/media/abc',
        name,
        mimeType,
        size: bytes.length,
      }),
      queue: async (attachment) => {
        queued.push(attachment);
      },
    };
    writeFileSync(join(root, 'blob.bin'), 'x');
    await attachFile({ path: 'report.txt' }, deps);
    await attachFile({ path: 'blob.bin', caption: 'see attached' }, deps);
    expect(queued).toHaveLength(2);
    expect(queued[1]).toMatchObject({ name: 'blob.bin', mimeType: 'application/octet-stream' });
  });

  it('refuses files over the 25 MB attachment cap', async () => {
    writeFileSync(join(root, 'huge.bin'), 'x');
    truncateSync(join(root, 'huge.bin'), 25 * 1024 * 1024 + 1);
    const deps: AttachFileDeps = {
      roots: [root],
      baseUrl: 'https://server.example',
      token: 'token',
      roomId: 'room-1',
      upload: async () => {
        throw new Error('upload must not run for an over-cap file');
      },
      queue: async () => {
        throw new Error('queue must not run for an over-cap file');
      },
    };
    await expect(attachFile({ path: 'huge.bin' }, deps)).rejects.toThrow(/attachment limit/);
  });
});
