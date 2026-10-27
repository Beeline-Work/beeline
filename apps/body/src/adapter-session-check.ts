import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient, AcpRequestError } from './acp.js';
import { prepareRoomAgentHome, roomSessionTmpDir, writeBackRoomClaudeLogin } from './agent-home.js';
import type { ManagedAdapterKind } from './adapter-store.js';

export interface AdapterSessionCheckResult {
  protocolVersion: number;
  agentCapabilities: Record<string, unknown>;
  sessionStart?: 'created' | 'authentication-required';
}

/** Shared by candidate promotion and daily CI. Never sends session/prompt. */
export async function checkAdapterSession(options: {
  command: string;
  env: Record<string, string>;
  scratchRoot?: string;
  timeoutMs?: number;
  /** CI has no login: an auth-only refusal after session/new validates the wire contract. */
  allowUnauthenticatedSession?: boolean;
  /** Helpers prepare exactly the same credential-linked isolated home as Room sessions. */
  agentKind?: ManagedAdapterKind;
  onStage?: (stage: 'initialize' | 'session/new') => void;
  onInitialized?: (result: AdapterSessionCheckResult) => void;
}): Promise<AdapterSessionCheckResult> {
  const cwd = await mkdtemp(join(options.scratchRoot ?? tmpdir(), 'beeline-adapter-session-'));
  const homeRoot = join(cwd, 'agent-home');
  let client: AcpClient | undefined;
  let negotiated: Record<string, unknown> | undefined;
  const timeoutMs = options.timeoutMs ?? 30_000;
  try {
    const homeOverlay = options.agentKind
      ? await prepareRoomAgentHome({
          root: homeRoot,
          operatorHome: options.env.HOME,
          inheritedPath: options.env.PATH,
          agentKind: options.agentKind,
          failClosed: true,
        })
      : {};
    client = new AcpClient({
      agentCommand: options.command,
      agentEnv: { ...options.env, ...homeOverlay },
      agentCwd: cwd,
      inheritProcessEnv: false,
      resourceScope: 'none',
      backgroundTasks: true,
    });
    client.once('initialized', (result: Record<string, unknown>) => {
      negotiated = result;
    });
    options.onStage?.('initialize');
    await client.start(timeoutMs);
    if (negotiated?.protocolVersion !== 1) {
      throw new Error(`Unsupported ACP protocolVersion: ${String(negotiated?.protocolVersion)}`);
    }
    const capabilities = negotiated.agentCapabilities;
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
      throw new Error('initialize returned invalid agentCapabilities');
    }
    const result: AdapterSessionCheckResult = {
      protocolVersion: 1,
      agentCapabilities: capabilities as Record<string, unknown>,
    };
    options.onInitialized?.(result);
    options.onStage?.('session/new');
    // Use the production serializer, including its systemPrompt, harness-specific
    // _meta and MCP declarations. Omitting the prompt missed the Oct 2026 break.
    try {
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
    } catch (error) {
      // Never accept auth from initialize, schema errors mentioning auth, or
      // arbitrary stderr. Only the typed session/new auth-required refusal counts.
      if (
        options.allowUnauthenticatedSession &&
        error instanceof AcpRequestError &&
        error.code === -32000 &&
        /^ACP error -32000: Authentication required(?:[:;]|$)/i.test(error.message)
      ) {
        return { ...result, sessionStart: 'authentication-required' };
      }
      throw error;
    }
    return { ...result, sessionStart: 'created' };
  } finally {
    try {
      await client?.stop();
      if (options.agentKind === 'claude') {
        await writeBackRoomClaudeLogin({ root: homeRoot, operatorHome: options.env.HOME });
      }
    } finally {
      if (options.agentKind) await rm(roomSessionTmpDir(homeRoot), { force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
