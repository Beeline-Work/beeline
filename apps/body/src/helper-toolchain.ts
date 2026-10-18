import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { withAdapterInstallLock } from './adapter-install-lock.js';
import { HELPER_TOOLCHAIN_MANIFEST } from './helper-toolchain-manifest.js';

interface Artifact {
  url: string;
  sha256: string;
}
interface NativeArtifact extends Artifact {
  binary: string;
  format: string;
  strip?: number;
  args?: string[];
}
interface NpmBundle {
  package: { dependencies: Record<string, string> };
  lock: unknown;
  artifacts: Record<string, Artifact & { platforms: string[]; version: string }>;
}
interface Manifest {
  platforms: string[];
  node: { version: string; platforms: Record<string, Artifact> };
  npm: Record<string, NpmBundle>;
  native: Record<string, { version: string; platforms: Record<string, NativeArtifact> }>;
}
const manifest: Manifest = HELPER_TOOLCHAIN_MANIFEST;
const exec = promisify(execFile);
const platform = `${process.platform}-${process.arch}`;
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

export function helperToolchainRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local/share'),
    'beeline/toolchain',
  );
}
function generation(name: string, spec: unknown, env: NodeJS.ProcessEnv): string {
  return join(helperToolchainRoot(env), `${name}-${digest(spec)}`);
}
function nodeRoot(env: NodeJS.ProcessEnv): string {
  return generation(`node-${manifest.node.version}`, manifest.node.platforms[platform], env);
}
function npmRoot(kind: string, env: NodeJS.ProcessEnv): string {
  return generation(kind, manifest.npm[kind], env);
}
function nativeRoot(kind: string, env: NodeJS.ProcessEnv): string {
  return generation(kind, manifest.native[kind], env);
}

/** Published generations precede user installations for both adapters and their children. */
export function helperToolchainBins(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    join(nodeRoot(env), 'bin'),
    ...Object.keys(manifest.npm).map((kind) => join(npmRoot(kind, env), 'node_modules/.bin')),
    ...Object.keys(manifest.native).map((kind) => join(nativeRoot(kind, env), 'bin')),
  ].filter(
    (path) =>
      existsSync(path) &&
      existsSync(
        join(
          path.endsWith('node_modules/.bin') ? dirname(dirname(path)) : dirname(path),
          '.complete',
        ),
      ),
  );
}
export function helperToolchainEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: [...helperToolchainBins(env), env.PATH || ''].join(delimiter),
    DISABLE_AUTOUPDATER: '1',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
  };
}

async function verifyToolchainDownload(path: string, expected: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('missing SHA-256');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error('SHA-256 checksum mismatch');
}

async function download(artifact: Artifact, path: string, label: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(artifact.url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new Error(`download HTTP ${response.status}`);
      const file = await open(path, 'w', 0o600);
      try {
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 1024 ** 3) throw new Error('download exceeds 1 GiB');
          await file.write(chunk);
        }
      } finally {
        await file.close();
      }
      await verifyToolchainDownload(path, artifact.sha256);
      return;
    } catch (error) {
      await rm(path, { force: true });
      if (attempt === 3 || String(error).includes('checksum'))
        throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      await new Promise((done) => setTimeout(done, 500 * 2 ** attempt));
    }
  }
}

