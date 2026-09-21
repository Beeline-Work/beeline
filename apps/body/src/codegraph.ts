import { execFile } from 'node:child_process';
import { access, appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { McpServerWire } from './acp.js';
import type { BodyConfig } from './config.js';

const execFileAsync = promisify(execFile);

export const CODEGRAPH_MCP_SERVER_NAME = 'codegraph';
const CODEGRAPH_INDEX_PATH = '.codegraph/codegraph.db';
const CODEGRAPH_PREPARE_TIMEOUT_MS = 120_000;

/** The one repository path CodeGraph must update even in a read-only Room. */
export function codegraphIndexDirectory(cwd: string): string {
  return resolve(cwd, dirname(CODEGRAPH_INDEX_PATH));
}

/** Release-owned, repository-scoped CodeGraph MCP server. */
export function codegraphMcpServer(
  config: BodyConfig,
  cwd: string,
  options: { readonly: boolean },
): McpServerWire | undefined {
  if (!config.codegraphCommand) return undefined;
  return {
    name: CODEGRAPH_MCP_SERVER_NAME,
    command: config.codegraphCommand,
    args: ['serve', '--mcp', '--path', resolve(cwd), ...(options.readonly ? ['--no-watch'] : [])],
    env: [
      { name: 'CODEGRAPH_TELEMETRY', value: '0' },
      // One MCP child per harness session is easier to contain than a daemon
      // that can outlive the Room/corner whose index and permissions it used.
      { name: 'CODEGRAPH_NO_DAEMON', value: '1' },
    ],
  };
}

/** Add CodeGraph to the retained-session identity only when it can be mounted. */
export function codegraphFingerprintServers(
  config: BodyConfig,
  servers: readonly string[],
  mounted = Boolean(config.codegraphCommand),
): string[] {
  return config.codegraphCommand && mounted
    ? [...servers, CODEGRAPH_MCP_SERVER_NAME]
    : [...servers];
}

async function isGitWorktree(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      timeout: 10_000,
    });
    return resolve(stdout.trim()) === resolve(cwd);
  } catch {
    return false;
  }
}

/** Keep CodeGraph's generated local index out of arbitrary repository changes. */
async function excludeIndexFromGitStatus(cwd: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd,
      timeout: 10_000,
    });
    const gitPath = stdout.trim();
    if (!gitPath) return;
    const path = isAbsolute(gitPath) ? gitPath : resolve(cwd, gitPath);
    await mkdir(dirname(path), { recursive: true });
    const existing = await readFile(path, 'utf8').catch(() => '');
    if (existing.split('\n').includes('.codegraph/')) return;
    await appendFile(path, `${existing && !existing.endsWith('\n') ? '\n' : ''}.codegraph/\n`);
  } catch {
    // Index hygiene is best-effort and must never block a Room or corner.
  }
}

/**
 * Build or refresh the index before exposing CodeGraph tools. Repository-less
 * surfaces skip this quietly; failures leave the ordinary Beeline read tools
 * available and never prevent session startup.
 */
export async function prepareCodegraphIndex(config: BodyConfig, cwd: string): Promise<boolean> {
  const command = config.codegraphCommand;
  if (!command || !(await isGitWorktree(cwd))) return false;
  await excludeIndexFromGitStatus(cwd);
  const indexPath = resolve(cwd, CODEGRAPH_INDEX_PATH);
  const indexed = await access(indexPath).then(
    () => true,
    () => false,
  );
  const args = indexed ? ['sync', '--quiet', cwd] : ['init', '--yes', cwd];
  try {
    await execFileAsync(command, args, {
      cwd,
      env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_DAEMON: '1' },
      timeout: CODEGRAPH_PREPARE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return true;
  } catch (error) {
    console.warn(
      `[body] CodeGraph ${args[0]} failed for ${cwd}; continuing with Beeline read tools:`,
      error,
    );
    return false;
  }
}
