// The session finder: every live coding-agent session on this machine, and which one a joined member is in now.
// Ported from Reason Network (src/daemon/sessions.rs, src/claude.rs), Copyright 2026 Reason Machines, Inc.,
// MIT OR Apache-2.0. See ./NOTICE and ./UPSTREAM.json for the copied commit.
import type { AgentId } from './agents.js';
import { scanClaude, type ClaudeSession } from './claude.js';
import { scanCodex, type CodexSession } from './codex.js';
import { hookSessions, type HookSession, type JoinedSession } from './store.js';

export interface LiveSession {
  agent: AgentId;
  sessionId: string;
  cwd?: string;
  pid?: number;
  /** Claude Code's inbox socket. */
  socket?: string;
  /** A Codex thread's rollout. */
  rollout?: string;
  /** What a hook last said, for apps that report it. */
  state?: 'busy' | 'idle';
}

export interface Sources {
  claude: () => ClaudeSession[];
  codex: () => CodexSession[];
  hooks: () => HookSession[];
}

export function machineSources(dir: string, env: NodeJS.ProcessEnv = process.env): Sources {
  return { claude: () => scanClaude(env), codex: () => scanCodex(), hooks: () => hookSessions(dir) };
}

/** Claude Code's registry and Codex's open rollouts first; hooks add every other app, and anything those missed. */
export function liveSessions(sources: Sources): LiveSession[] {
  const found: LiveSession[] = [];
  for (const c of sources.claude()) {
    if (c.sessionId) found.push({ agent: 'claude-code', sessionId: c.sessionId, cwd: c.cwd, pid: c.pid, socket: c.messagingSocketPath,
      state: c.status === 'busy' ? 'busy' : 'idle' });
  }
  for (const c of sources.codex()) found.push({ agent: 'codex', sessionId: c.threadId, cwd: c.cwd, pid: c.pid, rollout: c.rollout });
  for (const h of sources.hooks()) {
    if (found.some(s => s.agent === h.agent && s.sessionId === h.sessionId)) continue;
    found.push({ agent: h.agent, sessionId: h.sessionId, cwd: h.cwd, pid: h.pid, state: h.state,
      ...(h.agent === 'codex' && h.transcript ? { rollout: h.transcript } : {}) });
  }
  return found;
}

/**
 * The live session a joined member is in: its own conversation while that runs, else the one session of the same app
 * now open in its folder (the person closed it and opened it again). With several there, the newest process wins.
 * A session another joined member is already in is never taken.
 */
export function findSession(joined: JoinedSession, live: LiveSession[], others: JoinedSession[] = []): LiveSession | undefined {
  const exact = live.find(s => s.agent === joined.agent && s.sessionId === joined.sessionId);
  if (exact) return exact;
  const claimed = (s: LiveSession) => others.some(o => o.key !== joined.key && o.agent === s.agent && o.sessionId === s.sessionId);
  return live
    .filter(s => s.agent === joined.agent && s.cwd === joined.cwd && !claimed(s))
    .sort((a, b) => (b.pid ?? 0) - (a.pid ?? 0))[0];
}
