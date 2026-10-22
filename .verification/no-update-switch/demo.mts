import { mkdtemp } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { resolve } from 'node:path';
const mod = await import(resolve(process.argv[2]!, 'apps/body/src/managed-update.ts'));
for (const flag of [undefined, '1']) {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-demo-'));
  const env = { ...process.env, NODE_ENV: 'production', ...(flag ? { BEELINE_UPDATE_DISABLE: flag } : {}) };
  let started = false;
  const t = new mod.ReleaseTransaction({ layout: { libDir: resolve(root, 'lib/beeline'), releasesRoot: resolve(root, 'r'), binDir: resolve(root, 'bin') },
    loadedRelease: 'old', env, idle: () => false, interrupt() {}, handoff: async () => {}, changed() {}, failed() {},
    prepare: async () => { started = true; } });
  t.notify('published-release-1'); await t.pending; t.dispose();
  console.log(`BEELINE_UPDATE_DISABLE=${flag ?? '(unset)'} -> preparation started: ${started}`);
}
