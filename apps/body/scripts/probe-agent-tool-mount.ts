#!/usr/bin/env node
/** Live harness canary for the release-owned Beeline agent-tool mount. */
import { mkdir, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { AcpClient } from '../src/acp.js';
import { prepareRoomAgentHome } from '../src/agent-home.js';
import { AgentToolHostBroker } from '../src/agent-tool-host-broker.js';
import { piMcpDirectToolSelection, preparePiMcpSession } from '../src/pi-mcp-session.js';

const command = process.argv[2];
if (!command) throw new Error('usage: probe-agent-tool-mount.ts <ACP harness command>');

const harness = basename(command).replace(/[^a-z0-9_-]+/gi, '-');
const root = resolve(process.cwd(), '.scratch', 'agent-tool-mount', harness);
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true, mode: 0o700 });
const home = await prepareRoomAgentHome({
  root: resolve(root, 'agent-home'),
  failClosed: true,
  skillReleaseId: 'agent-tool-conformance',
});

const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
const broker = new AgentToolHostBroker();
let client: AcpClient | undefined;
try {
  const server = await broker.mcpServer({
    channelId: `probe-${harness}`,
    invoke: async (tool, args) => {
      calls.push({ tool, args });
      if (tool !== 'read_mandate') {
        return { status: 'denied', code: 'probe_read_only', message: 'Probe is read-only.' };
      }
      return {
        schema_version: 1,
        generation: { event_id: 'a'.repeat(64), generation: 1 },
        grants: [],
        defaults: [
          { action: 'corner.open', version: 1, effect: 'allow' },
          { action: 'corner.close', version: 1, effect: 'approval_required' },
          { action: 'artifact.deliver', version: 1, effect: 'allow' },
        ],
        blockers: [],
      };
    },
  });
  const agentEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...home }).filter(
      ([name, value]) =>
        typeof value === 'string' &&
        !['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'SSH_AUTH_SOCK'].includes(name),
    ),
  ) as Record<string, string>;
  if (/^pi-acp(?:\.|$)/i.test(harness) && agentEnv.PI_CODING_AGENT_DIR) {
    agentEnv.PI_CODING_AGENT_DIR = await preparePiMcpSession({
      baseDir: agentEnv.PI_CODING_AGENT_DIR,
      channelId: `probe-${harness}`,
      mcpServers: [server],
    });
    agentEnv.MCP_DIRECT_TOOLS = piMcpDirectToolSelection([server]);
  }
  client = new AcpClient({
    agentCommand: command,
    agentLabel: command,
    agentEnv,
    agentCwd: root,
    autoApprovePermissions: true,
  });
  await client.start();
  const session = await client.sessionNew({
    cwd: root,
    mode: 'readonly',
    mcpServers: [server],
    systemPrompt: 'Use mounted Beeline tools directly. This is an isolated conformance probe.',
  });
  if (/^pi-acp(?:\.|$)/i.test(harness)) {
    await client.setConfigOption(session.sessionId, 'model', 'openrouter-ox/z-ai/glm-5.3-flash');
  }
  let result = await client.sessionPrompt(
    session.sessionId,
    'Call the mounted Beeline read_mandate tool exactly once, then reply with the returned generation number.',
    120_000,
  );
  if (calls.length === 0) {
    result = await client.sessionPrompt(
      session.sessionId,
      'The mount is ready now. Call the mounted Beeline read_mandate tool exactly once, then reply with the returned generation number.',
      120_000,
    );
  }
  console.log(
    JSON.stringify(
      {
        harness,
        passed: calls.length === 1 && calls[0]?.tool === 'read_mandate',
        calls,
        transcript: result.agentText,
        stopReason: result.stopReason,
        updateKinds: result.updates.map((update) => update.update.sessionUpdate),
        acpToolCalls: result.toolCalls,
      },
      null,
      2,
    ),
  );
  if (calls.length !== 1 || calls[0]?.tool !== 'read_mandate') process.exitCode = 1;
} finally {
  await client?.stop().catch(() => undefined);
  await broker.close();
}
