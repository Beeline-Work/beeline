/** SHELL-CAP: new native Cursor invocation; no existing conversation is resumed. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareRoomAgentHome } from '../apps/body/dist/agent-home.js';
import { NATIVE_SHELL_OUTPUT_CAP } from '../apps/body/dist/native-shell-output.js';
const out = resolve(process.argv[2] ?? '.scratch/cursor-shell-cap');
await mkdir(out, { recursive: true });
const workspace = await mkdtemp(join(tmpdir(), 'beeline-cursor-shell-'));
try {
  await mkdir(join(workspace, '.cursor'));
  const env = await prepareRoomAgentHome({
    root: join(workspace, 'agent-home'),
    operatorHome: process.env.HOME,
    agentKind: 'cursor',
    failClosed: true,
  });
  const audit = join(workspace, 'audit.cjs'),
    result = join(out, 'native-post.json');
  await writeFile(
    audit,
    `const fs=require('fs');let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(result)},b);console.log('{}')});`,
  );
  await writeFile(
    join(workspace, '.cursor', 'hooks.json'),
    JSON.stringify({
      version: 1,
      hooks: {
        postToolUse: [
          { matcher: 'Shell', command: JSON.stringify(process.execPath) + ' ' + JSON.stringify(audit) },
        ],
      },
    }),
  );
  const command = `${JSON.stringify(process.execPath)} -e 'process.stdout.write("HEAD\\n"+"x".repeat(400000)+"\\nTAIL\\n")'`;
  const child = spawn(
    'cursor-agent',
    [
      '--print',
      '--output-format',
      'stream-json',
      '--force',
      '--trust',
      `Run exactly this single shell command, then reply done. Use the native Shell tool, without changing the command or running any other tools: ${command}`,
    ],
    { cwd: workspace, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let logs = '';
  child.stdout.on('data', (b) => (logs += b));
  child.stderr.on('data', (b) => (logs += b));
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
  const code = await new Promise((done) => child.on('exit', done));
  clearTimeout(timer);
  await writeFile(join(out, 'process.jsonl'), logs);
  assert.equal(code, 0, logs.slice(-2000));
  const event = JSON.parse(await readFile(result, 'utf8'));
  const text = typeof event.tool_output === 'string' ? event.tool_output : JSON.stringify(event.tool_output);
  const file = /full output: (.*?)\. Read a bounded/.exec(text)?.[1];
  assert.ok(file, text?.slice(0, 1000));
  const original = await readFile(file, 'utf8');
  assert.equal(original, 'HEAD\n' + 'x'.repeat(400000) + '\nTAIL\n');
  assert.ok(Buffer.byteLength(text) <= NATIVE_SHELL_OUTPUT_CAP);
  const proof = {
    reproduction: 'SHELL-CAP',
    harness: 'Cursor',
    provider: 'installed native Cursor, fresh conversation, native post-tool observation',
    originalBytes: Buffer.byteLength(original),
    modelBytes: Buffer.byteLength(text),
    capBytes: NATIVE_SHELL_OUTPUT_CAP,
    recovered: true,
  };
  await writeFile(join(out, 'cursor.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
