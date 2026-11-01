// SILENT-END-1: built helper, MCP handler and ACP stdio; only daemon HTTP is isolated.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient } from '../apps/body/dist/acp.js';
import { CommandExecutionContext } from '../apps/body/dist/server-command-intake.js';

const root = await mkdtemp(join(tmpdir(), 'beeline-silent-end-'));
const requests = [];
const server = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  requests.push({ path: request.url, body: JSON.parse(raw) });
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ items: [] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const context = new CommandExecutionContext(root);
const handler = new URL('../apps/body/dist/read-only-mcp.js', import.meta.url).href;
const peer = join(root, 'peer.mjs');
const caller = `
import { callAgentTool } from ${JSON.stringify(handler)};
const shape = process.argv[1];
const results = await Promise.all([
  ...(shape === 'parallel' ? [callAgentTool('read', { facet: 'messages' }, 'read')] : []),
  callAgentTool('no_reply_needed', {}, 'silent'),
]);
process.stdout.write(results.at(-1));
`;
await writeFile(peer, `
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line), params = message.params;
  const reply = result => send({ jsonrpc: '2.0', id: message.id, result });
  const update = value => send({ jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: params.sessionId, update: value } });
  if (message.method === 'initialize') reply({ protocolVersion: 1 });
  else if (message.method === 'session/new') reply({ sessionId: 'proof' });
  else if (message.method === 'session/prompt') {
    const shape = params.prompt[0].text;
    if (shape === 'later-trigger') {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Later trigger handled.' } });
      reply({ stopReason: 'end_turn' });
      return;
    }
    update({ sessionUpdate: 'tool_call', toolCallId: 'silent',
      title: 'mcp__beeline-agent__no_reply_needed', status: 'in_progress' });
    const run = async () => {
      try {
        const running = exec(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(caller)}, shape]);
        running.child.stdin.end();
        const { stdout } = await running;
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'silent', status: 'completed', rawOutput: stdout });
      } catch (error) {
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'silent', status: 'failed', rawOutput: String(error) + (error.stderr ?? '') });
      }
    };
    if (shape === 'background') {
      setTimeout(run, 50);
      reply({ stopReason: 'end_turn' });
    } else {
      await run();
      reply({ stopReason: 'end_turn' });
    }
  } else if (message.method === 'shutdown') process.exit(0);
  else if (message.id !== undefined) reply({});
});
`);
const isolatedHome = join(root, 'home');
await mkdir(isolatedHome);
const client = new AcpClient({ agentCommand: process.execPath, agentArgs: [peer], agentEnv: {
  PATH: process.env.PATH, HOME: isolatedHome, XDG_CONFIG_HOME: join(root, 'config'),
  XDG_STATE_HOME: join(root, 'state'), BEELINE_TURN_CONTEXT_FILE: context.path,
  BEELINE_DAEMON_ROOM_ID: 'proof', BEELINE_DAEMON_CORNER_ID: 'proof',
  BEELINE_DAEMON_BASE_URL: `http://127.0.0.1:${server.address().port}`, BEELINE_DAEMON_TOKEN: 'isolated-proof',
} });
try {
  await client.start();
  const { sessionId } = await client.sessionNew({ cwd: root });
  const continuations = [];
  for (const shape of ['alone', 'parallel', 'background']) {
    await context.enter({ roomId: 'proof', turnRequestId: shape, rootCommandId: shape, reason: 'system' });
    const result = await client.sessionPrompt(sessionId, shape, 5000, undefined, undefined, undefined,
      call => continuations.push(call));
    assert.equal(result.stopReason, 'no-reply', JSON.stringify(result));
    assert.equal(result.agentText, '');
    assert.ok(result.toolCalls.some(call => call.status === 'completed' &&
      call.rawOutput === JSON.stringify({ acknowledged: true })), 'silent MCP result must reach the harness');
    assert.equal(client.hasBackgroundTools, false);
    await context.leave();
    console.log(`SILENT-END-1 ${shape}: acknowledged, no text, no background continuation`);
  }
  assert.equal(continuations.length, 0);
  assert.equal(requests.filter(request => request.path.endsWith('/markAgentTurnSilent')).length, 3);
  await context.enter({ roomId: 'proof', turnRequestId: 'later', rootCommandId: 'later', reason: 'system' });
  const next = await client.sessionPrompt(sessionId, 'later-trigger', 5000);
  assert.equal(next.agentText, 'Later trigger handled.');
  console.log('SILENT-END-1 later trigger: handled normally');
} finally {
  await client.stop();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
