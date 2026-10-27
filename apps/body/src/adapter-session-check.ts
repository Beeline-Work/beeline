import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient } from './acp.js';

/** Shared by candidate promotion and daily CI. Never sends session/prompt. */
export async function checkAdapterSession(options: {
  command: string;
  env: Record<string, string>;
  scratchRoot?: string;
  timeoutMs?: number;
  onStage?: (stage: 'initialize' | 'session/new') => void;
  onInitialized?: (result: {
    protocolVersion: number;
    agentCapabilities: Record<string, unknown>;
  }) => void;
}): Promise<{ protocolVersion: number; agentCapabilities: Record<string, unknown> }> {
  const cwd = await mkdtemp(join(options.scratchRoot ?? tmpdir(), 'beeline-adapter-session-'));
  const client = new AcpClient({
    agentCommand: options.command,
    agentEnv: options.env,
    agentCwd: cwd,
    inheritProcessEnv: false,
    resourceScope: 'none',
    backgroundTasks: true,
  });
  let negotiated: Record<string, unknown> | undefined;
  client.once('initialized', (result: Record<string, unknown>) => {
    negotiated = result;
  });
  const timeoutMs = options.timeoutMs ?? 30_000;
  try {
    options.onStage?.('initialize');
    await client.start(timeoutMs);
    if (negotiated?.protocolVersion !== 1) {
      throw new Error(`Unsupported ACP protocolVersion: ${String(negotiated?.protocolVersion)}`);
    }
    const capabilities = negotiated.agentCapabilities;
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
      throw new Error('initialize returned invalid agentCapabilities');
    }
    const result = {
      protocolVersion: 1,
      agentCapabilities: capabilities as Record<string, unknown>,
    };
    options.onInitialized?.(result);
    options.onStage?.('session/new');
    // Use the production serializer, including its systemPrompt, harness-specific
    // _meta and MCP declarations. Omitting the prompt missed the Oct 2026 break.
    await client.sessionNew({
      cwd,
      systemPrompt: 'You are a Beeline agent. Use only the tools provided for this session.',
      mcpServers: [
        {
          name: 'beeline-adapter-check',
          command: process.execPath,
          args: [
            '-e',
            `const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', line => { const r = JSON.parse(line); if (r.id === undefined) return;
const result = r.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'beeline-adapter-check',version:'1'}} : r.method === 'tools/list' ? {tools:[]} : {};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n'); });`,
          ],
          env: [],
        },
      ],
      timeoutMs,
    });
    // Capabilities are negotiated optional features, never a package-version gate.
    return result;
  } finally {
    await client.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}
