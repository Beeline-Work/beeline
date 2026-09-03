/**
 * pi's own record of a turn, read after the ACP stream delivered no answer.
 *
 * pi-acp (0.0.33) reports every finished pi turn as `stopReason: 'end_turn'`,
 * including one whose assistant message pi itself recorded as
 * `stopReason: 'error'` with the provider's refusal text (the live case:
 * OpenRouter `402` credits exhaustion — the prompt "completes" in ~200ms with
 * zero content updates). pi-acp has no `message_end` handler, so that text
 * never reaches the ACP stream. pi's session record is the one place the fact
 * survives: `$PI_CODING_AGENT_DIR/sessions/<cwd>/<ts>_<sessionId>.jsonl`
 * (pi's own layout; the ACP session id IS pi's session id), indexed by pi-acp
 * at `$HOME/.pi/pi-acp/session-map.json`. Both live in the Room's isolated
 * agent home (`agent-home.ts`), which the daemon reads from the host.
 */
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type PiTurnRecord =
  /** pi recorded a provider/model error for this turn. */
  | { kind: 'error'; reason: string; status?: number }
  /** pi recorded an assistant message that carries no text. */
  | { kind: 'empty'; stopReason: string }
  /** pi recorded answer text the ACP stream never delivered. */
  | { kind: 'answer'; text: string }
  /** pi recorded the prompt but no assistant message at all. */
  | { kind: 'missing' };

interface PiRecordedMessage {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

/**
 * pi phrases a provider refusal as `<status>: <body>` where the body is often
 * the provider's JSON. Keep the status and the human message, drop the rest.
 */
export function summarizeProviderError(errorMessage: string): { reason: string; status?: number } {
  const trimmed = errorMessage.trim();
  const statusMatch = /^(\d{3}):\s*([\s\S]*)$/.exec(trimmed);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  let body = statusMatch ? statusMatch[2]!.trim() : trimmed;
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body) as {
        message?: unknown;
        error?: { message?: unknown } | string;
      };
      const message =
        typeof parsed.message === 'string'
          ? parsed.message
          : typeof parsed.error === 'string'
            ? parsed.error
            : typeof parsed.error?.message === 'string'
              ? parsed.error.message
              : undefined;
      if (message) body = message;
    } catch {
      /* not JSON; keep the text */
    }
  }
  const firstLine = body.split(/\r?\n/).find((line) => line.trim()) ?? '';
  const reason = `provider error${status === undefined ? '' : ` ${status}`}${
    firstLine ? `: ${firstLine.trim()}` : ''
  }`;
  return status === undefined ? { reason } : { reason, status };
}

async function sessionFileFromMap(home: string, sessionId: string): Promise<string | undefined> {
  try {
    const raw = await readFile(resolve(home, '.pi', 'pi-acp', 'session-map.json'), 'utf8');
    const map = JSON.parse(raw) as { sessions?: Record<string, { sessionFile?: unknown }> };
    const file = map.sessions?.[sessionId]?.sessionFile;
    return typeof file === 'string' && file ? file : undefined;
  } catch {
    return undefined;
  }
}

async function sessionFileFromLayout(
  piDir: string,
  sessionId: string,
): Promise<string | undefined> {
  const sessionsRoot = resolve(piDir, 'sessions');
  const suffix = `_${sessionId}.jsonl`;
  let projects: string[];
  try {
    projects = await readdir(sessionsRoot);
  } catch {
    return undefined;
  }
  for (const project of projects) {
    const dir = resolve(sessionsRoot, project);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    const match = files.find((file) => file.endsWith(suffix));
    if (match) return resolve(dir, match);
  }
  return undefined;
}

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join('')
    .trim();
}

/**
 * The record of the latest turn in a pi session, or undefined when this env
 * has no pi home or pi left no readable session file.
 */
export async function readPiTurnRecord(input: {
  agentEnv: Record<string, string>;
  sessionId: string;
}): Promise<PiTurnRecord | undefined> {
  const piDir = input.agentEnv.PI_CODING_AGENT_DIR;
  if (!piDir || !input.sessionId) return undefined;
  const file =
    (input.agentEnv.HOME
      ? await sessionFileFromMap(input.agentEnv.HOME, input.sessionId)
      : undefined) ?? (await sessionFileFromLayout(piDir, input.sessionId));
  if (!file) return undefined;
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  let sawUser = false;
  let last: PiRecordedMessage | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; message?: PiRecordedMessage };
    try {
      entry = JSON.parse(line) as { type?: unknown; message?: PiRecordedMessage };
    } catch {
      continue;
    }
    if (entry.type !== 'message' || !entry.message) continue;
    if (entry.message.role === 'user') {
      sawUser = true;
      last = undefined;
    } else if (entry.message.role === 'assistant') {
      last = entry.message;
    }
  }
  if (!sawUser && !last) return undefined;
  if (!last) return { kind: 'missing' };
  if (last.stopReason === 'error') {
    return {
      kind: 'error',
      ...summarizeProviderError(
        typeof last.errorMessage === 'string' && last.errorMessage.trim()
          ? last.errorMessage
          : 'unknown error',
      ),
    };
  }
  const text = messageText(last.content);
  if (text) return { kind: 'answer', text };
  return {
    kind: 'empty',
    stopReason: typeof last.stopReason === 'string' ? last.stopReason : 'unknown',
  };
}
