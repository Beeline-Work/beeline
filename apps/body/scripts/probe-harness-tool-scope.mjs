#!/usr/bin/env node
/**
 * Ask a real ACP harness what tools a Beeline-shaped session actually has.
 *
 * This is the live proof for the connector-scope fix: it drives the exact
 * `session/new` params `apps/body` sends (`buildSessionNewParams`), so what it
 * observes is what a Room member observes.
 *
 * Usage:
 *   node apps/body/scripts/probe-harness-tool-scope.mjs <agent-command> [--leaky] [--prompt "..."]
 *
 *   --leaky   omit Beeline's tool-scope `_meta` (reproduces the pre-fix
 *             behaviour: the operator's personal MCP servers and claude.ai
 *             connectors are in the session).
 *
 * Exit code 0 always; read the printed transcript.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const agentCommand = argv.find((a) => !a.startsWith('--'));
if (!agentCommand) {
  console.error('usage: probe-harness-tool-scope.mjs <agent-command> [--leaky] [--prompt "..."]');
  process.exit(2);
}
const leaky = argv.includes('--leaky');
const promptIdx = argv.indexOf('--prompt');
const promptText =
  promptIdx >= 0 && argv[promptIdx + 1]
    ? argv[promptIdx + 1]
    : 'List the exact name of every tool you can call, one per line, and nothing else.';

// Mirrors apps/body/src/harness-tool-scope.ts. Kept as a literal so the probe
// runs straight from a checkout with no build step.
const CLAUDE_TOOL_SCOPE_META = {
  claudeCode: {
    options: {
      strictMcpConfig: true,
      settings: JSON.stringify({ disableClaudeAiConnectors: true }),
    },
  },
};
const isClaude = /(^|[/\\])claude-(agent|code)-acp(\.[a-z]+)?$/i.test(agentCommand);
const isCodex = /(^|[/\\])codex-acp(\.[a-z]+)?$/i.test(agentCommand);

const env = { ...process.env };
if (!leaky && isCodex) {
  // codex-acp has no session-level allowlist: it MERGES the client's servers
  // into $CODEX_HOME/config.toml's own [mcp_servers]. The only lever is the
  // isolated harness home `agent-home.ts` already builds for a Room, so the
  // probe builds the same thing (Beeline-owned dir + the operator's auth.json
  // symlinked back, credentials shared, config not).
  const home = mkdtempSync(join(tmpdir(), 'beeline-codex-home-'));
  try {
    symlinkSync(join(homedir(), '.codex', 'auth.json'), join(home, 'auth.json'));
  } catch {
    /* unauthenticated codex: the probe still shows the MCP surface */
  }
  env.CODEX_HOME = home;
  console.error(`[probe] isolated CODEX_HOME=${home}`);
}

const child = spawn(agentCommand, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => process.stderr.write(`[agent] ${c}`));

let buf = '';
let nextId = 1;
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (!p) continue;
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      continue;
    }
    if (msg.method === 'session/update') {
      const u = msg.params?.update;
      if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
        process.stdout.write(u.content.text);
      }
      continue;
    }
    // Any request from the agent (permissions, fs) is answered permissively:
    // this probe measures the tool surface, not the permission boundary.
    if (msg.method && msg.id !== undefined) {
      const optionId = msg.params?.options?.find((o) => /allow/i.test(o.optionId ?? ''))?.optionId;
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: optionId
            ? { outcome: { outcome: 'selected', optionId } }
            : {},
        }) + '\n',
      );
    }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const cwd = process.cwd();
try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  notify('notifications/initialized', {});
  const params = {
    cwd,
    // Beeline always mounts at least one of its own MCP servers. `true` is a
    // no-op stdio server: the point is the *shape* of the request, not the tools.
    mcpServers: [{ name: 'buzz-probe-mcp', command: '/bin/true', args: [], env: [] }],
  };
  if (!leaky && isClaude) params._meta = CLAUDE_TOOL_SCOPE_META;
  const session = await request('session/new', params);
  console.log(`\n--- session ${session.sessionId} (${leaky ? 'LEAKY / pre-fix' : 'SCOPED / fixed'}) ---\n`);
  await request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: promptText }],
  });
  console.log('\n--- end ---');
} catch (error) {
  console.error('probe failed:', error);
} finally {
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 300);
}
