import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { HELPER_TOOLCHAIN_MANIFEST as manifest } from './helper-toolchain-manifest.js';
it('pins every supported dependency and all transitive npm release bytes', () => {
  expect(JSON.stringify(manifest)).not.toContain('@latest');
  expect(manifest.platforms).toEqual(
    expect.arrayContaining(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']),
  );
  for (const dependency of [manifest.node, ...Object.values(manifest.native)]) {
    expect(dependency.version).toBeTruthy();
    for (const platform of manifest.platforms) {
      const artifact = dependency.platforms[platform as keyof typeof dependency.platforms];
      expect(artifact.url).toMatch(/^https:\/\//);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  }
  for (const bundle of Object.values(manifest.npm)) {
    for (const version of Object.values(bundle.package.dependencies))
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const [path, entry] of Object.entries(bundle.lock.packages)) {
      if (!('resolved' in entry)) continue;
      const targets = manifest.platforms.filter((p) => {
        const [os, cpu] = p.split('-');
        return (
          (!('os' in entry) || entry.os.includes(os!)) &&
          (!('cpu' in entry) || entry.cpu.includes(cpu!))
        );
      });
      if (!targets.length) continue;
      const artifact = (
        bundle.artifacts as Record<
          string,
          { version: string; sha256: string; url: string; platforms: string[] }
        >
      )[path]!;
      expect(artifact.version).toBe(entry.version);
      expect(artifact.url).toBe(entry.resolved);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.platforms).toEqual(targets);
      expect('integrity' in entry && entry.integrity).toBeTruthy();
    }
  }
});

it('keeps the Node-free shell bootstrap aligned with the manifest', async () => {
  const shell = await readFile(
    new URL('../../../relay-stack/web/install.sh', import.meta.url),
    'utf8',
  );
  for (const [platform, spec] of Object.entries(manifest.node.platforms)) {
    const generation = createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
    expect(shell).toContain(
      `${platform}) node_url='${spec.url}'; node_sha='${spec.sha256}'; node_generation='node-${manifest.node.version}-${generation}'`,
    );
  }
  expect(shell).toContain('SHA-256 checksum mismatch');
  expect(shell).not.toContain('command -v node >/dev/null 2>&1 || fail');
});
