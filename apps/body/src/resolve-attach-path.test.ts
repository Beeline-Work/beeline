import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindBriefFiles, postArtifact, resolveAttachPath, type PostArtifactDeps } from './read-only-mcp.js';

describe('attachment home shortcut', () => {
  let root: string;
  let home: string;
  let checkout: string;
  let roots: string[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'attach-home-'));
    home = join(root, 'home');
    checkout = join(root, 'checkout');
    mkdirSync(home);
    mkdirSync(checkout);
    roots = [checkout, home];
    vi.stubEnv('HOME', home);
    writeFileSync(join(home, 'notes.txt'), 'File for delivery');
    writeFileSync(join(root, 'outside.txt'), 'Private');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('Reproduction artifact-tilde-path: resolves a file in the shell home', () => {
    expect(resolveAttachPath(roots, '~/notes.txt')).toBe(realpathSync(join(home, 'notes.txt')));
  });

  it('keeps absolute and checkout-relative paths working', () => {
    expect(resolveAttachPath(roots, join(home, 'notes.txt'))).toBe(realpathSync(join(home, 'notes.txt')));
    writeFileSync(join(checkout, 'local.txt'), 'Local');
    expect(resolveAttachPath(roots, 'local.txt')).toBe(realpathSync(join(checkout, 'local.txt')));
  });

  it('refuses absolute, home traversal and symlink escapes', () => {
    symlinkSync(join(root, 'outside.txt'), join(home, 'link.txt'));
    for (const path of [join(root, 'outside.txt'), '~/../outside.txt', '~/link.txt']) {
      expect(() => resolveAttachPath(roots, path)).toThrow(/outside your checkout/);
    }
    expect(() => resolveAttachPath([checkout], '~/notes.txt')).toThrow(/outside your checkout/);
  });

  it('leaves username and embedded tildes literal', () => {
    for (const dir of ['~someone', 'nested/~']) {
      mkdirSync(join(checkout, dir), { recursive: true });
      writeFileSync(join(checkout, dir, 'notes.txt'), 'Literal');
      expect(resolveAttachPath(roots, `${dir}/notes.txt`)).toBe(realpathSync(join(checkout, dir, 'notes.txt')));
    }
  });

  it('delivers home-shortcut bytes through artifact and brief attachment paths', async () => {
    const uploaded: Buffer[] = [];
    const queued: unknown[] = [];
    const deps: PostArtifactDeps = {
      roomId: 'fixture', roots,
      upload: async (bytes) => {
        uploaded.push(bytes);
        return { url: '/v1/media/11111111-1111-4111-8111-111111111111' };
      },
      queue: async (attachment) => { queued.push(attachment); },
    };
    await postArtifact({ path: '~/notes.txt' }, deps);
    const brief = await bindBriefFiles({ attachments: [{ path: '~/notes.txt' }] }, deps);
    expect(uploaded.map((bytes) => bytes.toString())).toEqual(['File for delivery', 'File for delivery']);
    expect(queued).toHaveLength(2);
    expect(brief.attachments).toEqual([expect.objectContaining({ objectId: '11111111-1111-4111-8111-111111111111' })]);
  });
});
