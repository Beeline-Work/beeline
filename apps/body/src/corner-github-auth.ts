import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';

/** What a corner's `gh` launcher actually is: a host binary or the REST fallback. */
export type CornerGitHubCli = 'host' | 'rest';

export interface CornerGitHubLaunchers {
  /** Environment overrides for the corner harness and its tool processes. */
  readonly env: Record<string, string>;
  /**
   * `host` when `gh` delegates to a real host binary, `rest` when this host has
   * no `gh` and the launcher answers `gh pr create`/`gh pr view` itself.
   */
  readonly githubCli: CornerGitHubCli;
}

/**
 * Install session-local git/gh launchers which refresh credentials for remote
 * commands.
 *
 * `gh` is always installed. When a host `gh` exists the launcher delegates to
 * it with the refreshed token; when it does not, the launcher answers
 * `gh pr create` and `gh pr view` directly over the GitHub REST API with the
 * same token, so a corner can always open and read its pull request.
 */
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
}): Promise<CornerGitHubLaunchers> {
  const bin = resolve(input.root, 'beeline-github-bin');
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const common = {
    node: process.execPath,
    cli: input.cliEntrypoint,
    config: input.runtimeConfigPath,
    room: input.roomId,
    featureBranch: input.featureBranch,
    targetBranch: input.targetBranch,
    gitCommand: input.gitBinary,
    originUrl: input.originUrl ?? '',
  };
  await writeLauncher(resolve(bin, 'git'), {
    ...common,
    command: input.gitBinary,
    launcher: 'git',
    restFallback: false,
  });
  await writeLauncher(resolve(bin, 'gh'), {
    ...common,
    command: input.ghBinary ?? '',
    launcher: 'gh',
    // A host gh can still be unauthenticated and reject the app token; the
    // REST path is the guarantee that a PR can always be opened.
    restFallback: true,
  });
  return {
    env: {
      PATH: [bin, input.inheritedPath].filter(Boolean).join(delimiter),
      // Static startup tokens take precedence over the refreshed token in gh.
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    githubCli: input.ghBinary ? 'host' : 'rest',
  };
}

/**
 * `pushesOrigin` reports whether the branch restriction applies to a git push.
 * Only a remote whose effective push URL is a local path or `file://` is a
 * fixture a test suite owns, and only that returns `false`; every other remote
 * - including one whose URL cannot be resolved - keeps the restriction. With
 * no origin knowledge the default enforces everywhere.
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
  // The branch rule protects every remote except a local fixture a test suite
  // owns. `pushesOrigin` proves locality from the URL git will actually push
  // to; only a local path or file:// skips the restriction.
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

async function writeLauncher(path: string, config: Record<string, string | boolean>): Promise<void> {
  const source = `#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const config = ${JSON.stringify(config)};
const cornerGitHubCommandRefusal = ${cornerGitHubCommandRefusal.toString()};
const authFailure = /(?:authentication failed|bad credentials|could not read username|not logged into any github hosts|http(?:\\/\\d(?:\\.\\d)?)? 40[13]|status (?:code )?40[13])/i;
const argv = process.argv.slice(2);
const gitContext = (() => {
  const out = [];
  const valueOptions = new Set(['-c', '--namespace', '--super-prefix', '--config-env']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-C' || arg === '--git-dir' || arg === '--work-tree') { out.push(arg, argv[index + 1]); index += 1; }
    else if (arg.startsWith('-C') && arg.length > 2) out.push('-C', arg.slice(2));
    else if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) out.push(arg);
    else if (valueOptions.has(arg)) { out.push(arg, argv[index + 1]); index += 1; }
    else if (!arg.startsWith('-')) break;
  }
  return out;
})();
function git(args, options) { return spawnSync(config.gitCommand, gitContext.concat(args), options); }
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
const isLocalPushUrl = (value) => {
  if (!value) return false;
  // SCP-like syntax (git@host:path) always names a host, never a local path.
  if (/^[^/@]+@[^:]+:/.test(value)) return false;
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme && value.slice(scheme[0].length).startsWith('//'))
    return scheme[1].toLowerCase() === 'file';
  // A bare path - absolute or relative - is the only other local form.
  return true;
};
function pushesOrigin(remote) {
  if (!config.originUrl) return true;
  let name = remote;
  if (!name) {
    const status = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}'], { encoding: 'utf8' });
    const full = status.status === 0 ? status.stdout.trim() : '';
    if (full) name = full.includes('/') ? full.slice(0, full.indexOf('/')) : full;
    if (!name) name = 'origin';
  }
  let url;
  if (looksLikeUrl(name)) {
    // A raw path or URL is rewritten by url.<base>.insteadOf before git pushes
    // to it. ls-remote --get-url applies those rewrites but not pushInsteadOf,
    // so a raw target is proven local only when no url insteadOf rule exists.
    const resolved = git(['ls-remote', '--get-url', name], { encoding: 'utf8' });
    url = resolved.status === 0 ? resolved.stdout.trim() : undefined;
    if (url && git(['config', '--get-regexp', '^url[.].*insteadof$'], { encoding: 'utf8' }).status === 0)
      url = undefined;
  } else {
    // '--push' is the URL git will actually use, so it follows pushurl and
    // insteadOf rewrites that a raw remote.<name>.url read would miss.
    const resolved = git(['remote', 'get-url', '--push', name], { encoding: 'utf8' });
    url = resolved.status === 0 ? resolved.stdout.trim() : undefined;
  }
  // Only a push whose effective URL is a local path or file:// is exempt.
  // Everything else, including an unresolved remote, keeps the branch rule.
  if (!url) return true;
  return !isLocalPushUrl(url);
}
const refusal = cornerGitHubCommandRefusal(config.launcher, argv, config.featureBranch, config.targetBranch, resolvePushBranch, pushesOrigin);
if (refusal) { process.stderr.write(refusal + '\\n'); process.exitCode = 1; }
function needsToken(args) {
  if (config.launcher === 'gh') return true;
  const optionsWithValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    if (args[index] === '--version' || args[index] === '--help') return false;
    index += optionsWithValue.has(args[index]) ? 2 : 1;
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
  return !local.has(args[index]);
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
function runCommand(command, args, value, quiet) {
  const env = { ...process.env, GH_TOKEN: value, GITHUB_TOKEN: value, GIT_TERMINAL_PROMPT: '0' };
  const child = spawn(command, args, { env, stdio: ['inherit', quiet ? 'ignore' : 'pipe', quiet ? 'ignore' : 'pipe'] });
  if (quiet) {
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, authenticationFailed: false }));
    });
  }
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
function isPushCommand(args) {
  const optionsWithValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    if (args[index] === '--version' || args[index] === '--help') return false;
    index += optionsWithValue.has(args[index]) ? 2 : 1;
  }
  return args[index] === 'push';
}
/** The feature branch's remote-tracking ref must exist after a launcher push. */
async function publishTrackingRef(value) {
  const refspec = '+refs/heads/' + config.featureBranch + ':refs/remotes/origin/' + config.featureBranch;
  const fetched = await runCommand(config.gitCommand, ['fetch', '--no-tags', 'origin', refspec], value, true).catch(() => ({ status: 1 }));
  if (fetched.status !== 0)
    await runCommand(config.gitCommand, ['update-ref', 'refs/remotes/origin/' + config.featureBranch, 'HEAD'], value, true).catch(() => undefined);
}
function flagValue(args, names) {
  for (let index = 0; index < args.length; index += 1) {
    for (const name of names) {
      if (args[index] === name) return args[index + 1];
      if (args[index].startsWith(name + '=')) return args[index].slice(name.length + 1);
    }
  }
  return undefined;
}
function hasFlag(args, names) {
  return args.some((arg) => names.includes(arg));
}
function gitOutput(args) {
  const result = spawnSync(config.gitCommand, args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}
function repoSlug(args) {
  const explicit = flagValue(args, ['--repo', '-R']);
  if (explicit) return explicit.replace(/^https?:\\/\\/[^/]+\\//, '').replace(/\\.git$/, '');
  if (process.env.GH_REPO) return process.env.GH_REPO;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const remote = gitOutput(['remote', 'get-url', 'origin']) || gitOutput(['config', '--get', 'remote.origin.url']);
  const match = remote.match(/github\\.com[:/]([^/]+)\\/(.+?)(?:\\.git)?$/);
  return match ? match[1] + '/' + match[2] : '';
}
async function github(pathname, options, value) {
  const base = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\\/$/, '');
  const response = await fetch(base + pathname, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + value,
      'user-agent': 'beeline-corner-gh',
      'x-github-api-version': '2022-11-28',
      ...(options && options.headers ? options.headers : {}),
    },
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) {
    const message = (data && data.message) || response.statusText;
    process.stderr.write('gh: ' + response.status + ' ' + message + '\\n');
    return { ok: false, status: response.status, data };
  }
  return { ok: true, status: response.status, data };
}
async function runRest(args, value) {
  const slug = repoSlug(args);
  const action = args[0] === 'pr' ? args[1] : undefined;
  if (!slug) {
    process.stderr.write('Beeline: no GitHub repository resolved for gh ' + args.slice(0, 2).join(' ') + '; pass --repo owner/repo.\\n');
    return { status: 1, authenticationFailed: false };
  }
  if (action === 'create') {
    let title = flagValue(args, ['--title', '-t']);
    let body = flagValue(args, ['--body', '-b']);
    const bodyFile = flagValue(args, ['--body-file', '-F']);
    if (bodyFile !== undefined && body === undefined) {
      try { body = readFileSync(bodyFile, 'utf8'); } catch {
        process.stderr.write('gh: could not read body file ' + bodyFile + '\\n');
        return { status: 1, authenticationFailed: false };
      }
    }
    if (hasFlag(args, ['--fill', '-f'])) {
      if (title === undefined) title = gitOutput(['log', '-1', '--pretty=%s']);
      if (body === undefined) body = gitOutput(['log', '-1', '--pretty=%b']);
    }
    if (title === undefined || title === '') {
      process.stderr.write('gh: a title is required (--title or --fill)\\n');
      return { status: 1, authenticationFailed: false };
    }
    const head = flagValue(args, ['--head', '-H']) || config.featureBranch;
    const base = flagValue(args, ['--base', '-B']) || config.targetBranch;
    const draft = hasFlag(args, ['--draft', '-d']);
    const created = await github('/repos/' + slug + '/pulls', {
      method: 'POST',
      body: JSON.stringify({ title, body: body || '', head, base, draft }),
    }, value);
    if (!created.ok) return { status: 1, authenticationFailed: created.status === 401 || created.status === 403 };
    process.stdout.write((created.data.html_url || '') + '\\n');
    return { status: 0, authenticationFailed: false };
  }
  if (action === 'view') {
    const fields = (flagValue(args, ['--json']) || '').split(',').map((field) => field.trim()).filter(Boolean);
    let number = args.slice(2).map((arg) => arg.match(/^([0-9]+)$/)).find(Boolean);
    number = number ? Number(number[1]) : undefined;
    if (number === undefined) {
      const owner = slug.split('/')[0];
      const listed = await github('/repos/' + slug + '/pulls?state=all&head=' + encodeURIComponent(owner + ':' + config.featureBranch), {}, value);
      if (!listed.ok) return { status: 1, authenticationFailed: listed.status === 401 || listed.status === 403 };
      const first = Array.isArray(listed.data) ? listed.data[0] : undefined;
      if (!first) {
        process.stderr.write('gh: no pull request found for branch ' + config.featureBranch + '\\n');
        return { status: 1, authenticationFailed: false };
      }
      number = first.number;
    }
    const viewed = await github('/repos/' + slug + '/pulls/' + number, {}, value);
    if (!viewed.ok) return { status: 1, authenticationFailed: viewed.status === 401 || viewed.status === 403 };
    const pr = viewed.data;
    if (fields.length) {
      let files = [];
      if (fields.includes('files')) {
        const listed = await github('/repos/' + slug + '/pulls/' + number + '/files?per_page=100', {}, value);
        if (listed.ok && Array.isArray(listed.data))
          files = listed.data.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status }));
      }
      const all = {
        number: pr.number,
        url: pr.html_url,
        title: pr.title,
        state: pr.state,
        headRefName: pr.head && pr.head.ref,
        headRefOid: pr.head && pr.head.sha,
        baseRefName: pr.base && pr.base.ref,
        isDraft: pr.draft,
        body: pr.body,
        mergeable: pr.mergeable,
        mergeStateStatus: pr.mergeable_state,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
        labels: (pr.labels || []).map((label) => label.name),
        author: pr.user ? { login: pr.user.login } : undefined,
        files,
      };
      const output = {};
      for (const field of fields) if (Object.hasOwn(all, field)) output[field] = all[field];
      process.stdout.write(JSON.stringify(output) + '\\n');
      return { status: 0, authenticationFailed: false };
    }
    process.stdout.write((pr.html_url || '') + '\\n');
    return { status: 0, authenticationFailed: false };
  }
  process.stderr.write('Beeline: this host has no gh binary; only gh pr create and gh pr view are provided through the app token. Use git for push and the Beeline pr_checks_status tool for checks.\\n');
  return { status: 1, authenticationFailed: false };
}
function isRestCommand(args) {
  return config.launcher === 'gh' && args[0] === 'pr' && (args[1] === 'create' || args[1] === 'view');
}
async function execute(args, value) {
  if (isRestCommand(args)) {
    if (config.command) {
      const result = await runCommand(config.command, args, value).catch(() => ({ status: 1, authenticationFailed: true }));
      // Only a missing or auth-refusing host gh earns the REST fallback; a real gh error stands.
      if (result.status === 0 || !result.authenticationFailed) return result;
    }
    return runRest(args, value);
  }
  if (!config.command) return runRest(args, value);
  return runCommand(config.command, args, value);
}
if (!refusal) {
  const authenticated = needsToken(argv);
  const value = authenticated ? token() : '';
  if (value !== undefined) {
    let result = await execute(argv, value);
    if (authenticated && result.status !== 0 && result.authenticationFailed) {
      const refreshed = token();
      if (refreshed !== undefined) result = await execute(argv, refreshed);
    }
    if (config.launcher === 'git' && result.status === 0 && isPushCommand(argv))
      await publishTrackingRef(value);
    process.exitCode ??= result.status ?? 1;
  }
}
`;
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
}