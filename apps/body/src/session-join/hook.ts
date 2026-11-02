// Ported from Reason Network (src/hook.rs), Copyright 2026 Reason Machines, Inc., MIT OR Apache-2.0.
// See ./NOTICE and ./UPSTREAM.json for the copied commit.
//
// `usebeeline session hook <app> <event>` runs from an app's hook system or plugin. It records that the session is
// alive, and prints whatever makes the app show Beeline messages waiting for it. It never fails loudly: a broken
// Beeline must not break the app.
import { sessionAgentBehavior } from '../agent-command.js';
import type { AgentId } from './agents.js';
import { forgetHookSession, readState, recordHookSession, takeInbox, type JoinedSession } from './store.js';


/** What happened, in the app's terms: start, prompt, tool, stop or end. */
export function normalizeEvent(event: string, state?: string): 'start' | 'prompt' | 'tool' | 'stop' | 'end' | undefined {
  if (event === 'session-start') return 'start';
  if (event === 'user-prompt-submit') return 'prompt';
  if (event === 'post-tool-use') return 'tool';
  if (event === 'stop' || event === 'poll') return 'stop';
  if (event === 'session-end') return 'end';
  if (event === 'status') return state === 'busy' || state === 'retry' ? 'prompt' : 'stop';
  return undefined;
}

/** Hook events whose output an app puts in front of the model. */
export function takesMail(agent: AgentId, event: string): boolean {
  return (sessionAgentBehavior(agent).mailEvents ?? ['session-start', 'user-prompt-submit', 'post-tool-use', 'stop']).includes(event);
}

/** The JSON (or text) each app expects from this hook to put `text` in front of the model. */
export function formatFor(agent: AgentId, event: string, text: string): string {
  const ev = normalizeEvent(event);
  const policy = sessionAgentBehavior(agent);
  if (policy.pollText && event === 'poll') return text;
  const shape = ev && policy.hookOutput?.[ev as 'start' | 'prompt' | 'tool' | 'stop'];
  if (!shape) return text;
  if (shape === 'inject') return JSON.stringify({ injectSteps: [{ userMessage: text }] });
  if (shape === 'block' || shape === 'continue' || shape === 'deny') return JSON.stringify({ decision: shape, reason: text });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: shape, additionalContext: text } });
}

export interface HookInput {
  agent: AgentId;
  event: string;
  /** The app's hook payload on stdin, if it sends one. */
  payload: Record<string, unknown>;
  session?: string;
  state?: string;
  pid?: number;
  env?: NodeJS.ProcessEnv;
  /** The session's identity and Beeline rules, put in front of the model when its session starts. */
  rules?: (joined: JoinedSession) => string;
}

/** The joined record this hook's session acts as: its own conversation first, else its folder's. */
export function joinedFor(sessions: JoinedSession[], agent: AgentId, sessionId: string, cwd: string): JoinedSession | undefined {
  return sessions.find(s => s.agent === agent && s.sessionId === sessionId) ?? sessions.find(s => s.agent === agent && s.cwd === cwd);
}

/** Records the hook and returns what to print, or '' to print nothing. */
export function runHook(dir: string, input: HookInput, now = Date.now()): string {
  const { agent, event, payload } = input;
  const str = (key: string) => typeof payload[key] === 'string' && payload[key] ? payload[key] as string : undefined;
  const sessionId = input.session ?? str('session_id') ?? str('conversation_id') ?? str('conversationId') ?? str('sessionId');
  if (!sessionId) return '';
  const env = input.env ?? process.env;
  const cwd = str('cwd') ?? env.GEMINI_CWD ?? env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const ev = normalizeEvent(event, input.state);
  if (!ev) return '';
  if (ev === 'end') {
    forgetHookSession(dir, agent, sessionId);
    return '';
  }
  recordHookSession(dir, { agent, sessionId, cwd, pid: input.pid, seenAt: now,
    state: ev === 'stop' ? 'idle' : 'busy', transcript: str('transcript_path') ?? str('transcriptPath') });
  const joined = joinedFor(readState(dir).sessions, agent, sessionId, cwd);
  if (!joined || !takesMail(agent, event)) return '';
  const waiting = takeInbox(dir, joined.key);
  // Say who it is on Beeline and how to work there once, at session start: a reopened or compacted session
  // otherwise knows only the text of its next delivery.
  const text = [ev === 'start' && input.rules ? input.rules(joined) : '', waiting].filter(Boolean).join('\n\n');
  if (!text) return '';
  return formatFor(agent, event, text);
}
