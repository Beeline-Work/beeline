#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = resolve(repoRoot, 'relay-stack', 'web');

async function expectedReadonlyTools() {
  // The bundled MCP server asserts that its registration matches this policy
  // list. Loading the compiled policy here keeps the install probe in lockstep
  // with the same source of truth instead of maintaining a third inventory.
  const { READ_ONLY_TOOL_NAMES } = await import(
    resolve(repoRoot, 'apps', 'body', 'dist', 'read-only-policy.js')
  );
  return [...READ_ONLY_TOOL_NAMES];
}

function fail(message) {
  throw new Error(`verify-beeline-install: ${message}`);
}

function hostPlatform() {
  const os = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : '';
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : '';
  return os && arch ? `${os}-${arch}` : '';
}

function requestedPlatform() {
  const index = process.argv.indexOf('--platform');
  return index >= 0 ? process.argv[index + 1] : hostPlatform();
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else {
        reject(
          new Error(
            `${command} exited code=${code} signal=${signal ?? 'none'}${stderr ? `\n${stderr}` : ''}`,
          ),
        );
      }
    });
    child.stdin.end(options.input);
  });
}

async function serveBundle(platform) {
  const routes = new Map([
    ['/dl/beeline-' + platform + '.tar.gz', resolve(webRoot, 'dl', `beeline-${platform}.tar.gz`)],
    [
      '/dl/beeline-' + platform + '.tar.gz.sha256',
      resolve(webRoot, 'dl', `beeline-${platform}.tar.gz.sha256`),
    ],
  ]);
  const server = createServer(async (request, response) => {
    const path = routes.get(request.url ?? '');
    if (!path) {
      response.writeHead(404).end('not found');
      return;
    }
    try {
      response.writeHead(200).end(await readFile(path));
    } catch {
      response.writeHead(500).end('read failed');
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') fail('local artifact server did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function parseMcpTools(stdout) {
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== 2) continue;
    return (message.result?.tools ?? []).map((tool) => tool.name);
  }
  fail('installed buzz-readonly-mcp did not answer tools/list');
}

async function main() {
  const platform = requestedPlatform();
  if (!platform) fail('unsupported host platform');
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'beeline-bare-install-'));
  const binDir = resolve(temporaryRoot, 'prefix', 'bin');
  const libDir = resolve(temporaryRoot, 'prefix', 'lib', 'beeline');
  const bareCwd = resolve(temporaryRoot, 'no-repository');
  await mkdir(bareCwd, { recursive: true });
  const { server, baseUrl } = await serveBundle(platform);

  try {
    const env = {
      ...process.env,
      HOME: resolve(temporaryRoot, 'home'),
      PATH: process.env.PATH ?? '',
      BEELINE_INSTALL_BASE_URL: baseUrl,
      BEELINE_INSTALL_PLATFORM: platform,
      BEELINE_INSTALL_DIR: binDir,
      BEELINE_INSTALL_LIB_DIR: libDir,
    };
    delete env.BUZZ_READONLY_MCP_BIN;
    delete env.BUZZ_READONLY_MCP_SCRIPT;
    delete env.BUZZ_DEV_MCP_BIN;
    delete env.BUZZ_AGENT_BIN;

    const installed = await run('sh', [resolve(webRoot, 'install.sh')], {
      cwd: bareCwd,
      env,
    });
    if (!installed.stdout.includes('beeline, buzz-agent, buzz-dev-mcp, and buzz-readonly-mcp')) {
      fail(`installer success line omitted the read-only helper:\n${installed.stdout}`);
    }

    const runtimeEnv = { ...env, PATH: `${binDir}:${env.PATH}` };
    delete runtimeEnv.BEELINE_INSTALL_BASE_URL;
    const version = await run(resolve(binDir, 'beeline'), ['--version'], {
      cwd: bareCwd,
      env: runtimeEnv,
    });
    const match = version.stdout.match(/^\[body\] read-only mcp: (.+)$/m);
    if (!match) fail(`beeline --version did not report the read-only MCP path:\n${version.stdout}`);
    await access(match[1], constants.X_OK);

    const probe = await run(resolve(binDir, 'buzz-readonly-mcp'), [], {
      cwd: bareCwd,
      env: { ...runtimeEnv, BUZZ_READONLY_ROOT: bareCwd },
      input:
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'beeline-install-verifier', version: '1.0.0' },
          },
        }) +
        '\n' +
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) +
        '\n',
    });
    const tools = parseMcpTools(probe.stdout);
    if (JSON.stringify(tools) !== JSON.stringify(await expectedReadonlyTools())) {
      fail(`unexpected installed read-only tool inventory: ${tools.join(', ')}`);
    }

    // Start a real ACP read-only session using only the installed agent and
    // installed helper. Dummy provider values are sufficient because
    // session/new does not make a model request.
    const { AcpClient } = await import(resolve(repoRoot, 'apps', 'body', 'dist', 'acp.js'));
    const acp = new AcpClient({
      agentBinary: resolve(binDir, 'buzz-agent'),
      agentEnv: {
        BUZZ_AGENT_PROVIDER: 'openai',
        OPENAI_COMPAT_API_KEY: 'install-probe',
        OPENAI_COMPAT_MODEL: 'install-probe',
        OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:1/v1',
      },
      autoApprovePermissions: false,
    });
    let acpStderr = '';
    acp.on('stderr', (chunk) => {
      acpStderr = `${acpStderr}${chunk}`.slice(-4_000);
    });
    await acp.start();
    let readonlySession;
    try {
      readonlySession = await acp.sessionNew({
        cwd: bareCwd,
        mode: 'readonly',
        mcpServers: [
          {
            name: 'buzz-readonly-mcp',
            command: match[1],
            args: [],
            env: [{ name: 'BUZZ_READONLY_ROOT', value: bareCwd }],
          },
        ],
      });
    } catch (error) {
      fail(
        `installed read-only ACP session did not start: ${error instanceof Error ? error.message : String(error)}${acpStderr ? `\n${acpStderr}` : ''}`,
      );
    } finally {
      await acp.stop();
    }
    if (!readonlySession?.sessionId) fail('installed read-only ACP session returned no sessionId');

    console.log(`verify-beeline-install: installed into bare prefix ${dirname(binDir)}`);
    console.log(`verify-beeline-install: read-only mcp ${match[1]}`);
    console.log(`verify-beeline-install: tools ${tools.join(', ')}`);
    console.log(`verify-beeline-install: ACP read-only session ${readonlySession.sessionId}`);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
