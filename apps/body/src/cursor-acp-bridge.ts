#!/usr/bin/env node
/**
 * Beeline-owned ACP bridge for `cursor-agent`.
 *
 * cursor-agent has no native ACP server. The only published third-party
 * adapter (`cursor-agent-acp@0.1.1`) is an unfinished stub: `prompt()` returns
 * `{ stopReason: "end_turn" }` without waiting, and its catch path returns
 * `{ stopReason: "refusal" }` — the exact Room failure line. This process
 * speaks ACP over stdio and drives cursor-agent in the verified non-interactive
 * streaming mode, translating stream-json events into `session/update`
 * notifications so `acp.ts` sees real `agent_message_chunk` text.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { enumerateCursorModels, type CursorModelCatalog } from './cursor-models.js';

/** Hidden CLI flag so a bundled `beeline` process can be the ACP child. */
export const CURSOR_ACP_BRIDGE_FLAG = '--cursor-acp-bridge';

/**
 * Stable harness identity for classification. Spawn argv is `node` plus this
 * module (or the bundled CLI plus {@link CURSOR_ACP_BRIDGE_FLAG}), so callers
 * that match on the spawn command would otherwise classify every cursor
 * session as `node`.
 */
export const CURSOR_ACP_BRIDGE_LABEL = 'cursor-acp-bridge';

/**
 * cursor-agent's non-interactive allow-all switch (`--force` / `--yolo`).
 * Beeline already sandboxes the child and owns tool permission, so Cursor
 * must not prompt for commands in a Room or corner.
 */
export const CURSOR_AGENT_FORCE_FLAG = '--force';

/** Skips the Workspace Trust gate that otherwise wedges a fresh worktree. */
export const CURSOR_AGENT_TRUST_FLAG = '--trust';

/** Match the owned bridge and the retired stub so leftover labels still classify. */
export const CURSOR_HARNESS_COMMAND =
  /(^|[/\\])(cursor-acp-bridge|cursor-agent-acp)(\.[a-z]+)?$/i;

const STDERR_TAIL_MAX_CHARS = 2_000;
const MODEL_AXIS_ID = 'model';

export type AcpSessionUpdate = {
  sessionUpdate: string;
  content?: { type: 'text'; text: string };
};

export type CursorStreamEvent = {
  type?: unknown;
  subtype?: unknown;
  text?: unknown;
  is_error?: unknown;
  result?: unknown;
  message?: unknown;
};

export type CursorAgentSpawn = (input: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => ChildProcess;

export type CursorAcpWriter = (message: Record<string, unknown>) => void;

type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type BridgeSession = {
  id: string;
  cwd: string;
  systemPrompt?: string;
  model?: string;
  child?: ChildProcess;
};

export function harnessIdentityLabel(agent: { kind?: string; command?: string }): string {
  if (agent.kind === 'cursor') return CURSOR_ACP_BRIDGE_LABEL;
  return agent.command ?? '';
}

export function cursorAcpBridgeLaunch(): { command: string; args: string[] } {
  const meta = import.meta.url;
  if (meta === 'beeline:bundle' || meta.startsWith('beeline:')) {
    const entry = process.argv[1];
    if (!entry) {
      throw new Error('Cursor ACP bridge cannot resolve the Beeline CLI entry');
    }
    return { command: process.execPath, args: [entry, CURSOR_ACP_BRIDGE_FLAG] };
  }
  const js = fileURLToPath(new URL('./cursor-acp-bridge.js', meta));
  const ts = fileURLToPath(new URL('./cursor-acp-bridge.ts', meta));
  if (existsSync(js)) return { command: process.execPath, args: [js] };
  if (existsSync(ts)) {
    const tsx = createRequire(meta).resolve('tsx');
    return { command: process.execPath, args: ['--import', tsx, ts] };
  }
  throw new Error('Cursor ACP bridge entry not found next to the Beeline helper');
}

/**
 * Argv for one non-interactive cursor-agent turn. The prompt is the last
 * operand — the shape verified to stream thinking + assistant + result.
 */
export function cursorAgentArgv(input: { prompt: string; model?: string }): string[] {
  const argv = [
    '--print',
    '--output-format',
    'stream-json',
    CURSOR_AGENT_TRUST_FLAG,
    CURSOR_AGENT_FORCE_FLAG,
  ];
  if (input.model && input.model !== 'auto') argv.push('--model', input.model);
  argv.push(input.prompt);
  return argv;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function textChunksFromContent(content: unknown): string[] {
  if (typeof content === 'string' && content) return [content];
  if (!Array.isArray(content)) return [];
  const chunks: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record) continue;
    if (record.type === 'text' && typeof record.text === 'string' && record.text) {
      chunks.push(record.text);
    }
  }
  return chunks;
}

