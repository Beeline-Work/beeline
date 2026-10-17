import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { piStartupEnvironment } from './pi-startup.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(options: { version?: string; custom?: boolean; fail?: boolean; gated?: boolean; originalOptions?: string; relative?: boolean; mutate?: (source: string) => string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-startup-'));
  roots.push(root);
  await mkdir(join(root, 'adapter/dist'), { recursive: true });
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'adapter/package.json'), JSON.stringify({ name: 'pi-acp', type: 'module' }));
  const entry = join(root, 'adapter/dist/index.js');
  // Exercise the actual load hook and the same session/new notice call sites.
  let source = `
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
function buildUpdateNotice() { spawnSync('npm', ['view']); return 'unexpected update'; }
function buildStartupInfo(opts) {
  void opts;
  const md = [];
  try {
    const piVersion = spawnSync("pi", ["--version"], { encoding: "utf-8" });
    md.push(piVersion.stdout);
  } catch {}
  const addSection = () => {};
  addSection();
  return md.join('\\n');
}
function getQuietStartup() { return false; }
const server = {
 conn: { sessionUpdate: async event => console.log(JSON.stringify({ event })) },
  async newSession(params) {
    if (params.environment) return { nodeOptions: process.env.NODE_OPTIONS ?? null };
    void this.conn;
    const session = { sessionId: 'private-room' };
    const quietStartup = getQuietStartup(params.cwd);
    const updateNotice = buildUpdateNotice();
    const banner = quietStartup ? '' : buildStartupInfo({ cwd: params.cwd });
    return { banner, updateNotice };
 }
};
createInterface({ input: process.stdin }).on('line', async line => {
 console.log(JSON.stringify({ result: await server.newSession(JSON.parse(line)) }));
});
`;
  source = options.mutate?.(source) ?? source;
  await writeFile(entry, source);
  const selected = join(root, 'bin', options.custom ? 'custom-pi' : 'pi');
  const finish = options.fail ? 'process.exit(1)' : `console.log('9.8.7'); process.exit(0);`;
  const versionBody = options.gated
    ? `setInterval(() => { if (require('fs').existsSync(${JSON.stringify(join(root, 'release'))})) { ${finish} } }, 20);`
    : `setTimeout(() => { ${finish} }, 500);`;
  await writeFile(selected, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(join(root, 'probe'))}, 'called'); ${versionBody}\n`, { mode: 0o755 });
  if (options.version) {
    await mkdir(join(root, 'selected'));
    // Bin must live under its package for npm-style metadata discovery.
    const actual = join(root, 'selected/pi.js');
    await writeFile(actual, `#!/usr/bin/env node\nthrow Error('version process must never run');\n`, { mode: 0o755 });
    await writeFile(join(root, 'selected/package.json'), JSON.stringify({ name: 'custom-pi', version: options.version, bin: { pi: 'pi.js' } }));
    await rm(selected);
    await symlink(actual, selected);
  }
  // A registry child would fail loudly if the hook accidentally retained it.
  await writeFile(join(root, 'bin/npm'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const env = piStartupEnvironment('pi-acp', {
    ...process.env as Record<string, string>,
    PATH: join(root, 'shadow/bin') + ':' + join(root, 'bin') + ':' + process.env.PATH,
    ...(options.originalOptions ? { NODE_OPTIONS: options.originalOptions } : {}),
    ...(options.custom ? { PI_ACP_PI_COMMAND: options.relative ? './custom-pi' : selected } : {}),
  });
  const child = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const messages: any[] = [];
  const waiters: (() => void)[] = [];
  createInterface({ input: child.stdout }).on('line', line => { messages.push(JSON.parse(line)); waiters.splice(0).forEach(resolve => resolve()); });
  async function next() {
    const deadline = Date.now() + 5000;
    while (!messages.length) {
      if (child.exitCode !== null) throw Error(stderr);
      if (Date.now() > deadline) throw Error('timed out: ' + stderr);
      await Promise.race([new Promise<void>(resolve => waiters.push(resolve)), new Promise(resolve => setTimeout(resolve, 20))]);
    }
    return messages.shift();
  }
  return { root, child, next, selected, source };
}

it('leaves other harness environments untouched', () => {
  const env = { PATH: '/bin' };
  expect(piStartupEnvironment('codex-acp', env)).toBe(env);
});

it.each([false, true])('reports the selected pinned executable version without running a child (override=%s)', async custom => {
  const f = await fixture({ version: '7.6.5', custom });
  try {
    f.child.stdin.write('{}\n');
    const response = await f.next();
    expect(response.result).toEqual({ banner: 'pi v7.6.5\n---\n', updateNotice: null });
    await expect(readFile(join(f.root, 'probe'))).rejects.toThrow();
  } finally { f.child.kill(); }
});

it('returns session/new before a slow custom version probe and reports its actual version later', async () => {
  const f = await fixture({ custom: true, gated: true });
  try {
    f.child.stdin.write('{}\n');
    expect((await f.next()).result).toEqual({ banner: '', updateNotice: null });
    // The version child cannot finish until after session/new has answered.
    await writeFile(join(f.root, 'release'), 'ready');
    const event = (await f.next()).event;
    expect(event.update).toEqual({ sessionUpdate: 'session_info_update', _meta: { piAcp: { version: '9.8.7' } } });
    expect(await readFile(join(f.root, 'probe'), 'utf8')).toBe('called');
  } finally { f.child.kill(); }
});

it('survives a failed background version probe and serves another session', async () => {
  const f = await fixture({ custom: true, fail: true });
  try {
    f.child.stdin.write('{}\n');
    expect((await f.next()).result.updateNotice).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 800));
    f.child.stdin.write('{}\n');
    expect((await f.next()).result.updateNotice).toBeNull();
  } finally { f.child.kill(); }
});

