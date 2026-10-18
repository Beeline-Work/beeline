// Daily feedback-triage check. Requires a built Body and installed harness CLIs.
// It never reads/copies a login or sends a model prompt.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { AcpClient } from '../apps/body/dist/acp.js';
import { requireInstalledAgentProgram } from '../apps/body/dist/agent-command.js';

const exec = promisify(execFile);
const adapters = [
  {
    kind: 'codex',
    package: '@agentclientprotocol/codex-acp',
    binary: 'codex-acp',
    override: 'CODEX_PATH',
  },
  {
    kind: 'claude',
    package: '@agentclientprotocol/claude-agent-acp',
    binary: 'claude-agent-acp',
    override: 'CLAUDE_CODE_EXECUTABLE',
  },
  { kind: 'pi', package: 'pi-acp', binary: 'pi-acp', override: 'PI_ACP_PI_COMMAND' },
];
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
    let client;
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
          `${adapter.package}@latest`,
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
      client = new AcpClient({
        agentCommand: join(prefix, 'node_modules/.bin', adapter.binary),
        agentEnv: env,
        inheritProcessEnv: false,
        resourceScope: 'none',
      });
      await client.start(30_000);
      result.stage = 'session/new';
      const session = await client.sessionNew({ cwd: home, timeoutMs: 30_000 });
      if (!session.sessionId) throw new Error('session/new returned no session id');
      result.status = 'passed';
      result.stage = 'complete';
    } catch (error) {
      // No credential-bearing environment was supplied to any child.
      result.error = String(error instanceof Error ? error.message : error)
        .replace(/\s+/g, ' ')
        .slice(0, 2000);
    } finally {
      if (client) await client.stop();
      await rm(prefix, { recursive: true, force: true });
    }
    results.push(result);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ check: 'acp-adapter-compatibility', results }, null, 2));
if (results.some((result) => result.status !== 'passed')) process.exitCode = 1;
