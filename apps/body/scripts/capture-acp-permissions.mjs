#!/usr/bin/env node
/**
 * Capture the REAL `session/request_permission` payloads an installed ACP
 * adapter sends, so `src/fixtures/claude-agent-acp-permissions.ts` is recorded
 * evidence rather than a guess about a wire format.
 *
 * It drives the adapter exactly the way `src/acp.ts` does — `initialize`, then
 * `session/new` mounting one MCP server named `buzz-readonly-mcp` (the stub in
 * `acp-permission-probe-mcp.mjs`, which advertises the same six tool names as
 * `read-only-policy.ts`), then `session/prompt` — rejects every permission it
 * is asked for, and writes what it saw to JSON.
 *
 *   node scripts/capture-acp-permissions.mjs \
 *     --agent "$(which claude-agent-acp)" \
 *     --cwd . --out /tmp/capture.json \
 *     --prompt 'Call the buzz-readonly-mcp read_file tool on "README.md". Then stop.'
 *
 * Needs the adapter's own credentials and makes a real model call, which is why
 * it is a script and not a test.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const agent = args.get('--agent');
const cwd = resolve(args.get('--cwd') ?? process.cwd());
const out = args.get('--out') ?? 'acp-permission-capture.json';
const prompt =
  args.get('--prompt') ??
  'Call the buzz-readonly-mcp read_file tool on the path "README.md", then call its git_log tool with limit 3. Do not use any built-in tool. Then stop.';
if (!agent) {
  console.error('usage: capture-acp-permissions.mjs --agent <acp-binary> [--cwd .] [--out f.json] [--prompt "..."]');
  process.exit(2);
}

const child = spawn(agent, [], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env, cwd });
const pending = new Map();
const permissions = [];
const updates = [];
let buf = '';
let nextId = 1;

const write = (message) => child.stdin.write(JSON.stringify(message) + '\n');
const request = (method, params) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    write({ jsonrpc: '2.0', id, method, params });
  });

child.stderr.on('data', (d) => process.stderr.write('[acp] ' + d));
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (p) (msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result));
      continue;
    }
    if (msg.method === 'session/request_permission') {
      permissions.push(msg.params);
      const reject = msg.params?.options?.find((o) => o.kind?.startsWith('reject'));
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: { outcome: { outcome: 'selected', optionId: reject?.optionId ?? 'reject' } },
      });
      continue;
    }
    if (msg.method === 'session/update') updates.push(msg.params?.update);
    if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});

const initialize = await request('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});
const { sessionId } = await request('session/new', {
  cwd,
  mcpServers: [
    {
      name: 'buzz-readonly-mcp',
      command: process.execPath,
      args: [fileURLToPath(new URL('./acp-permission-probe-mcp.mjs', import.meta.url))],
      env: [],
    },
  ],
  systemPrompt: 'You are in a read-only room. Use the buzz-readonly-mcp tools.',
});
await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
writeFileSync(out, JSON.stringify({ agent, initialize, permissions, updates }, null, 2));
console.error(`captured ${permissions.length} permission request(s) -> ${out}`);
child.kill('SIGTERM');
process.exit(0);
