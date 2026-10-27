// Isolated Pi user-path proof: scripted local model, real shell and extension.
// No production request, external model, or operator configuration is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { installPiTurnBudget } from '../apps/body/dist/pi-turn-budget.js';

const root = await mkdtemp(resolve(tmpdir(), 'beeline-command-budget-proof-'));
const pi = resolve('node_modules/.bin/pi');
async function run(bounded) {
  const cwd = resolve(root, bounded ? 'after' : 'before');
  const home = resolve(cwd, 'home');
  await mkdir(home, { recursive: true });
  const context = resolve(cwd, 'turn.json');
  let sawDeliveryInstruction = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const tool = request.messages.findLast(message => message.role === 'tool');
    let delta;
    if (tool) {
      sawDeliveryInstruction = JSON.stringify(tool).includes('Deliver any finished files now');
      delta = { role: 'assistant', content: sawDeliveryInstruction
        ? 'The render ran out of command time. partial.txt is ready; the remaining render is unfinished.'
        : 'The render finished.' };
    } else {
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'render', type: 'function', function: {
        name: 'bash', arguments: JSON.stringify({ command: 'printf partial > partial.txt; sleep 20; printf finished > finished.txt', timeout: 900 }),
      } }] };
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'proof', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'proof', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'stop' : 'tool_calls' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await writeFile(resolve(home, 'models.json'), JSON.stringify({ providers: { proof: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-placeholder',
    models: [{ id: 'proof', reasoning: false, contextWindow: 32000, maxTokens: 1024 }],
  } } }));
  if (bounded) await installPiTurnBudget(home);
  const child = spawn(pi, ['--mode', 'rpc', '--provider', 'proof', '--model', 'proof', '--no-session', '--no-skills', '--no-prompt-templates', '--no-themes'], {
    cwd, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home,
      PI_CODING_AGENT_DIR: home, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1',
      BEELINE_FREE_AGENT_ID: 'proof', BEELINE_FREE_AGENT_MAX_TURN_SECONDS: '6', BEELINE_TURN_CONTEXT_FILE: context },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const waiters = [];
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let event; try { event = JSON.parse(line); } catch { continue; }
      for (const waiter of [...waiters]) if (waiter.matches(event)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); }
    }
  });
  const wait = matches => new Promise(resolve => waiters.push({ matches, resolve }));
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  let timer;
  try {
    const ready = wait(event => event.type === 'response' && event.command === 'get_state');
    send({ type: 'get_state' });
    await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Pi startup: ' + stderr)), 15000); })]);
    clearTimeout(timer);
    await writeFile(context, JSON.stringify({ startedAt: Date.now() }));
    const started = Date.now();
    const end = wait(event => event.type === 'agent_end');
    send({ type: 'prompt', message: 'Render the test asset and give me the completed files or explain what remains.' });
    const outcome = await Promise.race([end, new Promise(resolve => { timer = setTimeout(() => resolve(null), 6000); })]);
    clearTimeout(timer);
    const elapsed = Date.now() - started;
    if (!bounded) {
      assert.equal(outcome, null, 'Unbounded command should still be running at the hard cutoff');
      send({ type: 'abort' });
      await end;
      console.log('Reproduction avatar-timeout BEFORE: command outlasts turn budget; no model delivery before cutoff (existing hard-cap notice is separate).');
    } else {
      assert.ok(outcome, 'Expected delivery before the cutoff: ' + stderr);
      assert.ok(sawDeliveryInstruction, 'Model must receive the command-budget explanation');
      const final = outcome.messages.filter(message => message.role === 'assistant').at(-1);
      assert.match(JSON.stringify(final), /partial.txt is ready/);
      assert.ok(elapsed < 6000);
      console.log(`Reproduction avatar-timeout AFTER: ${elapsed}ms; user receives: ${final.content.filter(part => part.type === 'text').map(part => part.text).join('')}`);
    }
    assert.equal(await readFile(resolve(cwd, 'partial.txt'), 'utf8'), 'partial');
    await assert.rejects(readFile(resolve(cwd, 'finished.txt'), 'utf8'));
  } finally {
    clearTimeout(timer);
    child.kill('SIGTERM');
    await once(child, 'exit');
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
try { await run(false); await run(true); }
finally { await rm(root, { recursive: true, force: true }); }
