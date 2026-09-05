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
  inheritedPath?: string;
}): Promise<Record<string, string>> {
  const bin = resolve(input.root, 'beeline-github-bin');
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const common = {
    node: process.execPath,
    cli: input.cliEntrypoint,
    config: input.runtimeConfigPath,
    room: input.roomId,
  };
  await writeLauncher(resolve(bin, 'git'), { ...common, command: input.gitBinary });
  if (input.ghBinary) await writeLauncher(resolve(bin, 'gh'), { ...common, command: input.ghBinary });
  return {
    PATH: [bin, input.inheritedPath].filter(Boolean).join(delimiter),
    // Static startup tokens take precedence over the refreshed token in gh.
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
  };
}

async function writeLauncher(path: string, config: Record<string, string>): Promise<void> {
  const source = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const config = ${JSON.stringify(config)};
const authFailure = /(?:authentication failed|bad credentials|could not read username|http(?:\\/\\d(?:\\.\\d)?)? 40[13]|status (?:code )?40[13])/i;
function token() {
  const result = spawnSync(config.node, [config.cli, 'corner-read-token', '--config', config.config, '--room', config.room], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || 'Beeline could not refresh the repository credential.\\n');
    process.exit(result.status || 1);
  }
  return result.stdout.trim();
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
