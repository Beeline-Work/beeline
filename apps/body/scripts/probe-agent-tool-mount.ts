#!/usr/bin/env node
/** Live harness canary for the release-owned Beeline agent-tool mount. */
import { mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { AcpClient } from '../src/acp.js';
import { prepareRoomAgentHome } from '../src/agent-home.js';
import { AgentToolHostBroker } from '../src/agent-tool-host-broker.js';
import { piMcpDirectToolSelection, preparePiMcpSession } from '../src/pi-mcp-session.js';

const command = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const workflow = process.argv.includes('--workflow');
if (!command) {
  throw new Error('usage: probe-agent-tool-mount.ts <ACP harness command> [--workflow]');
}

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
const transcripts: string[] = [];
const cornerId = `corner-${harness}`;
const openResults = new Map<string, { corner_id: string; feature_ref: string }>();
const broker = new AgentToolHostBroker();
let client: AcpClient | undefined;
try {
  const server = await broker.mcpServer({
    channelId: `probe-${harness}`,
    invoke: async (tool, args) => {
      calls.push({ tool, args });
      if (tool !== 'read_mandate') {
        if (tool === 'open_corner') {
          const objective = String(args.objective ?? '');
          const result =
            openResults.get(objective) ?? {
              corner_id: cornerId,
              feature_ref: `refs/heads/probe/${harness}`,
            };
          openResults.set(objective, result);
          return { status: 'executed', event_id: 'b'.repeat(64), result };
        }
        if (tool === 'deliver') {
          const content = String(args.content ?? '');
          const name = String(args.name ?? '');
          return {
            status: 'executed',
            event_id: 'c'.repeat(64),
            result: {
              artifact_id: 'c'.repeat(64),
              url: 'https://example.invalid/probe-artifact',
              name,
              sha256: createHash('sha256').update(content).digest('hex'),
              size: Buffer.byteLength(content),
              mime_type: 'text/html',
            },
          };
        }
        if (tool === 'close_corner') {
          return {
            status: 'approval_pending',
            request_id: 'd'.repeat(64),
            event_id: 'd'.repeat(64),
            message: 'The exact reviewed tip is frozen and waiting for owner approval.',
          };
        }
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
    await client.setConfigOption(session.sessionId, 'model', 'openrouter-ox/deepseek/deepseek-v4-flash');
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
  transcripts.push(result.agentText);
  if (workflow) {
    const prompts = [
      'Call open_corner with objective "add a haiku file". Use the returned corner id in your reply.',
      'Simulate a transport retry: call open_corner again with the exact objective "add a haiku file". Report the returned corner id.',
      'Make a small HTML file without using the filesystem: call deliver with name "index.html", inline content "<!doctype html><title>Bee</title><p>Hello</p>", and audience "parent_room".',
      `You are done. Call close_corner for ${cornerId} with disposition "land" and report the structured status.`,
    ];
    for (const prompt of prompts) {
      const turn = await client.sessionPrompt(session.sessionId, prompt, 120_000);
      transcripts.push(turn.agentText);
      result = turn;
    }
  }
  const openCalls = calls.filter((call) => call.tool === 'open_corner');
  const passed = workflow
    ? calls.some((call) => call.tool === 'read_mandate') &&
      openCalls.length === 2 &&
      calls.some(
        (call) =>
          call.tool === 'deliver' &&
          call.args.name === 'index.html' &&
          typeof call.args.content === 'string' &&
          !('path' in call.args),
      ) &&
      calls.some(
        (call) =>
          call.tool === 'close_corner' &&
          call.args.corner_id === cornerId &&
          call.args.disposition === 'land',
      )
    : calls.length === 1 && calls[0]?.tool === 'read_mandate';
  console.log(
    JSON.stringify(
      {
        harness,
        mode: workflow ? 'workflow' : 'mount',
        passed,
        calls,
        transcripts,
        stopReason: result.stopReason,
        updateKinds: result.updates.map((update) => update.update.sessionUpdate),
        acpToolCalls: result.toolCalls,
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
} finally {
  await client?.stop().catch(() => undefined);
  await broker.close();
}
