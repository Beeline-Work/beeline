import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, lstat, rm, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, delimiter } from 'node:path';
import { promisify } from 'node:util';
import { tryWithKernelLock } from './kernel-lock.js';
import {
  readWarmPlan,
  isPlanRefusal,
  harvestWarmNodeModules,
  seedWarmNodeModules,
  missingInstalledPackages,
  isContainedTreePath,
} from './warm-node-modules.js';

const exec = promisify(execFile);
const marker = '.beeline-generation';
export const dependencyRequest = '.beeline-dependency-request';

/** Requests live in the corner, never in another agent's home or the host /tmp. */
export async function extraDependencyRoots(root: string, home?: string): Promise<string[]> {
  const registry = resolve(root, '.beeline-extra-dependencies');
  const registryInfo = await lstat(registry).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!registryInfo) return [];
  if (!registryInfo.isDirectory() || registryInfo.isSymbolicLink()) throw new Error('Invalid extra dependency registry');
  const entries = await readdir(registry).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (entries.length > 128) throw new Error('Too many extra dependency requests');
  const allowed = await Promise.all([root, ...(home ? [home] : [])].map(path => realpath(path)));
  const roots = new Set<string>();
  for (const name of entries.sort()) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const request = resolve(registry, name);
    const info = await lstat(request);
    if (!info.isFile() || info.size > 8192) throw new Error('Invalid extra dependency request');
    const requested = (await readFile(request, 'utf8')).trim();
    const canonical = await realpath(requested).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!canonical) continue; // A removed disposable rig no longer pins dependencies.
    if (!allowed.some(parent => {
      const child = relative(parent, canonical);
      return child !== '' && child !== '..' && !child.startsWith('../') && !isAbsolute(child);
    })) throw new Error('Extra dependencies must be inside this corner or its agent home');
    roots.add(canonical);
  }
  return [...roots].sort();
}

export async function dependencyFingerprint(root: string, home?: string): Promise<string> {
  return JSON.stringify([
    await Promise.all((await extraDependencyRoots(root, home)).map(async path => [path, await dependencyFingerprintForCopy(path)])),
    await readFile(resolve(root, dependencyRequest), 'utf8').catch(() => ''),
    await Promise.all(
      ['', 'apps/mobile'].map(async (part) => {
        const plan = await readWarmPlan(resolve(root, part));
        return isPlanRefusal(plan) ? plan.failure : plan.key;
      }),
    ),
  ]);
}

async function dependencyFingerprintForCopy(root: string): Promise<string> {
  const plan = await readWarmPlan(root);
  return isPlanRefusal(plan) ? plan.failure : plan.key;
}

/** Called outside the harness, after its previous mount namespace has stopped. */
export async function prepareDependencyGeneration(input: {
  root: string;
  store: string;
  npm: string;
  cache: string;
  install?: () => Promise<void>;
}): Promise<string[]> {
  const withStore = <T>(work: () => Promise<T>) =>
    tryWithKernelLock(`dependency-store:${resolve(input.store)}`, work);
  const plan = await readWarmPlan(input.root);
  const installed = await readFile(resolve(input.root, 'node_modules', marker), 'utf8')
    .then((text) => JSON.parse(text) as { key: string; trees: string[] })
    .catch(() => undefined);
  if (isPlanRefusal(plan)) {
    if (plan.failure === 'unsafe-lockfile') throw new Error('Unsafe dependency lockfile');
    for (const tree of (installed?.trees ?? []).filter(isContainedTreePath))
      await rm(resolve(input.root, tree), { recursive: true, force: true });
    return [];
  }
  if (installed?.key === plan.key && !(await missingInstalledPackages(input.root)).length) {
    return plan.trees.map((tree) => resolve(input.root, tree));
  }
  // npm may run arbitrary install scripts. Remove this copy's shared aliases
  // first, then install privately without owning the shared store.
  for (const tree of new Set([
    ...plan.trees,
    ...(installed?.trees ?? []).filter(isContainedTreePath),
  ])) await rm(resolve(input.root, tree), { recursive: true, force: true });
  let seeded = await withStore(() => seedWarmNodeModules({ worktreePath: input.root, storeRoot: input.store }));
  if (seeded?.reason !== 'seeded') {
    if (input.install) await input.install();
    else await exec(input.npm, ['ci', '--no-audit', '--no-fund'], {
      cwd: input.root,
      env: { ...process.env, npm_config_cache: input.cache },
      maxBuffer: 16 * 1024 * 1024,
    });
    if ((await missingInstalledPackages(input.root)).length)
      throw new Error('Dependency generation failed: incomplete private install');
  }
  // A busy cache never delays this copy: retain its private install and seal
  // it with the same mounts. Only an immediately available owner may share it.
  if (seeded?.reason !== 'seeded') {
    await withStore(async () => {
      const harvested = await harvestWarmNodeModules({ worktreePath: input.root, storeRoot: input.store });
      if (!['stored', 'already-warm'].includes(harvested.reason))
        throw new Error(`Dependency generation failed: ${harvested.reason}`);
      for (const tree of plan.trees)
        await rm(resolve(input.root, tree), { recursive: true, force: true });
      seeded = await seedWarmNodeModules({ worktreePath: input.root, storeRoot: input.store });
      if (seeded.reason !== 'seeded')
        throw new Error(`Dependency generation placement failed: ${seeded.reason}`);
    });
  }
  await writeFile(resolve(input.root, 'node_modules', marker), JSON.stringify(plan));
  return plan.trees.map((tree) => resolve(input.root, tree));
}