it.each([undefined, '--no-warnings'])('restores original child NODE_OPTIONS (%s)', async originalOptions => {
  const f = await fixture({ version: '7.6.5', originalOptions });
  try {
    f.child.stdin.write('{"environment":true}\n');
    expect((await f.next()).result.nodeOptions).toBe(originalOptions ?? process.env.NODE_OPTIONS ?? null);
  } finally { f.child.kill(); }
});

it('resolves a relative custom executable in session/new cwd', async () => {
  const f = await fixture({ version: '4.3.2', custom: true, relative: true });
  try {
    f.child.stdin.write(JSON.stringify({ cwd: join(f.root, 'bin') }) + '\n');
    expect((await f.next()).result.banner).toBe('pi v4.3.2\n---\n');
  } finally { f.child.kill(); }
});

it('skips a non-executable PATH entry when identifying the Pi that runs', async () => {
  const f = await fixture({ version: '7.6.5' });
  try {
    await mkdir(join(f.root, 'shadow/bin'), { recursive: true });
    await writeFile(join(f.root, 'shadow/package.json'), JSON.stringify({ version: '0.0.1', bin: { pi: 'bin/pi' } }));
    await writeFile(join(f.root, 'shadow/bin/pi'), 'not executable', { mode: 0o644 });
    f.child.stdin.write('{}\n');
    expect((await f.next()).result.banner).toBe('pi v7.6.5\n---\n');
  } finally { f.child.kill(); }
});

const changedStartup = [
  ['updateNotice', (source: string) => source.replace('const updateNotice = buildUpdateNotice();', 'const updateNotice = (buildUpdateNotice());')],
  ['quietStartup', (source: string) => source.replace('const quietStartup = getQuietStartup(params.cwd);', 'const quietStartup = (getQuietStartup(params.cwd));')],
  ['version block', (source: string) => source.replace('spawnSync("pi", ["--version"]', 'spawnSync("pi", ["--version", "--plain"]')],
  ['md', (source: string) => source.replace(/\bmd\b/g, 'markdown')],
  ['this.conn', (source: string) => source.replace(/\bconn\b/g, 'connection')],
  ['session', (source: string) => source.replace(/\bsession\b/g, 'activeSession')],
] as const;

async function loadSource(source: string) {
  const env = piStartupEnvironment('pi-acp', {});
  const preload = decodeURIComponent(env.NODE_OPTIONS!.split('data:text/javascript,')[1]);
  const loaderUrl = JSON.parse(preload.match(/register\(("(?:\\.|[^"\\])*")/)![1]);
  const loader = await import(/* @vite-ignore */ loaderUrl);
  loader.initialize({ entry: 'file:///adapter.js' });
  const result = { format: 'module', source };
  return { result, loaded: await loader.load('file:///adapter.js', {}, async () => result) };
}

it.each(changedStartup)('falls back byte for byte when %s changes', async (_name, mutate) => {
  const f = await fixture({ mutate });
  try {
    const { result, loaded } = await loadSource(f.source);
    expect(loaded).toBe(result);
    expect(loaded.source).toBe(f.source);
  } finally { f.child.kill(); }
});

it.each(changedStartup)('Reproduction pi-startup-fallback: session/new succeeds when %s changes', async (_name, mutate) => {
  const f = await fixture({ mutate });
  try {
    f.child.stdin.write('{}\n');
    const response = await f.next();
    expect(response.result.updateNotice).toBe('unexpected update');
    expect(response.result.banner).toContain('9.8.7');
  } finally { f.child.kill(); }
});
