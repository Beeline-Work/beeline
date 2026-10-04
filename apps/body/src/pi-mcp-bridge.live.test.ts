/**
 * Run the repository Pi bridge and the host Pi native MCP loader separately.
 * Both run real Pi RPC sessions to inspect their tool registries; the native
 * test also invokes the host Pi's MCP tool definitions against stdio children.
 * No model or network is needed. Skip an executable that is absent on a host.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { executableOnPath } from './agent-command.js';
import { PI_MCP_BRIDGE_FILENAME, installPiMcpBridge } from './pi-mcp-bridge.js';

// Vitest prepends this repository's older Pi to PATH. Resolve the host Pi
// separately so a native MCP test cannot silently exercise that older copy.
const pi = executableOnPath('pi');
const hostPi = executableOnPath('pi', {
  ...process.env,
  PATH: (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => !entry.includes('node_modules/.bin'))
    .join(delimiter),
});
const root = mkdtempSync(resolve(tmpdir(), 'beeline-pi-bridge-live-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function isolatedEnv(agentDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
  };
}

function versionOf(executable: string): string {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', env: isolatedEnv(root) });
  if (result.status !== 0) throw new Error(`${executable} --version failed: ${result.stderr}`);
  return result.stdout.trim();
}

function nativeMcpAvailable(executable: string | undefined): boolean {
  if (!executable) return false;
  const agentDir = resolve(root, 'native-probe');
  mkdirSync(agentDir, { recursive: true });
  const result = spawnSync(executable, ['mcp', 'list', '--json'], {
    cwd: agentDir,
    encoding: 'utf8',
    timeout: 5_000,
    env: isolatedEnv(agentDir),
  });
  if (result.status !== 0) return false;
  try {
    const inventory = JSON.parse(result.stdout) as { servers?: unknown; errors?: unknown };
    return Array.isArray(inventory.servers) && Array.isArray(inventory.errors);
  } catch {
    return false;
  }
}

const nativePi = nativeMcpAvailable(hostPi) ? hostPi : undefined;

const MCP_SERVER = `import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize')
    return send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'beeline-live-probe', version: '1' } } });
  if (request.method === 'tools/list')
    return send({ jsonrpc: '2.0', id: request.id, result: { tools: [
      { name: 'subscribe_events', description: 'Choose which things happening in this Room wake you.', inputSchema: { type: 'object', required: ['kinds'], properties: { kinds: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } },
    ] } });
  if (request.method === 'tools/call') {
    if (process.env.MCP_FAIL_ONCE_FILE && !existsSync(process.env.MCP_FAIL_ONCE_FILE)) {
      writeFileSync(process.env.MCP_FAIL_ONCE_FILE, 'exited');
      process.stderr.write('index worker closed the connection\\n');
      process.exit(17);
    }
    return send({ jsonrpc: '2.0', id: request.id, result: { content: [
      { type: 'text', text: process.env.BEELINE_MCP_SURFACE + ':' + process.env.BEELINE_MCP_SERVER },
    ] } });
  }
  send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'no' } });
});
`;

function probeExtension(reportPath: string, expected: string[]): string {
  return `import { writeFileSync } from 'node:fs';
export default function (pi) {
  pi.on('session_start', () => {
    const deadline = Date.now() + 15000;
    const timer = setInterval(() => {
      const names = pi.getAllTools().map((tool) => tool.name);
      if (${JSON.stringify(expected)}.every((name) => names.includes(name)) || Date.now() > deadline) {
        clearInterval(timer);
        writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(names));
      }
    }, 50);
  });
}
`;
}

type Surface = 'room' | 'corner';
type MountOwner = 'bridge' | 'native';
type Fixture = { agentDir: string; cwd: string; names: string[] };

async function toolsPiActuallyHolds(
  surface: Surface,
  executable: string,
  owner: MountOwner,
): Promise<Fixture> {
  const base = resolve(root, owner, surface);
  const agentDir = resolve(base, 'agent');
  const extensions = resolve(agentDir, 'extensions');
  const cwd = resolve(base, 'cwd');
  mkdirSync(extensions, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const serverPath = resolve(base, 'server.mjs');
  const reportPath = resolve(base, 'tools.json');
  writeFileSync(serverPath, MCP_SERVER, 'utf8');
  const names = ['beeline-agent', 'codegraph', 'squire'].map((name) =>
    owner === 'native' ? `mcp__${name}__subscribe_events` : `${name}__subscribe_events`,
  );
  const installed = await installPiMcpBridge({
    agentCommand: 'pi-acp',
    piHome: agentDir,
    piCommand: executable,
    servers: ['beeline-agent', 'codegraph', 'squire'].map((name) => ({
      name,
      command: process.execPath,
      args: [serverPath],
      env: [
        { name: 'BEELINE_MCP_SURFACE', value: surface },
        { name: 'BEELINE_MCP_SERVER', value: name },
        ...(name === 'codegraph'
          ? [{ name: 'MCP_FAIL_ONCE_FILE', value: resolve(base, 'codegraph-exited') }]
          : []),
      ],
    })),
  });
  expect(installed).toBe(
    owner === 'native'
      ? resolve(agentDir, 'mcp.json')
      : resolve(extensions, PI_MCP_BRIDGE_FILENAME),
  );
  // `zz-` so it loads after the bridge; extensions are read in directory order.
  writeFileSync(
    resolve(extensions, 'zz-beeline-probe.js'),
    probeExtension(reportPath, names),
    'utf8',
  );
  const child = spawn(executable, ['--mode', 'rpc', '--no-themes', '--no-session'], {
    cwd,
    env: isolatedEnv(agentDir),
    // pi's RPC mode exits the moment stdin reaches EOF, so the pipe stays open
    // (and unwritten) for as long as the probe needs.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (existsSync(reportPath)) {
        const tools = JSON.parse(readFileSync(reportPath, 'utf8')) as string[];
        expect(tools).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write']));
        for (const name of names) expect(tools.filter((tool) => tool === name)).toHaveLength(1);
        return { agentDir, cwd, names };
      }
      if (child.exitCode !== null) break;
      await new Promise((wake) => setTimeout(wake, 200));
    }
  } finally {
    child.kill('SIGKILL');
  }
  throw new Error(
    `pi never reported its tools (exit ${String(child.exitCode)}): ${stderr.slice(0, 800)}`,
  );
}

describe.skipIf(!pi)('repository Pi loads the generated MCP bridge', () => {
  it.each(['room', 'corner'] as const)(
    'holds each bridged tool once in a %s session',
    { timeout: 90_000 },
    async (surface) => {
      await toolsPiActuallyHolds(surface, pi!, 'bridge');
      console.info(
        `${surface} Pi ${versionOf(pi!)} bridge registry: beeline-agent, codegraph, squire once`,
      );
    },
  );

  it('chooses one mount file for the repository Pi executable', { timeout: 15_000 }, async () => {
    const agentDir = resolve(root, 'owner-probe');
    mkdirSync(agentDir, { recursive: true });
    const path = await installPiMcpBridge({
      agentCommand: 'pi-acp',
      piHome: agentDir,
      piCommand: pi as string,
      servers: [{ name: 'beeline-agent', command: process.execPath, args: ['--version'], env: [] }],
    });
    expect(path).toBeDefined();
    if (path?.endsWith('mcp.json')) {
      const config = JSON.parse(readFileSync(path, 'utf8'));
      expect(config.mcpServers['beeline-agent'].exposure).toBe('direct');
      expect(existsSync(resolve(agentDir, 'extensions', PI_MCP_BRIDGE_FILENAME))).toBe(false);
    } else {
      expect(path).toBe(resolve(agentDir, 'extensions', PI_MCP_BRIDGE_FILENAME));
      expect(readFileSync(path, 'utf8')).toContain('beeline-agent');
    }
    console.info(
      `repository Pi ${versionOf(pi!)} MCP owner: ${path?.endsWith('mcp.json') ? 'native' : 'bridge'}`,
    );
  });
});

/**
 * pi-acp resolves its own `pi` child against the SESSION's env, not this
 * daemon's `process.env` — and the two can genuinely name different
 * executables (this repository pins an older `pi` on `node_modules/.bin`,
 * ahead of the newer host `pi` on the rest of PATH, which is exactly the
 * "pinned/older vs. newer-on-operator-PATH" split a real deployment can hit
 * too). `installPiMcpBridge` is given only a bare `'pi'` here — production
 * never configures `PI_ACP_PI_COMMAND`, so this IS the real call shape — and
 * the native/bridge choice must follow `agentEnv.PATH`, the exact PATH
 * pi-acp's own child spawn will resolve against, not whatever `PATH` this
 * test (or the daemon) happens to run under.
 */