function thoughtText(event: CursorStreamEvent): string {
  if (typeof event.text === 'string') return event.text;
  const record = asRecord(event);
  if (!record) return '';
  if (typeof record.delta === 'string') return record.delta;
  return textChunksFromContent(record.content).join('');
}

function assistantTexts(event: CursorStreamEvent): string[] {
  if (typeof event.text === 'string' && event.text) return [event.text];
  const message = asRecord(event.message);
  if (message) return textChunksFromContent(message.content);
  return textChunksFromContent(asRecord(event)?.content);
}

function chunkUpdate(sessionUpdate: 'agent_thought_chunk' | 'agent_message_chunk', text: string): AcpSessionUpdate {
  return { sessionUpdate, content: { type: 'text', text } };
}

/**
 * Map one verified cursor-agent stream-json object onto ACP session updates.
 * `thinking` deltas become thoughts; `assistant` message content becomes the
 * durable answer stream; `result` is the turn-end signal (handled by the
 * caller). Init/user frames are ignored.
 */
export function translateCursorStreamEvent(event: CursorStreamEvent): AcpSessionUpdate[] {
  if (event.type === 'thinking') {
    if (event.subtype === 'completed') return [];
    const text = thoughtText(event);
    return text ? [chunkUpdate('agent_thought_chunk', text)] : [];
  }
  if (event.type === 'assistant') {
    return assistantTexts(event).map((text) => chunkUpdate('agent_message_chunk', text));
  }
  return [];
}

export function resultEventText(event: CursorStreamEvent): string {
  if (typeof event.result === 'string') return event.result;
  const record = asRecord(event.result);
  if (record && typeof record.text === 'string') return record.text;
  return '';
}

export function isCursorResultEvent(event: CursorStreamEvent): boolean {
  return event.type === 'result';
}

export function cursorResultIsError(event: CursorStreamEvent): boolean {
  return event.is_error === true || event.subtype === 'error';
}

