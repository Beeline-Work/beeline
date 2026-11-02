// TOKEN-OUTPUT: real JSON-RPC call through the built model-facing MCP facade.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const root = await mkdtemp(join(tmpdir(), 'token-output-proof-'));
const original = { content: [{ type: 'text', text: 'HEAD ' + '🐝'.repeat(100_000) + ' TAIL' }] };
const server = createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ allowed: true }));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let child;
try {
  const upstream = join(root, 'upstream.cjs');
  await writeFile(upstream, `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const m=JSON.parse(line); if(m.id===undefined)return;
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:${JSON.stringify(original)}})+'\\n');
  });`);
  const auth = join(root, 'fixture-auth.json');
  const context = join(root, 'turn.json');
  await writeFile(auth, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`,
    daemonToken: 'fixture-only', turnContextPath: context }));
  await writeFile(context, JSON.stringify({ roomId: 'room', requestId: 'request', generationId: 'generation' }));
  child = spawn(process.execPath, [resolve('apps/body/dist/resource-mcp-facade.js')], {
    env: { ...process.env, BEELINE_RESOURCE_TARGET: 'fixture', BEELINE_RESOURCE_AUTH_FILE: auth,
      BEELINE_ATTACH_SCRATCH_ROOT: root,
      BEELINE_RESOURCE_LAUNCH: JSON.stringify({ command: process.execPath, args: [upstream] }) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout });
  const received = new Promise((done, fail) => {
    const timeout = setTimeout(() => fail(Error('MCP reply timed out')), 10_000);
    lines.once('line', line => { clearTimeout(timeout); done(JSON.parse(line)); });
    child.once('error', fail);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'large_output', arguments: {} } }) + '\n');
  const reply = await received;
  assert.ok(Buffer.byteLength(JSON.stringify(reply.result)) <= 32_768);
  const text = reply.result.content[0].text;
  assert.ok(text.includes('HEAD ') && text.includes(' TAIL'));
  const path = JSON.parse(text.match(/Full result saved at (".*?")\./)[1]);
  const saved = await readFile(path);
  assert.deepEqual(JSON.parse(saved), original);
  assert.equal(reply.result._meta.originalOutputBytes, saved.byteLength);
  assert.ok(saved.subarray(100, 200).length === 100);
  lines.close();
  console.log(`Demonstrated TOKEN-OUTPUT: built MCP reply capped; original (${saved.byteLength} bytes) recovered from saved output.`);
} finally {
  child?.kill();
  await new Promise(done => server.close(done));
  await rm(root, { recursive: true, force: true });
}
