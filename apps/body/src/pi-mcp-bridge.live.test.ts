/**
 * pi's OWN loader must find the bridge and end up holding its tools.
 *
 * The unit tests prove the generated module speaks MCP; they cannot prove that
 * pi discovers a `.js` in `$PI_CODING_AGENT_DIR/extensions`, loads it through
 * jiti, awaits an async factory before the session starts, and accepts a raw
 * MCP JSON Schema as a tool's parameters. Those four facts are what makes the
 * daemon tool panel reachable from a pi Room turn at all, and every one of them
 * is a property of the installed pi rather than of this repository.
 *
 * No model and no network: pi is started in RPC mode and a second, generated
 * probe extension writes `pi.getAllTools()` to a file at `session_start`.
 * Soft-skips when pi is not installed on this host.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { executableOnPath } from './agent-command.js';
import { PI_MCP_BRIDGE_FILENAME, piMcpBridgeSource } from './pi-mcp-bridge.js';

const pi = executableOnPath('pi');
const root = mkdtempSync(resolve(tmpdir(), 'beeline-pi-bridge-live-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const MCP_SERVER = `import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize')
    return send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } } });
  if (request.method === 'tools/list')
    return send({ jsonrpc: '2.0', id: request.id, result: { tools: [
      { name: 'subscribe_events', description: 'Choose which things happening in this Room wake you.', inputSchema: { type: 'object', required: ['kinds'], properties: { kinds: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } },
    ] } });
  send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'no' } });
});
`;

function probeExtension(reportPath: string): string {
  return `import { writeFileSync } from 'node:fs';
export default function (pi) {
  pi.on('session_start', () => {
    writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(pi.getAllTools().map((tool) => tool.name)));
  });
}
`;
}

async function toolsPiActuallyHolds(): Promise<string[]> {
  const agentDir = resolve(root, 'agent');
  const extensions = resolve(agentDir, 'extensions');
  const cwd = resolve(root, 'cwd');
  mkdirSync(extensions, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const serverPath = resolve(root, 'server.mjs');
  const reportPath = resolve(root, 'tools.json');
  writeFileSync(serverPath, MCP_SERVER, 'utf8');
  writeFileSync(
    resolve(extensions, PI_MCP_BRIDGE_FILENAME),
    piMcpBridgeSource([
      { name: 'beeline-agent', command: process.execPath, args: [serverPath], env: [] },
    ]),
    'utf8',
  );
  // `zz-` so it loads after the bridge; extensions are read in directory order.
  writeFileSync(resolve(extensions, 'zz-beeline-probe.js'), probeExtension(reportPath), 'utf8');
  const child = spawn(pi as string, ['--mode', 'rpc', '--no-themes', '--no-session'], {
    cwd,
    env: {
      ...process.env,
      HOME: root,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
    },
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
      if (existsSync(reportPath)) return JSON.parse(readFileSync(reportPath, 'utf8')) as string[];
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

describe.skipIf(!pi)('pi loads the generated MCP bridge', () => {
  it('holds the bridged daemon tools in its own registry', { timeout: 90_000 }, async () => {
    const tools = await toolsPiActuallyHolds();
    // The four pi ships with, proving the probe read a real registry...
    expect(tools).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write']));
    // ...and the one the bridge put there, which is the whole point.
    expect(tools).toContain('beeline-agent__subscribe_events');
  });
});