/** PATH guard gives npm's normal mutating commands a useful error before EROFS. */
export async function installDependencyNpmGuard(
  root: string,
  npm: string,
  inheritedPath: string,
  dependencyPaths: string[] = [],
): Promise<string> {
  const bin = resolve(root, 'dependency-bin');
  await mkdir(bin, { recursive: true });
  const program = `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
const {existsSync,realpathSync}=require('node:fs');
const {resolve,relative,isAbsolute}=require('node:path');
const prefixIndex=args.indexOf('--prefix');
let privateCi=false;
if(args[0]==='ci' && prefixIndex>=0 && args[prefixIndex+1]) {
 try {
  const target=realpathSync(args[prefixIndex+1]);
  const contains=(a,b)=>{const r=relative(a,b);return r===''||(!r.startsWith('..'+require('node:path').sep)&&r!=='..'&&!isAbsolute(r));};
  privateCi=!existsSync(resolve(target,'node_modules')) && !${JSON.stringify(dependencyPaths)}.some(p=>contains(target,p)||contains(p,target));
 } catch {}
}
const mutations=new Set(['install','i','ci','add','update','up','upgrade','uninstall','remove','rm','rebuild','dedupe','prune','link']);
if(args.some(a=>mutations.has(a)) && !args.includes('--package-lock-only') && !privateCi) {
 console.error('Beeline dependencies are read-only. Use npm install --package-lock-only --ignore-scripts <package> (or edit package.json and package-lock.json). Beeline installs and mounts the new generation automatically at the next turn.');
 process.exit(1);
}
const result=spawnSync(${JSON.stringify(npm)},args.includes('--package-lock-only')?[...args,'--ignore-scripts']:args,{stdio:'inherit'});
if(result.error) throw result.error;
process.exit(result.status??1);
`;
  await writeFile(resolve(bin, 'npm'), program, { mode: 0o755 });
  return `${bin}${delimiter}${inheritedPath}`;
}

/** Hardlinks keep the generation alive until the last checkout releases it. */
export async function collectUnusedGenerations(store: string): Promise<string[]> {
  async function referenced(path: string): Promise<boolean> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory() && (await referenced(child))) return true;
      if (entry.isFile() && (await lstat(child)).nlink > 1) return true;
    }
    return false;
  }
  const removed: string[] = [];
  for (const entry of await readdir(store, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    const path = resolve(store, entry.name);
    if (!(await referenced(path))) {
      await rm(path, { recursive: true, force: true });
      removed.push(entry.name);
    }
  }
  return removed;
}

export async function collectDependencyStore(store: string): Promise<string[]> {
  return await tryWithKernelLock(`dependency-store:${resolve(store)}`, () =>
    collectUnusedGenerations(store),
  ) ?? [];
}
