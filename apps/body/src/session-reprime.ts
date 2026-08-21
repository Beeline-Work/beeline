/**
 * How much of a channel's history a re-primed ACP session is told.
 *
 * When a logical session is (re)activated — a daemon restart, an idle
 * suspend/reactivate from `SessionScheduler`, a watchdog Room recycle — the
 * host restores continuity by putting the durable transcript into the new
 * session's SYSTEM PROMPT. That is the right idea and the wrong size: it
 * replayed the whole thing, and a system prompt is re-sent by the harness on
 * every request, so the cost is paid per TURN, not per restart.
 *
 * Measured on the captain's Room (`1f6e289d`, `body-state.json` 5.47 MB):
 *
 *     conversation entries : 200   (the durable cap)
 *     characters           : 114,630
 *     ≈ input tokens       : ~28,700   — on every turn of every restored session
 *
 * Their claude daemon restarted 14 times in a day. None of that is visible in
 * the transcript, in a tool call, or in any log line: it is pure prompt weight.
 *
 * The fix is not to drop continuity but to bound it. A restored session needs
 * enough recent conversation to keep answering the thread it was in the middle
 * of; it does not need every message the Room has ever held — the agent can
 * read the Room's own history through its tools if it needs more, and the
 * durable record is not lost either way.
 */

/** One durable conversation entry, as `DurableBodyState` stores it. */
export interface RepriseEntry {
  role: string;
  text: string;
}
export interface ResumePlanItem { step: string; status: 'pending' | 'in_progress' | 'completed'; }
export interface CornerResumeContext { objective?: string; plan?: { objective?: string; items: readonly ResumePlanItem[] }; changedFiles?: readonly string[]; commits?: readonly string[]; }

/**
 * Character budget for the restored transcript.
 *
 * ~8k characters is roughly 2k tokens: enough for the last several exchanges,
 * about 7% of what the captain's Room was replaying. Chosen as a budget rather
 * than an entry count because entry sizes vary by two orders of magnitude — a
 * "yes" and a 20KB agent summary both count as one entry, and it is the
 * characters that are billed.
 */
export const SESSION_REPRIME_MAX_CHARS = 8_000;

/** No single entry may eat the whole budget. */
export const SESSION_REPRIME_MAX_ENTRY_CHARS = 1_200;
export const CORNER_RESUME_MAX_TURNS = 6;

/** What the agent is told when older history was left out. */
export const SESSION_REPRIME_ELIDED_NOTE =
  '[older messages omitted — read the Room history with your tools if you need them]';

function clampEntry(entry: RepriseEntry): string {
  const text = entry.text.trim();
  const body =
    text.length > SESSION_REPRIME_MAX_ENTRY_CHARS
      ? `${text.slice(0, SESSION_REPRIME_MAX_ENTRY_CHARS)}…`
      : text;
  return `[${entry.role}] ${body}`;
}

/**
 * The transcript lines a re-primed session is given: the most RECENT entries
 * that fit the budget, oldest-first, with an honest note when anything was
 * left out.
 *
 * Newest-first selection is the whole point — a session resumes the thread it
 * was in, so the tail is what carries the continuity. Truncating from the
 * front would restore the beginning of a conversation nobody is having any
 * more.
 */
export function repriseTranscriptLines(
  entries: readonly RepriseEntry[],
  maxChars: number = SESSION_REPRIME_MAX_CHARS,
): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (!entry.text.trim()) continue;
    const line = clampEntry(entry);
    if (used + line.length > maxChars) {
      // Everything from here back is older than what we kept.
      kept.unshift(SESSION_REPRIME_ELIDED_NOTE);
      break;
    }
    used += line.length;
    kept.unshift(line);
  }
  return kept;
}

/**
 * The restored-conversation block for a new session's system prompt, or `''`
 * when there is nothing to restore.
 */
export function repriseSystemPromptBlock(
  entries: readonly RepriseEntry[],
  maxChars: number = SESSION_REPRIME_MAX_CHARS,
): string {
  const lines = repriseTranscriptLines(entries, maxChars);
  if (lines.length === 0) return '';
  return [
    '',
    'This logical channel session was suspended while idle. Restore its single',
    'continuous conversation from this ordered transcript; do not treat it as a new task:',
    ...lines,
  ].join('\n');
}

function boundedLines(lines: readonly string[], fallback: string, count: number, chars: number): string[] {
  const clean = lines.map((line) => line.trim()).filter(Boolean);
  return clean.length ? clean.slice(0, count).map((line) => `- ${line.slice(0, chars)}`) : [`- ${fallback}`];
}

export function cornerResumeSystemPromptBlock(entries: readonly RepriseEntry[], context: CornerResumeContext, maxChars: number = SESSION_REPRIME_MAX_CHARS): string {
  const objective = context.objective?.trim() || context.plan?.objective?.trim() || 'Not recorded';
  const plan = context.plan?.items.length ? context.plan.items.slice(0, 8).map((item) => `- [${item.status}] ${item.step.slice(0, 180)}`) : ['- No plan was recorded; reconstruct the next step from the repository state.'];
  const fixed = ['', 'CORNER RESUME BRIEF', 'Resume this same durable corner. Do not restart the task or repeat settled exploration.', '', 'Objective:', objective.slice(0, 480), '', 'Current plan:', ...plan, '', 'Files changed so far:', ...boundedLines(context.changedFiles ?? [], 'No changed files detected.', 12, 180), '', 'Commits on this branch:', ...boundedLines(context.commits ?? [], 'No branch commits detected.', 8, 220), '', 'Last conversation turns:'];
  const remaining = Math.max(0, maxChars - fixed.join('\n').length - 1);
  const turns = repriseTranscriptLines(entries.slice(-CORNER_RESUME_MAX_TURNS), remaining);
  const block = [...fixed, ...(turns.length ? turns : ['- No conversation turns recorded.'])].join('\n');
  return block.length <= maxChars ? block : `${block.slice(0, Math.max(0, maxChars - 1))}…`;
}

export interface SessionReprimeSize {
  entries: number;
  beforeChars: number;
  afterChars: number;
  beforeTokens: number;
  afterTokens: number;
  block: string;
}

/** Measured old-vs-capped replay size for one physical session activation. */
export function measureSessionReprime(
  entries: readonly RepriseEntry[],
  maxChars: number = SESSION_REPRIME_MAX_CHARS,
  cornerResume?: CornerResumeContext,
): SessionReprimeSize {
  const header = [
    '',
    'This logical channel session was suspended while idle. Restore its single',
    'continuous conversation from this ordered transcript; do not treat it as a new task:',
  ];
  const before = entries.length
    ? [...header, ...entries.map((entry) => `[${entry.role}] ${entry.text}`)].join('\n')
    : '';
  const block = cornerResume ? cornerResumeSystemPromptBlock(entries, cornerResume, maxChars) : repriseSystemPromptBlock(entries, maxChars);
  return {
    entries: entries.length,
    beforeChars: before.length,
    afterChars: block.length,
    beforeTokens: Math.ceil(before.length / 4),
    afterTokens: Math.ceil(block.length / 4),
    block,
  };
}
