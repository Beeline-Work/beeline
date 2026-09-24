import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';

/** Install session-local git/gh launchers which mint credentials only when used. */
export async function installCornerGitHubWrappers(input: {
  root: string;
  runtimeConfigPath: string;
  roomId: string;
  cliEntrypoint: string;
  gitBinary: string;
  ghBinary?: string;
  featureBranch: string;
  targetBranch: string;
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

export function cornerGitHubCommandRefusal(
  launcher: 'git' | 'gh',
  argv: readonly string[],
  featureBranch: string,
  targetBranch: string,
  resolvePushBranch: (source?: string) => { branch?: string; tag?: boolean } = () => ({}),
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
  let repositoryOption = false;
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
        return refusal;
      if (arg === '--repo' || arg.startsWith('--repo=')) repositoryOption = true;
      if (pushOptionsWithValue.has(arg)) index += 1;
      continue;
    }
    positionals.push(arg);
  }
  const refspecs = repositoryOption ? positionals : positionals.slice(1);
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
import { spawnSync } from 'node:child_process';
const config = ${JSON.stringify(config)};
const cornerGitHubCommandRefusal = ${cornerGitHubCommandRefusal.toString()};
const authFailure = /(?:authentication failed|bad credentials|could not read username|http(?:\\/\\d(?:\\.\\d)?)? 40[13]|status (?:code )?40[13])/i;
function resolvePushBranch(source) {
  if (source) {
    const tag = spawnSync(config.command, ['show-ref', '--verify', '--quiet', 'refs/tags/' + source], { stdio: 'ignore' }).status === 0;
    return { branch: source, tag };
  }
  const tracked = spawnSync(config.command, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}'], { encoding: 'utf8' });
  if (tracked.status === 0) return { branch: tracked.stdout.trim().replace(/^[^/]+\\//, '') };
  const current = spawnSync(config.command, ['symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' });
  return current.status === 0 ? { branch: current.stdout.trim() } : {};
}
const refusal = cornerGitHubCommandRefusal(config.launcher, process.argv.slice(2), config.featureBranch, config.targetBranch, resolvePushBranch);
if (refusal) { process.stderr.write(refusal + '\\n'); process.exit(1); }
function token() {
  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = spawnSync(config.node, [config.cli, 'corner-read-token', '--config', config.config, '--room', config.room], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    if (attempt < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * (attempt + 1));
  }
  process.stderr.write(result.stderr || 'Beeline could not refresh the repository credential.\\n');
  process.exit(result.status || 1);
}
function run(value) {
  const env = { ...process.env, GH_TOKEN: value, GITHUB_TOKEN: value, GIT_TERMINAL_PROMPT: '0' };
  return spawnSync(config.command, process.argv.slice(2), { env, encoding: 'buffer', stdio: ['inherit', 'pipe', 'pipe'] });
}
let result = run(token());
const diagnostic = Buffer.concat([result.stdout || Buffer.alloc(0), result.stderr || Buffer.alloc(0)]).toString('utf8');
if (result.status !== 0 && authFailure.test(diagnostic)) result = run(token());
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`;
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
}
