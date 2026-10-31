// Ported from Reason Network (src/hook.rs), Copyright 2026 Reason Machines, Inc., MIT OR Apache-2.0.
// See ./NOTICE and ./UPSTREAM.json for the copied commit.
//
// `usebeeline session hook <app> <event>` runs from an app's hook system or plugin. It records that the session is
// alive, and prints whatever makes the app show Beeline messages waiting for it. It never fails loudly: a broken
// Beeline must not break the app.
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
  // Antigravity consumes injectSteps before invocation, and a continue reason at a natural Stop.
  if (agent === 'antigravity') return ['session-start', 'user-prompt-submit', 'stop'].includes(event);
  // Plugins ask when the session can take a message; their other calls only report state.
  if (agent === 'opencode' || agent === 'hermes' || agent === 'zcode') return event === 'poll';
  if (agent === 'pi') return event === 'poll' || event === 'post-tool-use';
  return ['session-start', 'user-prompt-submit', 'post-tool-use', 'stop'].includes(event);
}

/** The JSON (or text) each app expects from this hook to put `text` in front of the model. */
export function formatFor(agent: AgentId, event: string, text: string): string {
  const ev = normalizeEvent(event);
  const specific = (name: string) => ({ hookSpecificOutput: { hookEventName: name, additionalContext: text } });
  const block = { decision: 'block', reason: text };
  let out: unknown;
  if (agent === 'antigravity' && (ev === 'start' || ev === 'prompt')) out = { injectSteps: [{ userMessage: text }] };
  else if (agent === 'antigravity' && ev === 'stop') out = { decision: 'continue', reason: text };
  else if ((agent === 'opencode' || agent === 'pi' || agent === 'hermes' || agent === 'zcode') && event === 'poll') return text;
  else if (agent === 'claude-code' && ev === 'start') out = specific('SessionStart');
  else if (agent === 'claude-code' && ev === 'prompt') out = specific('UserPromptSubmit');
  else if (agent === 'claude-code' && ev === 'stop') out = block;
  else if (agent === 'codex' && ev === 'start') out = specific('SessionStart');
  else if (agent === 'codex' && ev === 'prompt') out = specific('UserPromptSubmit');
  else if (agent === 'codex' && ev === 'tool') out = specific('PostToolUse');
  else if (agent === 'codex' && ev === 'stop') out = block;
  else if (agent === 'gemini' && ev === 'start') out = specific('SessionStart');
  else if (agent === 'gemini' && ev === 'prompt') out = specific('BeforeAgent');
  else if (agent === 'gemini' && ev === 'tool') out = specific('AfterTool');
  else if (agent === 'gemini' && ev === 'stop') out = { decision: 'deny', reason: text };
  else return text;
  return JSON.stringify(out);
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
  // Say who it is on Beeline once, at session start.
  const text = waiting || (ev === 'start' ? `Beeline: you are @${joined.handle ?? joined.name} in your owner's Beeline Rooms. Tags arrive in this conversation.` : '');
  if (!text) return '';
  return formatFor(agent, event, text);
}
