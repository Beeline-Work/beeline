import { once } from 'node:events';
import { expect, it } from 'vitest';
import { AcpClient, AcpRuntimeExitedError } from './acp.js';
import { startAgentProcess, stopAgentProcess } from './agent-process.js';

const fixture = `
const readline = require('node:readline');
const input = readline.createInterface({input:process.stdin});
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,agentCapabilities:{}}})+'\\n');
  if (request.method === 'session/new') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{sessionId:'fixture'}})+'\\n');
  if (request.method === 'session/prompt') process.stderr.write('prompt-ready');
});`;

it('settles a silent prompt from actual process death and never restarts it', async () => {
  const client = new AcpClient({
    agentCommand: process.execPath,
    agentArgs: ['-e', fixture],
    agentEnv: {},
    inheritProcessEnv: false,
    resourceScope: 'none',
  });
  try {
    await startAgentProcess(client);
    const session = await client.sessionNew({ cwd: process.cwd() });
    const ready = once(client, 'stderr');
    const prompt = client.sessionPrompt(session.sessionId, 'work');
    const rejected = expect(prompt).rejects.toBeInstanceOf(AcpRuntimeExitedError);
    await ready;
    process.kill(client.processPid()!, 'SIGKILL');
    await rejected;
    expect(client.isAlive).toBe(false);
  } finally {
    await stopAgentProcess(client);
  }
});

it('stopping a process rejects its pending request without a timer or shutdown wait', async () => {
  const client = new AcpClient({
    agentCommand: process.execPath,
    agentArgs: ['-e', fixture],
    agentEnv: {},
    inheritProcessEnv: false,
    resourceScope: 'none',
  });
  try {
    await startAgentProcess(client);
    const session = await client.sessionNew({ cwd: process.cwd() });
    const ready = once(client, 'stderr');
    const prompt = client.sessionPrompt(session.sessionId, 'work');
    const rejected = expect(prompt).rejects.toBeInstanceOf(AcpRuntimeExitedError);
    await ready;
    await stopAgentProcess(client);
    await rejected;
    expect(client.isAlive).toBe(false);
  } finally {
    await stopAgentProcess(client);
  }
});

it('cleans up an unspawnable program without waiting for an exit event it cannot emit', async () => {
  const client = new AcpClient({
    agentCommand: '/does-not-exist/beeline-agent',
    agentEnv: {},
    inheritProcessEnv: false,
    resourceScope: 'none',
  });
  await expect(startAgentProcess(client)).rejects.toThrow();
  expect(client.isAlive).toBe(false);
  await stopAgentProcess(client);
});
