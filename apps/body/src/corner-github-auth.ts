import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';

/** Install session-local git/gh launchers which refresh credentials for remote commands. */
export async function installCornerGitHubWrappers(input: {
  root: string;
  runtimeConfigPath: string;
  roomId: string;
  cliEntrypoint: string;
  gitBinary: string;
  ghBinary?: string;
  featureBranch: string;
  targetBranch: string;
  /**
   * The corner repository's real origin URL. The push guard enforces its
   * feature-branch rule only on pushes that resolve to this remote; a push to
   * a temporary fixture remote in a test suite is not that remote and is
   * allowed. Omitted keeps the legacy behavior of enforcing every push.
   */
  originUrl?: string;
  inheritedPath?: string;
}): Promise<Record<string, string>> {
  const bin = resolve(input.root, 'beeline-github-bin');
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const common = {
    node: process.execPath,
    cli: input.cliEntrypoint,
    config: input.runtimeConfigPath,
    room: input.roomId,
    featureBranch: input.featureBranch,
    targetBranch: input.targetBranch,
    originUrl: input.originUrl ?? '',
  };
  await writeLauncher(resolve(bin, 'git'), {
    ...common,
    command: input.gitBinary,
    launcher: 'git',
  });
  if (input.ghBinary)
    await writeLauncher(resolve(bin, 'gh'), {
      ...common,
      command: input.ghBinary,
      launcher: 'gh',
    });
  return {
    PATH: [bin, input.inheritedPath].filter(Boolean).join(delimiter),
    // Static startup tokens take precedence over the refreshed token in gh.
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
  };
}

/**
 * `pushesOrigin` reports whether a git push's remote is this corner's real
 * origin. Any other remote is a local fixture a test suite may push to, and
 * the branch restriction is skipped for it; with no origin knowledge the
 * default keeps enforcing everywhere.
 */
