import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectBwrapSandbox, sandboxMountPlan, wrapAgentCommand } from './bwrap-sandbox.js';
import { installCornerGitHubWrappers } from './corner-github-auth.js';
import {
  isolatedSharedAssetCategories, prepareCodexCacheTargets, preparePackageCacheTargets, preparePrivateAssets, prepareWorkspaceAdapter, prepareWorkspaceAssets, prepareWorkspaceAvdBase,
  sharedAssetsEnabled, workspaceAssetRoot, workspaceCacheEnv,
} from './workspace-assets.js';

const roots: string[] = [];
const bwrapUsable = Boolean(detectBwrapSandbox().path);
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('coarse Workspace assets', () => {
  it('maps approved categories to an agent-private cache and returns to shared paths after revocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-unshare-'));
    roots.push(root);
    const assets = await prepareWorkspaceAssets(workspaceAssetRoot(root, 'A'));
    const runtime = resolve(root, 'beeline/agents/agent-a');
    const home = resolve(runtime, 'rooms/room-a/agent-home');
    const privateAssetRoot = resolve(runtime, 'private-assets');
    await mkdir(home, { recursive: true });
    await prepareCodexCacheTargets(resolve(home, 'codex'));
    await preparePackageCacheTargets(resolve(home, 'user'));
    await writeFile(resolve(runtime, 'runtime.json'), '{}');
    const active = isolatedSharedAssetCategories({ grants: [
      { kind: 'shared_asset', target: 'package-cache', status: 'approved' },
      { kind: 'shared_asset', target: 'codex-download-cache', status: 'approved' },
      { kind: 'shared_asset', target: 'codex-plugin-cache', status: 'denied' },
    ] });
    await preparePrivateAssets(privateAssetRoot, active);
    expect(workspaceCacheEnv(assets, undefined, privateAssetRoot).npm_config_cache)
      .toBe(resolve(privateAssetRoot, 'cache/npm'));
    const plan = sandboxMountPlan({ mode: 'readonly', cwd: resolve(runtime, 'rooms/room-a'),
      sharedLayout: { assetRoot: assets.root, agentRuntimeDir: runtime, privateHomeRoot: home,
        codexHome: resolve(home, 'codex'), packageHome: resolve(home, 'user'),
        privateAssetRoot, isolatedCategories: active } });
    expect(plan.requiredMounts).toContainEqual({
      source: resolve(privateAssetRoot, 'cache/npm'), target: resolve(assets.cache, 'npm'), mode: 'bind',
    });
    expect(plan.requiredMounts).toContainEqual({
      source: resolve(privateAssetRoot, 'cache/codex/download'),
      target: resolve(home, 'codex/cache'), mode: 'bind',
    });
    expect(plan.requiredMounts).toContainEqual({
      source: resolve(assets.cache, 'codex/plugins'),
      target: resolve(home, 'codex/plugins/cache'), mode: 'bind',
    });
    if (bwrapUsable) {
      const wrapped = wrapAgentCommand({ bwrapPath: '/usr/bin/bwrap',
        spec: { mode: 'readonly', cwd: resolve(runtime, 'rooms/room-a'),
          sharedLayout: { assetRoot: assets.root, agentRuntimeDir: runtime, privateHomeRoot: home,
            codexHome: resolve(home, 'codex'), packageHome: resolve(home, 'user'),
            privateAssetRoot, isolatedCategories: active } },
        command: '/bin/sh', args: ['-c', 'printf private > "$npm_config_cache/probe"; test -f "$1"',
          'probe', resolve(assets.cache, 'npm/probe')],
      });
      const run = spawnSync(wrapped.command, wrapped.args, {
        encoding: 'utf8', env: { ...process.env,
          ...workspaceCacheEnv(assets, undefined, privateAssetRoot) },
      });
      expect(run.status, run.stderr).toBe(0);
      expect(await readFile(resolve(privateAssetRoot, 'cache/npm/probe'), 'utf8')).toBe('private');
      await expect(readFile(resolve(assets.cache, 'npm/probe'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const revoked = isolatedSharedAssetCategories({ grants: [
      { kind: 'shared_asset', target: 'package-cache', status: 'revoked' },
    ] });
    expect(revoked).toEqual([]);
    expect(workspaceCacheEnv(assets).npm_config_cache).toBe(resolve(assets.cache, 'npm'));
  });
  it('keeps one asset root per Workspace and leaves harness HOME private', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-assets-'));
    roots.push(root);
    const a = await prepareWorkspaceAssets(workspaceAssetRoot(root, 'A'));
    const b = await prepareWorkspaceAssets(workspaceAssetRoot(root, 'B'));
    expect(a.root).not.toBe(b.root);
    expect(workspaceCacheEnv(a, resolve(root, 'corner')).npm_config_cache).toBe(resolve(a.cache, 'npm'));
    expect(workspaceCacheEnv(a).PLAYWRIGHT_BROWSERS_PATH).toBe(resolve(a.cache, 'browser/playwright'));
    expect(workspaceCacheEnv(a, resolve(root, 'corner')).CARGO_TARGET_DIR).toBe(resolve(root, 'corner/.beeline-cargo-target'));
    expect(workspaceCacheEnv(a)).not.toHaveProperty('PIP_CACHE_DIR');
    expect(sharedAssetsEnabled({ BEELINE_SHARED_ASSETS_ENABLED: '0' })).toBe(false);
    expect(sharedAssetsEnabled({})).toBe(true);
  });

  it('pins both adapter and nested CLI in versioned, immutable Workspace generations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-toolchain-'));
    roots.push(root);
    const assets = await prepareWorkspaceAssets(workspaceAssetRoot(root, 'A'));
    const bin = resolve(root, 'bin');
    await mkdir(bin);
    for (const [binary, name] of [
      ['codex-acp', '@agentclientprotocol/codex-acp'], ['codex', '@openai/codex'],
    ]) {
      const pkg = resolve(root, binary);
      await mkdir(resolve(pkg, 'bin'), { recursive: true });
      await writeFile(resolve(pkg, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
      await writeFile(resolve(pkg, 'bin/run.js'), '#!/usr/bin/env node\n');
      await chmod(resolve(pkg, 'bin/run.js'), 0o755);
      await symlink(resolve(pkg, 'bin/run.js'), resolve(bin, binary));
    }
    const npm = resolve(bin, 'npm');
    await writeFile(npm, '#!/bin/sh\nwhile [ "$1" != "--prefix" ]; do shift; done\nshift\nprefix="$1"\nmkdir -p "$prefix/node_modules/.bin"\nprintf "#!/bin/sh\\nexit 0\\n" > "$prefix/node_modules/.bin/codex-acp"\nprintf "#!/bin/sh\\nexit 0\\n" > "$prefix/node_modules/.bin/codex"\n');
    await chmod(npm, 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const first = await prepareWorkspaceAdapter(assets, 'codex', 'codex-acp', env);
    expect(first?.command).toContain(assets.tools);
    expect(first?.cliCommand).toContain(assets.tools);
    expect(await prepareWorkspaceAdapter(assets, 'codex', 'codex-acp', env)).toEqual(first);
    await writeFile(resolve(root, 'codex/package.json'), JSON.stringify({ name: '@openai/codex', version: '2.0.0' }));
    const second = await prepareWorkspaceAdapter(assets, 'codex', 'codex-acp', env);
    expect(second?.command).not.toBe(first?.command);
    const runtime = resolve(root, 'beeline/agents/agent-a');
    const home = resolve(runtime, 'rooms/room-a/agent-home');
    await mkdir(home, { recursive: true });
    await writeFile(resolve(runtime, 'runtime.json'), '{}');
    if (bwrapUsable) {
      const update = wrapAgentCommand({
        bwrapPath: '/usr/bin/bwrap',
        spec: { mode: 'readonly', cwd: resolve(runtime, 'rooms/room-a'),
          sharedLayout: { assetRoot: assets.root, agentRuntimeDir: runtime, privateHomeRoot: home } },
        command: '/bin/sh', args: ['-c', 'printf changed > "$1"', 'probe', first!.command],
      });
      expect(spawnSync(update.command, update.args, { encoding: 'utf8' }).status).not.toBe(0);
    }
    expect(await readFile(first!.command, 'utf8')).toContain('exit 0');
    expect(await prepareWorkspaceAdapter(assets, 'goose', '/usr/bin/goose', env)).toBeUndefined();
  });

  it('publishes AVD metadata without copying or hashing the operator SDK', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-android-assets-'));
    roots.push(root);
    const assets = await prepareWorkspaceAssets(workspaceAssetRoot(root, 'A'));
    const avd = resolve(root, 'operator-avd');
    await mkdir(resolve(avd, 'test.avd'), { recursive: true });
    await writeFile(resolve(avd, 'test.ini'), `path=${resolve(avd, 'test.avd')}\ntarget=android-36\n`);
    await writeFile(resolve(avd, 'test.avd/config.ini'), 'image.sysdir.1=system-images/android-36/\n');
    const [base, sameBase] = await Promise.all([
      prepareWorkspaceAvdBase(assets, avd), prepareWorkspaceAvdBase(assets, avd),
    ]);
    expect(base).toBe(sameBase);
    expect(assets).not.toHaveProperty('sdk');
    expect(await readFile(resolve(base, 'test.avd/config.ini'), 'utf8')).toContain('image.sysdir');
  });

  it.skipIf(!bwrapUsable)('masks other Rooms and Workspaces while restoring a repository-free cwd and required assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-assets-bwrap-'));
    roots.push(root);
    const assets = await prepareWorkspaceAssets(workspaceAssetRoot(root, 'A'));
    const other = await prepareWorkspaceAssets(workspaceAssetRoot(root, 'B'));
    const runtimeDir = resolve(root, 'beeline/agents/agent-a');
    const room = resolve(runtimeDir, 'rooms/room-a');
    const home = resolve(room, 'agent-home');
    const codegraph = resolve(room, '.codegraph');
    const sibling = resolve(root, 'beeline/agents/agent-b/rooms/room-b');
    for (const path of [home, codegraph, sibling]) await mkdir(path, { recursive: true });
    await writeFile(resolve(runtimeDir, 'runtime.json'), '{}');
    await writeFile(resolve(room, 'source.txt'), 'own');
    await writeFile(resolve(sibling, 'secret.txt'), 'sibling');
    await writeFile(resolve(other.cache, 'other.txt'), 'other');
    const spec = {
      mode: 'readonly' as const,
      cwd: room,
      additionalWritablePaths: [codegraph],
      sharedLayout: {
        assetRoot: assets.root,
        agentRuntimeDir: runtimeDir,
        privateHomeRoot: home,
      },
    };
    const command = wrapAgentCommand({
      bwrapPath: '/usr/bin/bwrap',
      spec,
      command: '/bin/sh',
      args: ['-c', [
        'test "$(cat source.txt)" = own',
        'test ! -e "$1"',
        'test ! -e "$2"',
        'test -f "$3"',
        'touch .codegraph/writable',
        'if echo changed > "$3" 2>/dev/null; then exit 41; fi',
        'if echo changed > "$4/changed" 2>/dev/null; then exit 42; fi',
        'test ! -e "$5"',
      ].join(' && '), 'probe', resolve(sibling, 'secret.txt'), resolve(other.cache, 'other.txt'),
        resolve(runtimeDir, 'runtime.json'), assets.tools, assets.staging],
    });
    const result = spawnSync(command.command, command.args, { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(resolve(codegraph, 'writable'), 'utf8')).toBe('');
    expect(await readFile(resolve(runtimeDir, 'runtime.json'), 'utf8')).toBe('{}');
    await rm(resolve(home), { recursive: true });
    expect(() => wrapAgentCommand({ bwrapPath: '/usr/bin/bwrap', spec, command: '/bin/true' }))
      .toThrow('required sandbox mount');
  });

  it.skipIf(!bwrapUsable)('shares only Codex downloads and installed packages across private Room homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-codex-cache-'));
    roots.push(root);
    const assets = await prepareWorkspaceAssets(workspaceAssetRoot(root, 'A'));
    const homes = ['a', 'b'].map((name) => resolve(root, `beeline/agents/${name}/rooms/one/agent-home`));
    await Promise.all(homes.map(async (home) => {
      await mkdir(home, { recursive: true });
      await mkdir(resolve(home, 'user'), { recursive: true });
      await prepareCodexCacheTargets(resolve(home, 'codex'));
      await preparePackageCacheTargets(resolve(home, 'user'));
      await writeFile(resolve(home, 'codex/config.toml'), `room="${home}"\n`);
      await mkdir(resolve(home, 'codex/sessions'), { recursive: true });
      await writeFile(resolve(home, 'codex/sessions/history'), home);
      await writeFile(resolve(home, 'codex/plugins/data-private'), home);
      await mkdir(resolve(home, 'user/.gradle/caches'), { recursive: true });
      await writeFile(resolve(home, 'user/.gradle/gradle.properties'), home);
      await writeFile(resolve(home, '../../..', 'runtime.json'), '{}');
    }));
    const run = (home: string, marker: string) => {
      const command = wrapAgentCommand({
        bwrapPath: '/usr/bin/bwrap',
        spec: {
          mode: 'readonly', cwd: home,
          sharedLayout: {
            assetRoot: assets.root,
            agentRuntimeDir: resolve(home, '../../..'),
            privateHomeRoot: home,
            codexHome: resolve(home, 'codex'),
            packageHome: resolve(home, 'user'),
          },
        },
        command: '/bin/sh',
        args: ['-c', 'printf "%s" "$1" > codex/cache/download; printf "%s" "$1" > codex/plugins/cache/package; printf "%s" "$1" > user/.gradle/caches/build-output; printf "%s" "$1" > user/.cargo/registry/crate; test "$(cat codex/sessions/history)" = "$2"; test "$(cat codex/config.toml)" = "room=\\\"$2\\\""; test "$(cat codex/plugins/data-private)" = "$2"; test "$(cat user/.gradle/gradle.properties)" = "$2"', 'probe', marker, home],
      });
      return spawnSync(command.command, command.args, { encoding: 'utf8' });
    };
    expect(run(homes[0]!, 'one').status).toBe(0);
    expect(run(homes[1]!, 'two').status).toBe(0);
    expect(await readFile(resolve(assets.cache, 'codex/download/download'), 'utf8')).toBe('two');
    expect(await readFile(resolve(assets.cache, 'codex/plugins/package'), 'utf8')).toBe('two');
    expect(await readFile(resolve(homes[0]!, 'user/.gradle/caches/build-output'), 'utf8')).toBe('one');
    expect(await readFile(resolve(homes[1]!, 'user/.gradle/caches/build-output'), 'utf8')).toBe('two');
    expect(await readFile(resolve(assets.cache, 'cargo/registry/crate'), 'utf8')).toBe('two');
    for (const home of homes)
      expect(await readFile(resolve(home, 'codex/sessions/history'), 'utf8')).toBe(home);
  });

  it.skipIf(!bwrapUsable)('lets a shared-layout corner push its branch and open a PR through its private runtime control file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-shared-corner-'));
    roots.push(root);
    const state = resolve(root, 'state');
    const assets = await prepareWorkspaceAssets(workspaceAssetRoot(state, 'A'));
    const runtime = resolve(state, 'beeline/agents/agent-a');
    const home = resolve(runtime, 'rooms/corner/agent-home');
    const corner = resolve(state, 'beeline/corners/corner');
    const remote = resolve(root, 'remote.git');
    await mkdir(home, { recursive: true });
    await writeFile(resolve(runtime, 'runtime.json'), 'workspace-proof');
    const git = (args: string[]) => {
      const result = spawnSync('/usr/bin/git', args, { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git(['init', '--bare', remote]);
    git(['init', '-b', 'shared-feature', corner]);
    git(['-C', corner, 'config', 'user.name', 'Beeline Test']);
    git(['-C', corner, 'config', 'user.email', 'beeline@example.test']);
    await writeFile(resolve(corner, 'README'), 'shared layout');
    git(['-C', corner, 'add', 'README']);
    git(['-C', corner, 'commit', '-m', 'seed']);
    git(['-C', corner, 'remote', 'add', 'origin', remote]);
    const cli = resolve(home, 'token-cli.mjs');
    const fakeGh = resolve(home, 'gh-host.mjs');
    await writeFile(cli, `#!/usr/bin/env node\nimport { readFileSync } from 'node:fs';\nconst path=process.argv[process.argv.indexOf('--config')+1];\nif(readFileSync(path,'utf8')!=='workspace-proof') process.exit(2);\nconsole.log('test-token');\n`);
    await writeFile(fakeGh, `#!/usr/bin/env node\nif(process.env.GH_TOKEN!=='test-token') process.exit(3);\nconsole.log('https://github.com/acme/widget/pull/7');\n`);
    await Promise.all([chmod(cli, 0o700), chmod(fakeGh, 0o700)]);
    const { env } = await installCornerGitHubWrappers({
      root: home, runtimeConfigPath: resolve(runtime, 'runtime.json'), roomId: 'corner',
      cliEntrypoint: cli, gitBinary: '/usr/bin/git', ghBinary: fakeGh,
      featureBranch: 'shared-feature', targetBranch: 'main',
      originUrl: remote, inheritedPath: process.env.PATH,
    });
    const wrapped = wrapAgentCommand({
      bwrapPath: '/usr/bin/bwrap',
      spec: {
        mode: 'edit', cwd: corner, worktreePath: corner, gitCommonDir: resolve(corner, '.git'),
        protectedPaths: [state],
        additionalWritablePaths: [remote],
        sharedLayout: { assetRoot: assets.root, agentRuntimeDir: runtime, privateHomeRoot: home },
      },
      command: '/bin/sh',
      args: ['-c', 'git push origin shared-feature && gh pr create --repo acme/widget --title proof --body proof'],
    });
    const result = spawnSync(wrapped.command, wrapped.args, {
      cwd: corner, encoding: 'utf8', env: { ...process.env, ...env, HOME: resolve(home, 'user') },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('https://github.com/acme/widget/pull/7');
    expect(git(['--git-dir', remote, 'show-ref', 'shared-feature'])).toContain('refs/heads/shared-feature');
  });
});
