import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient } from './acp.js';
import { beelineAgentMcpServer } from './room-session.js';
import { DaemonApiClient } from './daemon-api-client.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(process.platform !== 'linux')('TOKEN-ARGV-1: new and resumed harnesses launch MCP with secrets outside argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-launch-proof-'));
  roots.push(root);
  const probe = join(root, 'probe.mjs');
  await writeFile(probe, `
import { readFileSync } from 'node:fs';
const token = process.env.BEELINE_DAEMON_TOKEN;
const secrets = [token, process.env.BEELINE_SQUIRE_RELAY_TOKEN, process.env.BEELINE_GRANT_RUNNER_TOKEN];
let pid = process.pid, argvClean = true;
while (pid > 1) {
 const args = readFileSync('/proc/' + pid + '/cmdline', 'utf8');
 argvClean &&= secrets.every(secret => !args.includes(secret));
 const status = readFileSync('/proc/' + pid + '/status', 'utf8');
 pid = Number(status.match(/^PPid:\\s+(\\d+)/m)[1]);
}
console.log(JSON.stringify({ received: token === 'synthetic-daemon-proof' && secrets[1] === 'synthetic-relay-proof' && secrets[2] === 'synthetic-grant-proof',
  argvClean }));
`);
  const adapter = join(root, 'adapter.mjs');
  await writeFile(adapter, `
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
const reply = (id, result) => console.log(JSON.stringify({ jsonrpc:'2.0', id, result }));
createInterface({ input: process.stdin }).on('line', line => {
 const request = JSON.parse(line);
 if (request.method === 'initialize') reply(request.id, { protocolVersion:1, agentCapabilities:{ loadSession:true } });
 else if (['session/new','session/load'].includes(request.method)) {
  const server = request.params.mcpServers[0];
  // Reproduce adapters which carry the MCP configuration in their child's argv.
  const result = execFileSync(process.execPath, ['-e',
    'const {execFileSync}=require("node:child_process");const s=JSON.parse(process.argv[1]);process.stdout.write(execFileSync(s.command,s.args,{env:{...process.env,...Object.fromEntries(s.env.map(e=>[e.name,e.value]))}}));',
    JSON.stringify(server)], { encoding:'utf8' });
  reply(request.id, { sessionId:'proof', proof:{...JSON.parse(result), adapterEnvClean: process.env.BEELINE_DAEMON_TOKEN === undefined && process.env.BEELINE_SQUIRE_RELAY_TOKEN === undefined && process.env.BEELINE_GRANT_RUNNER_TOKEN === undefined} });
 }
});
`);
  const client = new AcpClient({ agentCommand: process.execPath, agentArgs: [adapter], agentEnv: { HOME:root, PATH:process.env.PATH! }, resourceScope:'none' });
  try {
    await client.start();
    const mcpServers = [beelineAgentMcpServer({
      agentBinary: process.execPath, mcpBinary: 'unused', agentEnv: {},
      workspaceRoot: root, autoApprovePermissions: false,
      readonlyMcpCommand: process.execPath, readonlyMcpArgs: [probe],
    }, new DaemonApiClient('http://127.0.0.1', 'synthetic-daemon-proof', 'agent'), {
      roomId: 'room', workspaceId: 'workspace',
      squireRelay: { url: 'http://127.0.0.1', token: 'synthetic-relay-proof' },
      grantRunner: { url: 'http://127.0.0.1', token: 'synthetic-grant-proof' },
    })];
    for (const result of [await client.sessionNew({ cwd:root, mcpServers }), await client.sessionLoad({ cwd:root, sessionId:'proof', mcpServers })]) {
      expect((result.raw as { proof: unknown }).proof).toEqual({ received:true, argvClean:true, adapterEnvClean:true });
    }
    const directories = (await readdir(root)).filter(name => name.startsWith('.beeline-mcp-'));
    expect(directories).toHaveLength(1);
    const directory = join(root, directories[0]!);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(directory)) expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
  } finally { await client.stop(); }
  expect((await readdir(root)).some(name => name.startsWith('.beeline-mcp-'))).toBe(false);
});