export function cornerGitHubCommandRefusal(
  launcher: 'git' | 'gh',
  argv: readonly string[],
  featureBranch: string,
  targetBranch: string,
  resolvePushBranch: (source?: string) => { branch?: string; tag?: boolean } = () => ({}),
  pushesOrigin: (remote?: string) => boolean = () => true,
): string | undefined {
  const refusal = `beeline: this corner may push only ${featureBranch}`;
  const branchName = (value: string) => {
    const withoutOwner = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value;
    return withoutOwner.replace(/^refs\/heads\//, '');
  };
  if (launcher === 'gh') {
    const pr = argv.indexOf('pr');
    if (pr < 0 || argv[pr + 1] !== 'create') return undefined;
    for (let index = pr + 2; index < argv.length; index += 1) {
      const arg = argv[index]!;
      const head =
        arg === '--head' || arg === '-H'
          ? argv[index + 1]
          : arg.startsWith('--head=')
            ? arg.slice('--head='.length)
            : arg.startsWith('-H') && arg.length > 2
              ? arg.slice(2)
              : undefined;
      if (head !== undefined && branchName(head) !== featureBranch) return refusal;
    }
    return undefined;
  }

  const gitOptionsWithValue = new Set([
    '-C',
    '-c',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--super-prefix',
    '--config-env',
  ]);
  let command = 0;
  while (command < argv.length && argv[command]!.startsWith('-')) {
    const option = argv[command]!;
    command += gitOptionsWithValue.has(option) ? 2 : 1;
  }
  if (argv[command] !== 'push') return undefined;

  const positionals: string[] = [];
  let repositoryOption: string | undefined;
  let dangerous = false;
  let optionsDone = false;
  const pushOptionsWithValue = new Set([
    '--repo',
    '--receive-pack',
    '--exec',
    '--push-option',
    '-o',
  ]);
  for (let index = command + 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!optionsDone && arg === '--') {
      optionsDone = true;
      continue;
    }
    if (!optionsDone && arg.startsWith('-')) {
      if (
        arg === '-f' ||
        arg === '-d' ||
        arg === '--delete' ||
        arg === '--tags' ||
        arg === '--follow-tags' ||
        arg === '--all' ||
        arg === '--mirror' ||
        arg.startsWith('--force') ||
        (arg.startsWith('-') &&
          !arg.startsWith('--') &&
          !arg.startsWith('-o') &&
          /[fd]/.test(arg.slice(1)))
      )
        dangerous = true;
      if (arg === '--repo') repositoryOption = argv[index + 1];
      else if (arg.startsWith('--repo=')) repositoryOption = arg.slice('--repo='.length);
      if (pushOptionsWithValue.has(arg)) index += 1;
      continue;
    }
    positionals.push(arg);
  }
  // The branch rule protects the real repository only. A push aimed at a
  // temporary local fixture remote is not it, so every restriction is skipped.
  const remoteName =
    repositoryOption !== undefined
      ? repositoryOption
      : positionals.length > 0
        ? positionals[0]
        : undefined;
  if (!pushesOrigin(remoteName)) return undefined;
  if (dangerous) return refusal;
  const refspecs = repositoryOption !== undefined ? positionals : positionals.slice(1);
  const destinations = refspecs.length
    ? refspecs.map((raw) => {
        if (raw.startsWith('+')) return { refused: true };
        const separator = raw.indexOf(':');
        const source = separator >= 0 ? raw.slice(0, separator) : raw;
        const destination = separator >= 0 ? raw.slice(separator + 1) : source;
        if (!source || source === ':' || /(?:^|\/)refs\/tags\//.test(source))
          return { refused: true };
        const resolved = resolvePushBranch(source === 'HEAD' ? undefined : source);
        if (resolved.tag) return { refused: true };
        const branch = destination
          ? branchName(destination)
          : resolved.branch
            ? branchName(resolved.branch)
            : undefined;
        return { branch, refused: destination.startsWith('refs/tags/') };
      })
    : [resolvePushBranch()];
  if (
    destinations.some(
      (destination) =>
        ('refused' in destination && destination.refused === true) ||
        !destination.branch ||
        branchName(destination.branch) !== featureBranch ||
        branchName(destination.branch) === targetBranch,
    )
  )
    return refusal;
  return undefined;
}

async function writeLauncher(path: string, config: Record<string, string>): Promise<void> {
  const source = `#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
const config = ${JSON.stringify(config)};
const cornerGitHubCommandRefusal = ${cornerGitHubCommandRefusal.toString()};
const authFailure = /(?:authentication failed|bad credentials|could not read username|http(?:\\/\\d(?:\\.\\d)?)? 40[13]|status (?:code )?40[13])/i;
const gitContext = (() => {
  const argv = process.argv.slice(2);
  const out = [];
  const valueOptions = new Set(['-c', '--namespace', '--super-prefix', '--config-env']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-C' || arg === '--git-dir' || arg === '--work-tree') { out.push(arg, argv[index + 1]); index += 1; }
    else if (arg.startsWith('-C') && arg.length > 2) out.push('-C', arg.slice(2));
    else if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) out.push(arg);
    else if (valueOptions.has(arg)) index += 1;
    else if (!arg.startsWith('-')) break;
  }
  return out;
})();
function git(args, options) { return spawnSync(config.command, gitContext.concat(args), options); }
function resolvePushBranch(source) {
  if (source) {
    const tag = git(['show-ref', '--verify', '--quiet', 'refs/tags/' + source], { stdio: 'ignore' }).status === 0;
    return { branch: source, tag };
  }
  const tracked = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}'], { encoding: 'utf8' });
  if (tracked.status === 0) return { branch: tracked.stdout.trim().replace(/^[^/]+\\//, '') };
  const current = git(['symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' });
  return current.status === 0 ? { branch: current.stdout.trim() } : {};
}
const looksLikeUrl = (value) => /^[a-z][a-z0-9+.-]*:\\/\\//i.test(value) || value.startsWith('/') || value.startsWith('.') || value.startsWith('~') || value.includes('@');
const normalizeRemote = (value) => {
  let v = value.trim().replace(/\\.git$/i, '');
  const scp = v.match(/^[^/@]+@([^:]+):(.+)$/);
  if (scp) return (scp[1] + '/' + scp[2]).toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\\/\\//i, '').replace(/^[^/@]+@/, '');
  return v.replace(/\\/+$/, '').toLowerCase();
};
function pushesOrigin(remote) {
  if (!config.originUrl) return true;
  let url = remote;
  if (!url || !looksLikeUrl(url)) {
    const status = url ? null : git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}'], { encoding: 'utf8' });
    let name = url;
    if (!name) {
      name = 'origin';
      const full = status && status.status === 0 ? status.stdout.trim() : '';
      if (full) name = full.includes('/') ? full.slice(0, full.indexOf('/')) : full;
    }
    const resolved = git(['config', '--get', 'remote.' + name + '.url'], { encoding: 'utf8' });
    url = resolved.status === 0 ? resolved.stdout.trim() : undefined;
  }
  if (!url) return false;
  return normalizeRemote(url) === normalizeRemote(config.originUrl);
}
const refusal = cornerGitHubCommandRefusal(config.launcher, process.argv.slice(2), config.featureBranch, config.targetBranch, resolvePushBranch, pushesOrigin);
if (refusal) { process.stderr.write(refusal + '\\n'); process.exitCode = 1; }
function needsToken(argv) {
  if (config.launcher === 'gh') return true;
  const optionsWithValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
  let index = 0;
  while (index < argv.length && argv[index].startsWith('-')) {
    if (argv[index] === '--version' || argv[index] === '--help') return false;
    index += optionsWithValue.has(argv[index]) ? 2 : 1;
  }
  // Unknown commands (including aliases) may contact a remote.
  const local = new Set([
    'add', 'am', 'apply', 'bisect', 'blame', 'branch', 'cat-file', 'check-attr',
    'check-ignore', 'check-ref-format', 'checkout', 'cherry-pick', 'clean', 'commit',
    'config', 'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'for-each-ref',
    'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help', 'init', 'log', 'ls-files',
    'ls-tree', 'merge', 'merge-base', 'mv', 'notes', 'rebase', 'reflog', 'reset',
    'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'show', 'show-ref', 'stash',
    'status', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref',
    'verify-commit', 'verify-tag', 'worktree',
  ]);
  return !local.has(argv[index]);
}
function token() {
  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = spawnSync(config.node, [config.cli, 'corner-read-token', '--config', config.config, '--room', config.room], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    if (attempt < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * (attempt + 1));
  }
  process.stderr.write(result.stderr || 'Beeline could not refresh the repository credential.\\n');
  process.exitCode = result.status || 1;
  return undefined;
}
async function run(value) {
  const env = { ...process.env, GH_TOKEN: value, GITHUB_TOKEN: value, GIT_TERMINAL_PROMPT: '0' };
  const child = spawn(config.command, process.argv.slice(2), { env, stdio: ['inherit', 'pipe', 'pipe'] });
  let authenticationFailed = false;
  // Keep only enough diagnostic overlap to recognize an auth failure across chunks.
  for (const [source, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    let tail = '';
    source.on('data', (chunk) => {
      const diagnostic = tail + chunk.toString('utf8');
      authenticationFailed ||= authFailure.test(diagnostic);
      tail = diagnostic.slice(-1024);
    });
    source.pipe(destination, { end: false });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, authenticationFailed }));
  });
}
if (!refusal) {
  const authenticated = needsToken(process.argv.slice(2));
  const value = authenticated ? token() : '';
  if (value !== undefined) {
    let result = await run(value);
    if (authenticated && result.status !== 0 && result.authenticationFailed) {
      const refreshed = token();
      if (refreshed !== undefined) result = await run(refreshed);
    }
    process.exitCode ??= result.status ?? 1;
  }
}
`;
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
}