describe.skipIf(!pi || !nativePi)('the native-MCP probe follows the session PATH, not the daemon’s', () => {
  it('picks the bridge for an agentEnv whose PATH resolves the older pinned Pi', { timeout: 15_000 }, async () => {
    const agentDir = resolve(root, 'path-probe-bridge');
    mkdirSync(agentDir, { recursive: true });
    const olderOnly = (process.env.PATH ?? '')
      .split(delimiter)
      .filter((entry) => entry.includes('node_modules/.bin'))
      .join(delimiter);
    const path = await installPiMcpBridge({
      agentCommand: 'pi-acp',
      piHome: agentDir,
      piCommand: 'pi',
      agentEnv: { ...process.env, PATH: olderOnly },
      servers: [{ name: 'codegraph', command: process.execPath, args: ['--version'], env: [] }],
    });
    expect(path).toBe(resolve(agentDir, 'extensions', PI_MCP_BRIDGE_FILENAME));
  });

  it('picks native mcp.json for an agentEnv whose PATH resolves the newer host Pi — even though this process’s own PATH resolves the older one', { timeout: 15_000 }, async () => {
    const agentDir = resolve(root, 'path-probe-native');
    mkdirSync(agentDir, { recursive: true });
    // Sanity check on the premise: THIS process's ambient PATH resolves the
    // older, non-native Pi (the one vitest put first) — so a probe that
    // ignores `agentEnv` and falls back to `process.env.PATH` would get this
    // case wrong.
    expect(executableOnPath('pi')).toBe(pi);
    const newerOnly = (process.env.PATH ?? '')
      .split(delimiter)
      .filter((entry) => !entry.includes('node_modules/.bin'))
      .join(delimiter);
    const path = await installPiMcpBridge({
      agentCommand: 'pi-acp',
      piHome: agentDir,
      piCommand: 'pi',
      agentEnv: { ...process.env, PATH: newerOnly },
      servers: [{ name: 'codegraph', command: process.execPath, args: ['--version'], env: [] }],
    });
    expect(path).toBe(resolve(agentDir, 'mcp.json'));
    expect(existsSync(resolve(agentDir, 'extensions', PI_MCP_BRIDGE_FILENAME))).toBe(false);
  });
});

