import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, link, symlink, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleHelperUsage } from './helper-usage.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe.skipIf(process.platform !== 'linux')('host usage observations', () => {
  it('counts allocated blocks once, does not follow links, and preserves directory access time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-usage-')); roots.push(root);
    const modules = join(root, 'corners', 'example', 'node_modules');
    await mkdir(modules, { recursive: true });
    const file = join(modules, 'package');
    await writeFile(file, 'x'.repeat(8192));
    await link(file, join(modules, 'duplicate'));
    await symlink('/usr', join(root, 'external'));
    const old = new Date('2000-01-01'); await utimes(modules, old, old);
    const result = await sampleHelperUsage(root, 'disk') as { categories: Record<string, { allocatedBytes: number; entries: number }>; errors: number };
    expect(result.errors).toBe(0);
    expect(result.categories['corners:dependencies'].entries).toBe(2);
    expect(result.categories['corners:dependencies'].allocatedBytes).toBe(((await stat(file)).blocks + (await stat(modules)).blocks) * 512);
    expect(result.categories['external:other'].entries).toBe(1);
    expect((await stat(modules)).atimeMs).toBe(old.getTime());
  });
  it('observes the calling helper without reporting command arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-usage-')); roots.push(root);
    const result = await sampleHelperUsage(root, 'process') as { categories: Record<string, { count: number; rssBytes: number }> };
    expect(result.categories.helper.count).toBe(1);
    expect(result.categories.helper.rssBytes).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(root);
  });
});
