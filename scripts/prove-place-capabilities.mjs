// Built MCP discovery-to-prompt proof with isolated server eligibility fixtures.
// Run after npm run build -w @beeline/body.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleTurnPrompt } from '../apps/body/dist/prompt-assembly.js';

const root = await mkdtemp(join(tmpdir(), 'beeline-capabilities-proof-'));
let eligible = false;
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ repositoryOnboarding: eligible }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const names = text => [...new Set(text.match(/beeline:[a-z_]+/g) ?? [])].sort();
try {
  for (const surface of ['room', 'dm', 'code-corner', 'repo-less-corner']) {
    const corner = surface.endsWith('corner');
    const context = join(root, 'context.json');
    await writeFile(context, JSON.stringify({ roomId: 'proof', requestId: 'proof', generationId: 'proof' }));
    const child = spawn(process.execPath, ['apps/body/dist/read-only-mcp.js'], {
      env: { ...process.env, BEELINE_MCP_SURFACE: 'agent', BEELINE_DAEMON_ROOM_ID: 'proof',
        BEELINE_DAEMON_CORNER_ID: corner ? 'proof' : '', BEELINE_DAEMON_AGENT_ID: 'proof',
        BEELINE_DAEMON_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        BEELINE_DAEMON_TOKEN: 'isolated-fixture', BEELINE_TURN_CONTEXT_FILE: context },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const pending = new Map();
    let id = 0;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      const result = JSON.parse(line);
      pending.get(result.id)?.(result);
      pending.delete(result.id);
    });
    const call = async (method, params = {}) => {
      const requestId = ++id;
      const answer = await new Promise(resolve => {
        pending.set(requestId, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      });
      assert.equal(answer.error, undefined);
      assert.notEqual(answer.result.isError, true, JSON.stringify(answer.result));
      return answer.result;
    };
    try {
      const inventory = await call('tools/list');
      for (eligible of [false, true]) {
        const discovery = await call('tools/call', { name: 'connect', arguments: { mode: 'discover' } });
        const offered = [...new Set([...JSON.parse(discovery.content[0].text).capabilities,
          ...names(inventory.tools.find(tool => tool.name === 'app_tool').description)])].sort();
        for (const app of offered) {
          const result = await call('tools/call', { name: 'app_tool', arguments: { app } });
          assert.ok(JSON.parse(result.content[0].text).tools.length);
        }
        for (const commandReason of ['human_tag', 'schedule']) {
          const prompt = assembleTurnPrompt({ surface, onboarding: eligible, task: { body: 'Check capabilities.', commandReason } }).text;
          const block = prompt.split('\n\n').find(line => line.startsWith('Works here ('));
          assert.deepEqual(names(block.split('Corner only:')[0]), offered);
          console.log(`${surface} eligibility=${eligible} ${commandReason}: PASS ${block}`);
        }
      }
    } finally {
      child.kill();
      lines.close();
    }
  }
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}
