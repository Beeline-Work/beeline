// Daily CI and feedback-triage check. Requires a built Body and installed harness CLIs.
// It never reads/copies a login or sends a model prompt.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { checkAdapterSession } from '../apps/body/dist/adapter-session-check.js';
import { MANAGED_ADAPTERS } from '../apps/body/dist/adapter-store.js';
import { requireInstalledAgentProgram } from '../apps/body/dist/agent-command.js';

const exec = promisify(execFile);
const adapters = Object.entries(MANAGED_ADAPTERS).map(([kind, adapter]) => ({
  kind, package: adapter.packageName, binary: adapter.binary,
  override: kind === 'codex' ? 'CODEX_PATH' : kind === 'claude' ? 'CLAUDE_CODE_EXECUTABLE' : 'PI_ACP_PI_COMMAND',
}));
const root = await mkdtemp(join(tmpdir(), 'beeline-adapter-check-'));
const results = [];
try {
  for (const adapter of adapters) {
    const prefix = join(root, adapter.kind);
    const home = join(prefix, 'home');
    await mkdir(home, { recursive: true });
    // Do not inherit provider keys, auth tokens, NODE_OPTIONS or operator config.
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_STATE_HOME: join(home, 'state'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_CACHE_HOME: join(home, 'cache'),
      TMPDIR: prefix,
      PATH: [dirname(process.execPath), process.env.PATH || '/usr/bin:/bin'].join(delimiter),
      LANG: 'C.UTF-8',
      CODEX_HOME: join(home, 'codex'),
      CLAUDE_CONFIG_DIR: join(home, 'claude'),
      PI_CODING_AGENT_DIR: join(home, 'pi'),
      NO_BROWSER: '1',
      DISABLE_AUTOUPDATER: '1',
      npm_config_userconfig: join(prefix, '.npmrc'),
      npm_config_globalconfig: join(prefix, '.npmrc-global'),
      npm_config_cache: join(prefix, 'npm-cache'),
      npm_config_update_notifier: 'false',
    };
    await Promise.all(
      [
        env.CODEX_HOME,
        env.CLAUDE_CONFIG_DIR,
        env.PI_CODING_AGENT_DIR,
        env.XDG_CONFIG_HOME,
        env.XDG_STATE_HOME,
        env.XDG_DATA_HOME,
        env.XDG_CACHE_HOME,
      ].map((path) => mkdir(path, { recursive: true })),
    );
    const result = {
      adapter: adapter.package,
      version: 'unknown',
      status: 'failed',
      stage: 'version',
      program: null,
    };
    try {
      const published = await exec('npm', ['view', `${adapter.package}@latest`, 'version'], {
        env,
        timeout: 30_000,
        maxBuffer: 16_384,
      });
      result.version = published.stdout.trim() || 'unknown';
      result.stage = 'install';
      await exec(
        'npm',
        [
          'install',
          '--prefix',
          prefix,
          '--no-save',
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
          '--omit=optional',
          `${adapter.package}@${result.version}`,
        ],
        { env, timeout: 300_000, maxBuffer: 128 * 1024 },
      );
      result.version = JSON.parse(
        await readFile(join(prefix, 'node_modules', adapter.package, 'package.json'), 'utf8'),
      ).version;
      result.stage = 'program';
      result.program = requireInstalledAgentProgram(adapter.kind, process.env);
      env[adapter.override] = result.program;
      result.stage = 'initialize';
      result.negotiated = await checkAdapterSession({
        command: join(prefix, 'node_modules/.bin', adapter.binary),
        env,
        scratchRoot: prefix,
        onStage: stage => { result.stage = stage; },
        onInitialized: negotiated => { result.negotiated = negotiated; },
      });
      result.status = 'passed';
      result.stage = 'complete';
    } catch (error) {
      // No credential-bearing environment was supplied to any child.
      result.error = String(error instanceof Error ? error.message : error)
        .replace(/\s+/g, ' ')
        .slice(0, 2000);
    } finally {
      await rm(prefix, { recursive: true, force: true });
    }
    results.push(result);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ check: 'acp-adapter-compatibility', results }, null, 2));
if (results.some((result) => result.status !== 'passed')) process.exitCode = 1;
