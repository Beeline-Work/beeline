import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpClient, AcpResourceLimitError } from './acp.js';

const systemdAvailable = process.platform === 'linux' &&
  spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }).status === 0;

const agentSource = `
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  const reply = (value) => send({ jsonrpc: '2.0', id: request.id, result: value });
  if (request.method === 'initialize') reply({ protocolVersion: 1 });
  if (request.method === 'session/new') reply({ sessionId: 'test' });
  if (request.method === 'session/prompt') {
    if (request.params.prompt[0].text === 'spawn') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
        { detached: true, stdio: 'ignore' });
      writeFileSync(process.env.GRANDCHILD_PID_FILE, String(child.pid));
      reply({ stopReason: 'end_turn' });
    } else {
      const blocks = [];
      while (true) blocks.push(Buffer.alloc(16 * 1024 * 1024, 1));
    }
  }
  if (request.method === 'shutdown') process.exit(0);
});
`;

async function waitForDead(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!existsSync(`/proc/${pid}`)) return;
    const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    if (!status || /^\d+ \(.+\) Z /.test(status)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} survived ACP scope teardown`);
}

describe.skipIf(!systemdAvailable)('managed ACP resource scope', () => {
  let root: string | undefined;
  let client: AcpClient | undefined;

  afterEach(async () => {
    await client?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function start(memoryMaxBytes = 256 * 1024 * 1024): Promise<string> {
    root = await mkdtemp(join(process.cwd(), 'acp-scope-test-'));
    const script = join(root, 'agent.mjs');
    const pidFile = join(root, 'grandchild.pid');
    await writeFile(script, agentSource);
    client = new AcpClient({
      agentCommand: process.execPath,
      agentArgs: [script],
      agentEnv: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        GRANDCHILD_PID_FILE: pidFile,
      },
      resourceScope: 'systemd',
      resourceScopeMemoryMaxBytes: memoryMaxBytes,
    });
    await client.start();
    return (await client.sessionNew({ cwd: root })).sessionId;
  }

  it('kills a tool that created its own process group when the session stops', async () => {
    const session = await start();
    await client!.sessionPrompt(session, 'spawn');
    const pid = Number(await readFile(join(root!, 'grandchild.pid'), 'utf8'));
    expect(existsSync(`/proc/${pid}`)).toBe(true);
    await client!.stop();
    await waitForDead(pid);
  }, 15_000);

  it('reports a per-session memory kill as a resource limit', async () => {
    const session = await start(128 * 1024 * 1024);
    const error = await client!.sessionPrompt(session, 'allocate').catch((failure) => failure);
    expect(error).toBeInstanceOf(AcpResourceLimitError);
    expect(error.message).toContain('128 MiB memory limit');
  }, 15_000);
});
