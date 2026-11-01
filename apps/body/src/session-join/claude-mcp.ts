import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ancestors } from './agents.js';
import { postToClaude, scanClaude, type ClaudeSession } from './claude.js';
import { pidAlive, queueInbox, readState, takeInbox } from './store.js';

interface InSession { pid: number; claudePid: number }

export function hasClaudeMcp(dir: string, claudePid?: number): boolean {
  if (!claudePid) return false;
  let files: string[];
  try { files = readdirSync(join(dir, 'claude-mcp')); } catch { return false; }
  return files.some(file => {
    try {
      const entry = JSON.parse(readFileSync(join(dir, 'claude-mcp', file), 'utf8')) as InSession;
      return entry.claudePid === claudePid && pidAlive(entry.pid);
    } catch { return false; }
  });
}

/** The token stays in the MCP child's memory, never in the bridge state, registry, argv or stdout. */
export async function flushClaudeMcp(dir: string, session: ClaudeSession, token: string,
  post: typeof postToClaude = postToClaude): Promise<void> {
  if (!session.messagingSocketPath) return;
  const joined = readState(dir).sessions.find(s => s.agent === 'claude-code' && (s.pid === session.pid || s.sessionId === session.sessionId));
  if (!joined) return;
  const text = takeInbox(dir, joined.key);
  if (!text) return;
  try { await post({ path: session.messagingSocketPath, token }, text); }
  catch { queueInbox(dir, joined.key, text); }
}

/** Claude starts this stdio server inside each session and supplies that session's messaging token. */
export async function runClaudeMcp(dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const chain = ancestors(process.pid);
  let registration: string | undefined;
  let flushing = false;
  const flush = async () => {
    if (flushing || !env.CLAUDE_CODE_MESSAGING_TOKEN) return;
    flushing = true;
    try {
      const live = scanClaude(env);
      const session = chain.map(pid => live.find(s => s.pid === pid)).find(Boolean);
      if (!session) return;
      if (!registration) {
        const folder = join(dir, 'claude-mcp');
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        registration = join(folder, `${process.pid}.json`);
        writeFileSync(registration, JSON.stringify({ pid: process.pid, claudePid: session.pid }), { mode: 0o600 });
      }
      await flushClaudeMcp(dir, session, env.CLAUDE_CODE_MESSAGING_TOKEN);
    } finally { flushing = false; }
  };
  const timer = setInterval(() => { void flush().catch(() => undefined); }, 500);
  try {
    await flush();
    for await (const line of createInterface({ input: process.stdin })) {
      let request: { id?: unknown; method?: string; params?: { protocolVersion?: string } };
      try { request = JSON.parse(line); } catch { continue; }
      if (request.id === undefined) continue;
      const result = request.method === 'initialize' ? { protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: 'beeline', version: '1.0.0' } }
        : request.method === 'tools/list' ? { tools: [] } : request.method === 'ping' ? {} : undefined;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(result ? { result } : { error: { code: -32601, message: 'Method not found' } }) }) + '\n');
    }
  } finally {
    clearInterval(timer);
    if (registration) rmSync(registration, { force: true });
  }
}
