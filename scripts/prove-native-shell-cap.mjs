/** SHELL-CAP: run installed Claude Code against a local recorded model. No account calls. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import {
  NATIVE_SHELL_OUTPUT_SCRIPT,
  nativeShellHookConfig,
  nativeShellHookCommand,
  NATIVE_SHELL_OUTPUT_CAP,
} from '../apps/body/dist/native-shell-output.js';

const out = resolve(process.argv[2] ?? '.scratch/native-shell-cap');
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), 'beeline-native-model-'));
const hook = join(home, 'shell-hook.cjs');
await writeFile(hook, NATIVE_SHELL_OUTPUT_SCRIPT);
const exitCode = process.argv.includes('--fail') ? 7 : 0;
const command = `${JSON.stringify(process.execPath)} -e 'process.stdout.write("HEAD\\n"+"x".repeat(400000)+"\\nTAIL\\n");process.exitCode=${exitCode}'`;
let received, receivedError,
  count = 0;
const server = createServer(async (req, res) => {
  let text = '';
  for await (const part of req) text += part;
  if (!req.url.includes('/messages')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  const body = JSON.parse(text);
  const results = body.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((c) => c.type === 'tool_result');
  if (results.length) { received = results.at(-1).content; receivedError = results.at(-1).is_error === true; }
  const use = !received && count++ === 0;
  const content = use
    ? [{ type: 'tool_use', id: 'shell-proof', name: 'Bash', input: { command } }]
    : [{ type: 'text', text: 'Proof complete.' }];
  const response = {
    id: 'msg_native_proof',
    type: 'message',
    role: 'assistant',
    model: body.model,
    content,
    stop_reason: use ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (name, data) =>
    res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`);
  event('message_start', {
    message: { ...response, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } },
  });
  event('content_block_start', {
    index: 0,
    content_block: use ? { ...content[0], input: {} } : { type: 'text', text: '' },
  });
  event('content_block_delta', {
    index: 0,
    delta: use
      ? { type: 'input_json_delta', partial_json: JSON.stringify({ command }) }
      : { type: 'text_delta', text: 'Proof complete.' },
  });
  event('content_block_stop', { index: 0 });
  event('message_delta', {
    delta: { stop_reason: response.stop_reason, stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  event('message_stop', {});
  res.end();
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
try {
  const settings = join(home, 'settings.json');
  await writeFile(settings, JSON.stringify(nativeShellHookConfig(nativeShellHookCommand(hook, 'claude'))));
  const child = spawn(
    'claude',
    [
      '--print',
      '--model',
      'claude-sonnet-4-6',
      '--settings',
      settings,
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      'Run the provided command once.',
    ],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        ANTHROPIC_API_KEY: 'local-recorded-provider',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDECODE: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let logs = '';
  child.stdout.on('data', (b) => {
    logs += b;
  });
  child.stderr.on('data', (b) => {
    logs += b;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  const code = await new Promise((done) => child.on('exit', done));
  clearTimeout(timer);
  await writeFile(join(out, 'claude-process.txt'), logs);
  assert.equal(code, 0, logs);
  const text = typeof received === 'string' ? received : JSON.stringify(received);
  assert.ok(text, 'No native tool result reached the model');
  assert.equal(receivedError, exitCode !== 0, 'Native failure status must reach the model');
  const path = /full output: (.*?)\. Read a bounded/.exec(text)?.[1];
  assert.ok(path, text.slice(0, 1000));
  assert.ok(text.includes('HEAD') && text.includes('TAIL'), 'Preview must retain head and tail');
  const original = await readFile(path, 'utf8');
  assert.equal(original, 'HEAD\n' + 'x'.repeat(400000) + '\nTAIL\n');
  assert.ok(Buffer.byteLength(text) <= NATIVE_SHELL_OUTPUT_CAP + 1000);
  const proof = {
    reproduction: 'SHELL-CAP',
    harness: 'Claude Code',
    exitCode,
    failurePreserved: receivedError === (exitCode !== 0),
    provider: 'local recorded model; installed native harness',
    originalBytes: Buffer.byteLength(original),
    modelBytes: Buffer.byteLength(text),
    capBytes: NATIVE_SHELL_OUTPUT_CAP,
    recovered: true,
  };
  await writeFile(join(out, 'claude-model-result.txt'), text);
  await writeFile(join(out, 'claude.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally {
  await new Promise((done) => server.close(done));
  await rm(home, { recursive: true, force: true });
}