/** A completion marker is published with the generation, never before it. */
async function publish(
  name: string,
  target: string,
  build: (stage: string) => Promise<void>,
): Promise<boolean> {
  const root = dirname(target);
  const prune = async () => {
    for (const entry of await readdir(root)) {
      const previous = join(root, entry);
      if (!entry.startsWith(`${name}-`) || previous === target) continue;
      if (name === 'node') {
        // Installed launchers record process.execPath. Preserve that path as a
        // tiny alias while removing the superseded runtime's actual bytes.
        const destination = target.slice(root.length + 1);
        if ((await readlink(previous).catch(() => undefined)) === destination) continue;
        const alias = join(root, `.node-alias-${randomUUID()}`);
        const retired = join(root, `.node-retired-${randomUUID()}`);
        await symlink(destination, alias);
        await rename(previous, retired);
        try {
          await rename(alias, previous);
        } catch (error) {
          await rename(retired, previous);
          throw error;
        } finally {
          await rm(alias, { force: true });
        }
        await rm(retired, { recursive: true, force: true });
      } else await rm(previous, { recursive: true, force: true });
    }
  };
  if (existsSync(join(target, '.complete'))) {
    await prune();
    return false;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stage = join(root, `.staging-${name}-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    await build(stage);
    await writeFile(join(stage, '.complete'), '1\n');
    // A directory without its marker is not a published generation.
    if (existsSync(target)) await rm(target, { recursive: true, force: true });
    await rename(stage, target);
    await prune();
    return true;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function extract(archive: string, stage: string, strip: number): Promise<void> {
  await exec('tar', ['-xzf', archive, '-C', stage, `--strip-components=${strip}`], {
    timeout: 180_000,
  });
}

/** Install only the selected kind; a release change replaces its entire locked dependency graph. */
export async function ensureHelperToolchain(
  kind: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!(kind in manifest.npm) && !(kind in manifest.native)) return false;
  if (!manifest.platforms.includes(platform))
    throw new Error(`Helper toolchain does not support ${platform}`);
  return withAdapterInstallLock(async () => {
    const nodeSpec = manifest.node.platforms[platform]!;
    let dependency = `Node ${manifest.node.version}`;
    try {
      let changed = await publish('node', nodeRoot(env), async (stage) => {
        const archive = join(stage, 'node.tar.gz');
        await download(nodeSpec, archive, dependency);
        await extract(archive, stage, 1);
        await rm(archive);
        await exec(join(stage, 'bin/node'), ['--version']);
      });
      const bundle = manifest.npm[kind];
      if (bundle) {
        dependency = Object.entries(bundle.package.dependencies)
          .map(([name, version]) => `${name} ${version}`)
          .join(', ');
        changed =
          (await publish(kind, npmRoot(kind, env), async (stage) => {
            const cache = join(stage, '.npm-cache');
            const downloads = join(stage, '.downloads');
            await mkdir(downloads);
            await writeFile(join(stage, 'package.json'), JSON.stringify(bundle.package));
            await writeFile(join(stage, 'package-lock.json'), JSON.stringify(bundle.lock));
            const artifacts = Object.entries(bundle.artifacts).filter(([, spec]) =>
              spec.platforms.includes(platform),
            );
            let index = 0;
            const downloaded: { url: string; path: string }[] = [];
            const downloadsFinished = await Promise.allSettled(
              Array.from({ length: 4 }, async () => {
                for (;;) {
                  const item = index++;
                  const artifact = artifacts[item];
                  if (!artifact) break;
                  const [packagePath, spec] = artifact;
                  const path = join(downloads, `${item}.tgz`);
                  await download(
                    spec,
                    path,
                    `${packagePath.split('node_modules/').at(-1)} ${spec.version}`,
                  );
                  downloaded.push({ url: spec.url, path });
                }
              }),
            );
            const failed = downloadsFinished.find((result) => result.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
            const node = join(nodeRoot(env), 'bin/node');
            const npm = join(nodeRoot(env), 'lib/node_modules/npm/bin/npm-cli.js');
            const installEnv = {
              ...helperToolchainEnvironment(env),
              npm_config_cache: cache,
              npm_config_global: 'false',
              npm_config_prefix: stage,
              npm_config_userconfig: join(stage, '.npmrc'),
              npm_config_globalconfig: join(stage, '.npmrc-global'),
              npm_config_update_notifier: 'false',
              npm_config_logs_dir: join(cache, '_logs'),
            };
            const run = (args: string[]) =>
              exec(node, [npm, ...args], {
                env: installEnv,
                cwd: stage,
                timeout: 300_000,
                maxBuffer: 1024 * 1024,
              });
            // Pi publishes a nested shrinkwrap. Seed URL responses as well as content
            // so npm can honor it offline even where it omits an integrity field.
            const seed = join(stage, '.seed-cache.cjs');
            await writeFile(
              seed,
              `
const { createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { createRequire } = require('node:module');
const npmRequire = createRequire(process.argv[2]);
const cacache = npmRequire('cacache');
(async () => {
  for (const item of JSON.parse(process.argv[4])) {
    await pipeline(createReadStream(item.path), cacache.put.stream(process.argv[3],
      'make-fetch-happen:request-cache:' + item.url, { metadata: {
        time: Date.now(), url: item.url, reqHeaders: {},
        resHeaders: { 'cache-control': 'public, max-age=31536000', 'content-type': 'application/octet-stream' },
        options: { compress: true }
      } }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
            );
            await exec(
              node,
              [
                seed,
                join(nodeRoot(env), 'lib/node_modules/npm/package.json'),
                join(cache, '_cacache'),
                JSON.stringify(downloaded),
              ],
              { env: installEnv, cwd: stage, timeout: 60_000, maxBuffer: 16_384 },
            );
            await rm(seed);
            await run([
              'ci',
              '--prefix',
              stage,
              '--offline',
              '--ignore-scripts',
              '--no-audit',
              '--no-fund',
            ]);
            await rm(cache, { recursive: true, force: true });
            await rm(downloads, { recursive: true, force: true });
          })) || changed;
      } else {
        const native = manifest.native[kind]!;
        dependency = `${kind} ${native.version}`;
        const spec = native.platforms[platform]!;
        changed =
          (await publish(kind, nativeRoot(kind, env), async (stage) => {
            const archive = join(stage, '.download');
            await download(spec, archive, dependency);
            if (spec.format === 'tar') {
              await extract(archive, stage, spec.strip || 0);
              await rm(archive);
            } else await rename(archive, join(stage, spec.binary));
            await chmod(join(stage, spec.binary), 0o755);
            await mkdir(join(stage, 'bin'), { recursive: true });
            const binary = kind === 'cursor' ? 'cursor-agent' : kind;
            if (spec.args?.length) {
              await writeFile(
                join(stage, 'bin', binary),
                `#!/bin/sh
exec "$(dirname "$0")/../${spec.binary}" ${spec.args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ')} "$@"
`,
                { mode: 0o755 },
              );
            } else if (join(stage, spec.binary) !== join(stage, 'bin', binary)) {
              await symlink(join('..', spec.binary), join(stage, 'bin', binary));
            }
          })) || changed;
      }
      return changed;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not install ${detail.startsWith(dependency + ':') ? detail : dependency + ': ' + detail}. Retry starting the agent.`,
        { cause: error },
      );
    }
  }, env);
}