function trimReason(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Named failure for a cursor-agent run that must never become a silent empty turn. */
export function describeCursorTurnFailure(input: {
  isError?: boolean;
  resultText?: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  spawnError?: string;
}): string | undefined {
  if (input.spawnError) {
    return trimReason(`cursor-agent failed to start: ${input.spawnError}`);
  }
  const stderr = input.stderr?.trim() ?? '';
  if (input.isError) {
    const named = input.resultText?.trim() || stderr || 'cursor-agent reported an error with no answer text';
    return trimReason(`cursor-agent reported an error: ${named}`);
  }
  if (input.signal) {
    return trimReason(`cursor-agent terminated by ${input.signal}${stderr ? `: ${stderr}` : ''}`);
  }
  if (input.exitCode !== 0 && input.exitCode !== null) {
    return trimReason(
      `cursor-agent exited ${input.exitCode}${stderr ? `: ${stderr}` : ' with no answer text'}`,
    );
  }
  return undefined;
}

function promptTextFromParams(params: unknown, systemPrompt?: string): string {
  const record = asRecord(params);
  const blocks = Array.isArray(record?.prompt) ? record.prompt : [];
  const user = blocks
    .map((block) => {
      const item = asRecord(block);
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .filter(Boolean)
    .join('\n');
  return systemPrompt ? `${systemPrompt}\n\n${user}` : user;
}

function defaultSpawnCursorAgent(input: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ChildProcess {
  return spawn('cursor-agent', input.argv, {
    cwd: input.cwd,
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export interface CursorAcpServerOptions {
  write: CursorAcpWriter;
  spawnCursorAgent?: CursorAgentSpawn;
  enumerateModels?: (env?: NodeJS.ProcessEnv) => Promise<CursorModelCatalog | undefined>;
  env?: NodeJS.ProcessEnv;
}

/**
 * One ACP session server. `handle()` is the test seam; stdio wiring lives in
 * {@link runCursorAcpStdioServer}.
 */
export class CursorAcpServer {
  private readonly write: CursorAcpWriter;
  private readonly spawnCursorAgent: CursorAgentSpawn;
  private readonly enumerateModels: (env?: NodeJS.ProcessEnv) => Promise<CursorModelCatalog | undefined>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessions = new Map<string, BridgeSession>();
  private models: CursorModelCatalog | undefined;
  private modelsLoaded = false;

  constructor(options: CursorAcpServerOptions) {
    this.write = options.write;
    this.spawnCursorAgent = options.spawnCursorAgent ?? defaultSpawnCursorAgent;
    this.enumerateModels = options.enumerateModels ?? enumerateCursorModels;
    this.env = options.env ?? process.env;
  }

  async handle(message: JsonRpcMessage): Promise<void> {
    const method = typeof message.method === 'string' ? message.method : '';
    const id = message.id;
    if (!method) return;
    if (id === undefined) {
      if (method === 'session/cancel') this.cancel(message.params);
      return;
    }
    try {
      const result = await this.dispatch(method, message.params);
      this.write({ jsonrpc: '2.0', id, result });
    } catch (error) {
      const rpcError = error as { code?: number; message?: string };
      this.write({
        jsonrpc: '2.0',
        id,
        error: {
          code: typeof rpcError.code === 'number' ? rpcError.code : -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: 1,
          agentCapabilities: { promptCapabilities: { image: false } },
        };
      case 'session/new':
        return this.sessionNew(params);
      case 'session/prompt':
        return this.sessionPrompt(params);
      case 'session/set_config_option':
        return this.setConfigOption(params);
      case 'session/set_model':
        return this.setModel(params);
      case 'shutdown':
        this.shutdown();
        return {};
      default:
        return {};
    }
  }

  private async loadModels(): Promise<CursorModelCatalog> {
    if (this.modelsLoaded) {
      return this.models ?? { currentValue: 'auto', options: [{ id: 'auto', name: 'Auto' }] };
    }
    this.modelsLoaded = true;
    this.models = await this.enumerateModels(this.env);
    return this.models ?? { currentValue: 'auto', options: [{ id: 'auto', name: 'Auto' }] };
  }

  private async sessionNew(params: unknown): Promise<Record<string, unknown>> {
    const record = asRecord(params);
    const cwd = typeof record?.cwd === 'string' && record.cwd ? record.cwd : process.cwd();
    const systemPrompt = typeof record?.systemPrompt === 'string' ? record.systemPrompt : undefined;
    const catalog = await this.loadModels();
    const session: BridgeSession = {
      id: randomUUID(),
      cwd,
      ...(systemPrompt ? { systemPrompt } : {}),
      model: catalog.currentValue,
    };
    this.sessions.set(session.id, session);
    return {
      sessionId: session.id,
      configOptions: [
        {
          id: MODEL_AXIS_ID,
          category: 'model',
          currentValue: session.model,
          options: catalog.options.map((option) => ({
            id: option.id,
            ...(option.name ? { name: option.name } : {}),
          })),
        },
      ],
    };
  }

  private session(params: unknown): BridgeSession {
    const record = asRecord(params);
    const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : '';
    const session = this.sessions.get(sessionId);
    if (!session) {
      const error = new Error(`unknown ACP session ${sessionId || '(missing)'}`);
      (error as { code?: number }).code = -32602;
      throw error;
    }
    return session;
  }

  private setConfigOption(params: unknown): Record<string, unknown> {
    const session = this.session(params);
    const record = asRecord(params);
    if (record?.configId === MODEL_AXIS_ID && typeof record.value === 'string' && record.value) {
      session.model = record.value;
    }
    return {};
  }

  private setModel(params: unknown): Record<string, unknown> {
    const session = this.session(params);
    const record = asRecord(params);
    if (typeof record?.modelId === 'string' && record.modelId) session.model = record.modelId;
    return {};
  }

  private emitUpdate(sessionId: string, update: AcpSessionUpdate): void {
    this.write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update },
    });
  }

  private async sessionPrompt(params: unknown): Promise<{ stopReason: string }> {
    const session = this.session(params);
    if (session.child) {
      throw new Error('cursor-agent is already running a turn for this session');
    }
    const prompt = promptTextFromParams(params, session.systemPrompt);
    const argv = cursorAgentArgv({ prompt, model: session.model });
    let stderr = '';
    let spawnError: string | undefined;
    let sawAssistant = false;
    let resultEvent: CursorStreamEvent | undefined;
    const pending: string[] = [];

    const consumeLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: CursorStreamEvent;
      try {
        event = JSON.parse(trimmed) as CursorStreamEvent;
      } catch {
        return;
      }
      if (isCursorResultEvent(event)) {
        resultEvent = event;
        return;
      }
      for (const update of translateCursorStreamEvent(event)) {
        if (update.sessionUpdate === 'agent_message_chunk') sawAssistant = true;
        this.emitUpdate(session.id, update);
      }
    };

    const child = this.spawnCursorAgent({ argv, cwd: session.cwd, env: this.env });
    session.child = child;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_MAX_CHARS);
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      pending.push(chunk);
      const joined = pending.join('');
      const lines = joined.split(/\r?\n/);
      pending.length = 0;
      const rest = lines.pop();
      if (rest) pending.push(rest);
      for (const line of lines) consumeLine(line);
    });

    try {
      const { code, signal } = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        let settled = false;
        const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null): void => {
          if (settled) return;
          settled = true;
          resolve({ code: exitCode, signal: exitSignal });
        };
        child.once('error', (error) => {
          spawnError = error instanceof Error ? error.message : String(error);
          finish(1, null);
        });
        child.once('close', (exitCode, exitSignal) => {
          finish(exitCode, exitSignal);
        });
      });
      if (pending.length) consumeLine(pending.join(''));
      const failure = describeCursorTurnFailure({
        isError: resultEvent ? cursorResultIsError(resultEvent) : false,
        resultText: resultEvent ? resultEventText(resultEvent) : undefined,
        exitCode: spawnError ? 1 : code,
        signal,
        stderr,
        spawnError,
      });
      if (failure) throw new Error(failure);
      if (!sawAssistant) {
        const fallback = resultEvent && !cursorResultIsError(resultEvent) ? resultEventText(resultEvent) : '';
        if (fallback) this.emitUpdate(session.id, chunkUpdate('agent_message_chunk', fallback));
      }
      return { stopReason: 'end_turn' };
    } finally {
      session.child = undefined;
    }
  }

  private cancel(params: unknown): void {
    const record = asRecord(params);
    const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : '';
    const session = this.sessions.get(sessionId);
    if (!session?.child?.pid) return;
    try {
      session.child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      if (!session.child?.pid) continue;
      try {
        session.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    this.sessions.clear();
  }
}

export async function runCursorAcpStdioServer(
  options: Omit<CursorAcpServerOptions, 'write'> = {},
): Promise<void> {
  const server = new CursorAcpServer({
    ...options,
    write: (message) => {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
  });
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      continue;
    }
    await server.handle(message);
    if (message.method === 'shutdown') break;
  }
}

function isDirectBridgeRun(): boolean {
  const entry = process.argv[1];
  if (!entry || entry.includes('.test.')) return false;
  try {
    return resolvePath(entry) === resolvePath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectBridgeRun()) {
  void runCursorAcpStdioServer();
}
