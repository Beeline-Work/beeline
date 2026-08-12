/**
 * Git smart-HTTP helpers that authenticate to the Buzz relay via a
 * per-identity NIP-98 header injected with `http.extraHeader`.
 *
 * One signed header authenticates every request in a single git invocation
 * (info/refs GET + upload/receive-pack POST) because the relay matches the
 * `u` tag against the repo-root URL with the service suffix stripped.
 */
import { spawnSync } from 'node:child_process';
import { nip98AuthHeader } from './nip98.js';
import { gitRepoUrl } from './config.js';
import type { Identity } from './identity.js';

export interface GitResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

const BASE_GIT_ARGS = [
  '-c',
  'credential.helper=',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'user.name=buzzy',
  '-c',
  'user.email=buzzy@example.com',
  '-c',
  'protocol.version=2',
];

const BASE_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** Run a plain git command in `cwd` (no relay auth). */
export function git(cwd: string, args: string[]): GitResult {
  const res = spawnSync('git', [...BASE_GIT_ARGS, ...args], {
    cwd,
    env: BASE_ENV,
    encoding: 'utf8',
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/**
 * Run git with the operator's ambient configuration and credentials.
 *
 * This is deliberately separate from `git`/`gitAuthed`: GitHub-origin
 * delivery is authorized exactly like the operator's own `git push` (for
 * example via credential.helper, `gh auth setup-git`, or SSH), while relay
 * repositories continue to use the isolated NIP-98 path above.
 */
export function gitWithUserCredentials(cwd: string, args: string[]): GitResult {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/**
 * Run a git command that talks to the relay as `identity`. The NIP-98 header
 * is bound to `ownerHex/repo`'s repo-root URL and signed fresh per call.
 */
export function gitAuthed(
  cwd: string,
  identity: Identity,
  ownerHex: string,
  repo: string,
  args: string[],
): GitResult {
  const url = gitRepoUrl(ownerHex, repo);
  const header = nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'GET');
  const res = spawnSync(
    'git',
    [...BASE_GIT_ARGS, '-c', `http.extraHeader=Authorization: ${header}`, ...args],
    { cwd, env: BASE_ENV, encoding: 'utf8' },
  );
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/** Resolve the remote tip of a ref (40-hex) or undefined if absent. */
export function lsRemoteRef(
  cwd: string,
  identity: Identity,
  ownerHex: string,
  repo: string,
  ref: string,
): string | undefined {
  const url = gitRepoUrl(ownerHex, repo);
  const res = gitAuthed(cwd, identity, ownerHex, repo, ['ls-remote', url, ref]);
  if (!res.ok) return undefined;
  const line = res.stdout.split('\n').find((l) => l.trim().length > 0);
  return line ? line.split('\t')[0] : undefined;
}