/**
 * Exercise the host Pi's native MCP extension itself after a real RPC session
 * has proved the registry. No model is needed: Pi's own registered tool
 * definitions call the same MCP connection and reconnect after its child dies.
 */
async function nativeCalls(surface: Surface, input: Fixture): Promise<void> {
  const piDist = resolve(dirname(realpathSync(nativePi!)), '..');
  const mcpIndex = (await import(
    pathToFileURL(resolve(piDist, 'extensions/mcp/index.js')).href
  )) as {
    createMcpExtension: (options: Record<string, unknown>) => (pi: object) => void;
  };
  const mcpConfig = (await import(
    pathToFileURL(resolve(piDist, 'extensions/mcp/config.js')).href
  )) as {
    loadMcpConfig: (options: Record<string, unknown>) => unknown;
  };
  type NativeTool = {
    name: string;
    execute: (id: string, params: object) => Promise<{ content: { text: string }[] }>;
  };
  const tools = new Map<string, NativeTool>();
  const handlers = new Map<string, (event: object, ctx: object) => void | Promise<void>>();
  const piRuntime = {
    on: (name: string, handler: (event: object, ctx: object) => void | Promise<void>) =>
      handlers.set(name, handler),
    registerTool: (tool: NativeTool) => tools.set(tool.name, tool),
    registerCommand: () => {},
    getMcpServers: () => [],
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
  mcpIndex.createMcpExtension({
    loadConfig: () =>
      mcpConfig.loadMcpConfig({ agentDir: input.agentDir, cwd: input.cwd, projectTrusted: false }),
  })(piRuntime);
  const context = { cwd: input.cwd, ui: { notify: () => {} } };
  await handlers.get('session_start')?.({}, context);
  await handlers.get('before_agent_start')?.({}, context);
  try {
    for (const [index, name] of input.names.entries()) {
      const tool = tools.get(name);
      expect(tool, `${surface}: native Pi registered ${name}`).toBeDefined();
      if (index === 1) {
        await expect(tool!.execute('first', {})).rejects.toThrow(/connection closed/i);
        expect(readFileSync(resolve(root, 'native', surface, 'codegraph-exited'), 'utf8')).toBe(
          'exited',
        );
      }
      const result = await tool!.execute('retry', {});
      expect(result.content[0]?.text).toBe(
        `${surface}:${['beeline-agent', 'codegraph', 'squire'][index]}`,
      );
    }
    expect([...tools.keys()].filter((name) => input.names.includes(name))).toHaveLength(3);
  } finally {
    await handlers.get('session_shutdown')?.({}, context);
  }
}

describe.skipIf(!nativePi)('host Pi native MCP loader', () => {
  it.each(['room', 'corner'] as const)(
    'mounts %s tools once, calls them, and reconnects after an MCP exit',
    { timeout: 90_000 },
    async (surface) => {
      const input = await toolsPiActuallyHolds(surface, nativePi!, 'native');
      expect(existsSync(resolve(input.agentDir, 'extensions', PI_MCP_BRIDGE_FILENAME))).toBe(false);
      await nativeCalls(surface, input);
      console.info(
        `${surface} Pi ${versionOf(nativePi!)} native registry/calls/reconnect: beeline-agent, codegraph, squire once`,
      );
    },
  );
});
