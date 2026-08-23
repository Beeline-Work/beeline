import type { AgentActivityItem } from '@/sync/transport/rig-transport';

export type ActivityTimelineEntry =
  | {
      kind: 'reasoning';
      title: string;
      detail: string;
      count: number;
    }
  | {
      kind: 'action';
      title: string;
      detail?: string;
      count: number;
    };

/**
 * How a single tool call reaches the reader.
 *
 * The dividing line is "did this change or observe state," not "was it
 * expensive": a call that executes or mutates is the payload of the turn and
 * keeps its own line, while a read/search/list is a receipt and folds into the
 * turn's one counted note. A failure always keeps its line, whatever it was
 * doing — after the accent is spent on live state, persistence is the only
 * escalation the ledger has left.
 */
export type ActionWeight = 'mutation' | 'command' | 'failure' | 'observation';

export type TurnActivityFile = {
  path: string;
  status?: string;
  diff?: string;
};

export type TurnActivityAction = {
  id: string;
  kind: 'tool';
  weight: ActionWeight;
  title: string;
  status?: string;
  /**
   * One plain-language line projected from the tool result saying WHY this
   * failed — `command exited 1: vitest: not found`, never a bare FAILED.
   * Set only for failures; rendered in the row, one line, dim.
   */
  reason?: string;
  path?: string;
  command?: string;
  input?: string;
  output?: string;
  files?: TurnActivityFile[];
};

export type TurnActivity = {
  /**
   * The agent's own prose, lifted clear of the telemetry it was buried in.
   * This is what the reader is here for, so it renders at the ledger's
   * brightest tier, full width, and is never collapsed behind a disclosure.
   */
  narration: string[];
  /** Calls that executed or mutated, plus every failure: one line each. */
  actions: TurnActivityAction[];
  /** Read-only calls, folded behind the counted note. */
  observations: TurnActivityAction[];
  /** The counted note's copy, e.g. `12 TOOL CALLS · read 8, searched 3`. */
  note?: string;
  /**
   * The same note in the present tense — `12 TOOL CALLS · reading 8,
   * searching 3` — shown while the turn is still running.
   *
   * grok Build writes its rollup twice: `Reading 2 files, Searching 4 patterns`
   * while the group is in flight, then `Read 2 files, Searched 4 patterns` when
   * it settles, roughly 100ms later and in place. The tense *is* the state
   * report, which is why the row can carry it without a badge, a spinner, or a
   * second line — and why a reader who glances once knows whether they are
   * watching work or reading a record of it.
   */
  liveNote?: string;
  /** How many calls that note stands for, including wire-only tallies. */
  noteCount: number;
  /**
   * Total reasoning time this turn, from body's receipt. Rendered as the quiet
   * half of grok's loud-then-quiet reasoning: the thinking itself never
   * reaches the client, but `THOUGHT FOR 5.8S` does.
   */
  thoughtMs?: number;
  plan?: NonNullable<AgentActivityItem['plan']>;
};

const MAX_ACTION_TITLE = 72;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clamp(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function phaseTitle(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const markdownBold = text.match(/^\s*\*\*([^*\n]+)\*\*/)?.[1];
  const markdownHeading = text.match(/^\s*#{1,6}\s+([^\n]+)/)?.[1];
  const candidate = oneLine(markdownBold ?? markdownHeading ?? '');
  return candidate ? clamp(candidate.replace(/[.:]+$/, ''), MAX_ACTION_TITLE) : undefined;
}

function cleanTitle(value: string): string {
  return oneLine(value)
    .replace(/^#+\s*/, '')
    .replace(/^\*\*|\*\*$/g, '');
}

function redactPaths(value: string): string {
  return value.replace(/(?:file:\/\/)?(?:\/[\w.@~+%=,:-]+)+/g, (path) => {
    const parts = path
      .replace(/^file:\/\//, '')
      .split('/')
      .filter(Boolean);
    return parts.at(-1) ?? path;
  });
}

function firstFileName(value: string): string | undefined {
  const match = redactPaths(value).match(
    /\b[\w.-]+\.(?:[cm]?[jt]sx?|json|md|ya?ml|css|html|py|go|rs|java)\b/i,
  );
  return match?.[0];
}

function fileCount(value: string): number | undefined {
  const explicit = value.match(/\b(\d+)\s+files?\b/i);
  if (explicit) return Number(explicit[1]);
  const files = redactPaths(value).match(
    /\b[\w.-]+\.(?:[cm]?[jt]sx?|json|md|ya?ml|css|html|py|go|rs|java)\b/gi,
  );
  return files && files.length > 1 ? new Set(files).size : undefined;
}

function searchTerms(value: string): string | undefined {
  const quoted = value.match(/["'`]([^"'`]+)["'`]/)?.[1];
  if (quoted) return redactPaths(quoted);
  const named = value.match(
    /(?:search(?:ed)?(?:\s+(?:for|code))?|grep|rg|find)\s+(?:-\S+\s+)*([^\s].*?)(?:\s+(?:in|at)\s+\S+)?$/i,
  )?.[1];
  return named ? clamp(redactPaths(named).replace(/\s+\S+\.[\w-]+$/i, ''), 44) : undefined;
}

function isFailure(item: AgentActivityItem): boolean {
  return (
    /(?:failed|error|unavailable|denied)/i.test(item.status ?? '') ||
    /(?:failed|error|unavailable|not available|cannot|can't)/i.test(item.text ?? '')
  );
}

/**
 * One plain-language line saying WHY an action failed, projected from the
 * tool's own result — never a bare "Action failed".
 *
 * Body ships the raw output on the same wire record as the status; this folds
 * the recurring shapes in the live failure corpus (2026-08-23) into one
 * readable clause each and falls back to the first error-looking line.
 */
export function failureReason(item: AgentActivityItem): string | undefined {
  const raw = item.output ?? item.text;
  if (!raw) return undefined;
  // Body usually JSON-stringifies the tool result envelope.
  let text = raw;
  let exitCode: number | undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.formatted_output === 'string') text = parsed.formatted_output;
      if (typeof parsed.exit_code === 'number') exitCode = parsed.exit_code;
      if (typeof parsed.stderr === 'string' && parsed.stderr.trim()) text = parsed.stderr;
    }
  } catch {
    // Plain-text output stays as-is.
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const all = lines.join(' \u2014 ');

  const notFound = text.match(/(?:sh:\s*)?\d*:?\s*([\w@./-]+):\s*not found/i);
  if (notFound) return `command not found: ${notFound[1]}`;
  if (/Read-only file system|EROFS/i.test(all)) {
    return 'blocked: that path is read-only outside this corner\u2019s work area';
  }
  const missingModule = text.match(/Cannot find (?:package|module) ['"]([^'"]+)['"]/);
  if (missingModule) return `missing dependency: ${missingModule[1]}`;
  const noSuchFile = text.match(/(?:ENOENT|No such file or directory).*?[\s'"](\/?[\w.@/-]+)['"]?/);
  if (noSuchFile && noSuchFile[1] !== 'sh') {
    return `file does not exist: ${clamp(redactPaths(noSuchFile[1]), 60)}`;
  }
  const lock = text.match(/Unable to create '([^']+index\.lock)'/);
  if (lock) return `git could not write its index (${redactPaths(lock[1])})`;
  const refused = text.match(/fatal:\s*(.+)/i);
  if (refused) return clamp(oneLine(refused[1]), 90);
  const errorLine = lines.find((line) => /(?:^|\b)(?:error|ERR!|ERROR|Traceback|FATAL|exception)\b/i.test(line));
  const detail = errorLine ?? (exitCode !== undefined || /exit_code/.test(raw) ? lines.at(-1) : undefined);
  if (!detail) return undefined;
  const prefix = exitCode !== undefined ? `command exited ${exitCode}: ` : '';
  return clamp(prefix + oneLine(detail), 110);
}

function failureTitle(item: AgentActivityItem): string {
  const source = `${item.title} ${item.text ?? ''}`.toLowerCase();
  if (source.includes('search') || source.includes('grep') || source.includes('rg ')) {
    return source.includes('unavailable') || source.includes('not available')
      ? 'Code search unavailable'
      : 'Code search failed';
  }
  if (source.includes('read') || source.includes('file')) return 'Could not read file';
  if (source.includes('git') || source.includes('bash') || source.includes('shell')) {
    return 'Project task failed';
  }
  return 'Action failed';
}

function actionTitle(item: AgentActivityItem): string | undefined {
  const title = cleanTitle(item.title);
  const text = item.text ?? '';
  const source = `${title}\n${text}`;
  const normalized = title.toLowerCase();
  if (isFailure(item)) return failureTitle(item);
  if (/^(?:result|action|output)$/i.test(title) && !text.trim()) return undefined;
  if (/^tool$/i.test(title)) return text.trim() ? 'Completed an action' : undefined;
  if (/\b(read|open|cat)\b/i.test(source)) {
    const count = fileCount(source);
    if (count && count > 1) return `Reviewed ${count} files`;
    const file = firstFileName(source);
    return file ? `Reviewed ${file}` : 'Reviewed a file';
  }
  if (/\b(search|grep|\brg\b|find)\b/i.test(source)) {
    const terms = searchTerms(title) ?? searchTerms(text);
    return terms ? `Searched the code for ${terms}` : 'Searched the code';
  }
  if (/\bgit\s+(?:status|diff|log|show)\b/i.test(source)) return 'Reviewed the current changes';
  if (/\bgit\s+(?:branch|add|commit|checkout)\b/i.test(source)) return 'Prepared the change';
  if (/\b(?:npm|pnpm|yarn|bun|node|npx|python|cargo|make|gradle|docker|kubectl|curl|wget|chmod|rm|cp|mv)\b/i.test(source)) {
    return 'Completed a project task';
  }
  if (/\b(bash|shell|execute|run)\b/i.test(source)) return 'Completed a project task';
  if (/\b(edit|write|replace|patch|create)\b/i.test(source)) {
    const file = firstFileName(source);
    return file ? `Updated ${file}` : 'Updated a file';
  }
  if (normalized === 'output' || item.kind === 'output') return 'Agent update';
  return clamp(redactPaths(title || 'Completed an action'), MAX_ACTION_TITLE);
}

function appendDistinctDetail(
  current: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!next) return current;
  if (!current) return next;
  if (current === next || current.endsWith(next)) return current;
  return `${current}\n${next}`;
}

/**
 * Turns ACP telemetry into the deliberately sparse rows used by the corner UI.
 * Adjacent updates coalesce in place, so tool/reasoning order remains visible.
 * An identical action title recurring later in the same turn (e.g. the agent
 * re-reads the same file after an edit) folds into its first row instead of
 * printing a new one, so a long turn still reads like a summary, not a log.
 */
export function buildActivityTimeline(
  items: readonly AgentActivityItem[],
): ActivityTimelineEntry[] {
  const entries: ActivityTimelineEntry[] = [];
  const actionsByTitle = new Map<string, Extract<ActivityTimelineEntry, { kind: 'action' }>>();

  for (const item of items) {
    if (item.kind === 'thinking') {
      const previous = entries.at(-1);
      if (previous?.kind === 'reasoning') {
        previous.count += 1;
        previous.detail = appendDistinctDetail(previous.detail, item.text) ?? previous.detail;
        previous.title = phaseTitle(item.text) ?? previous.title;
      } else {
        entries.push({
          kind: 'reasoning',
          title: phaseTitle(item.text) ?? 'reasoning',
          detail: item.text ?? '',
          count: 1,
        });
      }
      continue;
    }

    const title = actionTitle(item);
    if (!title) continue;
    const isFileReview = /^Reviewed (?!the current changes)/.test(title);
    const dedupeKey = isFileReview ? 'Reviewed' : title.toLowerCase();
    const existing = actionsByTitle.get(dedupeKey);
    if (existing) {
      existing.count += 1;
      if (isFileReview) existing.title = `Reviewed ${existing.count} files`;
      continue;
    }

    const entry: Extract<ActivityTimelineEntry, { kind: 'action' }> = {
      kind: 'action',
      title,
      count: 1,
    };
    entries.push(entry);
    actionsByTitle.set(dedupeKey, entry);
  }

  return entries;
}

function mergeToolActivity(
  current: AgentActivityItem | undefined,
  next: AgentActivityItem,
): AgentActivityItem {
  if (!current) return { ...next, files: next.files ? [...next.files] : undefined };
  const files = new Map((current.files ?? []).map((file) => [file.path, file]));
  for (const file of next.files ?? []) {
    files.set(file.path, { ...files.get(file.path), ...file });
  }
  return {
    ...current,
    ...next,
    ...(files.size ? { files: [...files.values()] } : {}),
    ...(next.output || current.output ? { output: next.output ?? current.output } : {}),
    ...(next.text || current.text ? { text: next.text ?? current.text } : {}),
  };
}

/**
 * The verb an observational call is counted under in the turn's note.
 *
 * A bare total ("12 calls") answers *how much*; the verb breakdown answers
 * *what kind* in the same width, which is the difference between a number and
 * a shape of work.
 */
function observationVerb(item: AgentActivityItem, title: string): string {
  const kind = item.toolKind?.toLowerCase();
  if (kind === 'read') return 'read';
  if (kind === 'search') return 'searched';
  if (kind === 'fetch') return 'fetched';
  const source = `${title} ${item.title} ${item.command ?? ''}`.toLowerCase();
  if (/\b(search|grep|\brg\b|find)\b/.test(source)) return 'searched';
  if (/\b(list|ls|glob)\b/.test(source)) return 'listed';
  if (/\b(read|open|cat|review)\b/.test(source)) return 'read';
  return 'inspected';
}

/** Verb -> the label a folded call's synthesized review-sheet row leads with. */
const OBSERVED_VERB_LABEL: Readonly<Record<string, string>> = {
  read: 'Read',
  searched: 'Searched for',
  fetched: 'Fetched',
  listed: 'Listed',
  inspected: 'Inspected',
  reasoned: 'Reasoned about',
  ran: 'Ran',
};

/** `Read src/foo.ts`, `Searched for handleSubmit`, `Ran npm test` — body ships the
 *  bare verb/target; the readable phrase is built here, same as every other
 *  action title in this file. */
function observedCallTitle(verb: string, target?: string): string {
  const label = OBSERVED_VERB_LABEL[verb] ?? 'Ran';
  return target ? `${label} ${clamp(target, MAX_ACTION_TITLE)}` : label;
}

/**
 * Did this call change state, or only look at it?
 *
 * Mutation and execution are the payload of a turn and keep their own line;
 * everything observational folds into the counted note. A failure is pulled out
 * of that fold unconditionally — a failed read still outranks a successful one.
 */
function actionWeight(item: AgentActivityItem): ActionWeight {
  if (isFailure(item)) return 'failure';
  if (item.files?.length) return 'mutation';
  const kind = item.toolKind?.toLowerCase();
  if (kind) {
    if (kind === 'edit' || kind === 'delete' || kind === 'move' || kind === 'write') {
      return 'mutation';
    }
    if (kind === 'execute') return 'command';
    if (kind === 'read' || kind === 'search' || kind === 'fetch' || kind === 'think') {
      return 'observation';
    }
  }
  if (item.command) return 'command';
  // No declared kind (an older body, or a harness that omits it): fall back to
  // what the label says it did. Inspection verbs stay observational; anything
  // that names a write is treated as the payload.
  const source = `${cleanTitle(item.title)} ${item.command ?? ''}`;
  if (/\b(edit|write|replace|patch|create|delete|remove|move|rename)\b/i.test(source)) {
    return 'mutation';
  }
  if (/\b(read|open|cat|search|grep|\brg\b|find|list|ls|glob|fetch|think)\b/i.test(source)) {
    return 'observation';
  }
  return 'observation';
}

/**
 * `12 TOOL CALLS · read 8, searched 3, listed 1`.
 *
 * One note per turn, never one collapsed line per call and never a wall. The
 * bare total leads because it reads instantly; the verb breakdown follows
 * because it is what tells the reader whether the turn was research or work.
 */
function noteText(total: number, verbs: ReadonlyMap<string, number>): string {
  const head = `${total} TOOL ${total === 1 ? 'CALL' : 'CALLS'}`;
  const breakdown = [...verbs.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([verb, count]) => `${verb} ${count}`)
    .join(', ');
  return breakdown ? `${head} · ${breakdown}` : head;
}

/**
 * Past tense -> present participle, for the in-flight form of the note above.
 *
 * A closed map rather than a suffix rule: the vocabulary is small, fixed, and
 * produced in exactly two places (`observationVerb` here and
 * `observationalVerb` in `apps/body/src/activity.ts`), and a stemming rule that
 * turned an unforeseen verb into a non-word would be a worse failure than
 * simply leaving it in the past tense.
 */
const PRESENT_PARTICIPLE: Readonly<Record<string, string>> = {
  read: 'reading',
  searched: 'searching',
  listed: 'listing',
  fetched: 'fetching',
  inspected: 'inspecting',
  queried: 'querying',
  reasoned: 'reasoning',
  ran: 'running',
};

/** `12 TOOL CALLS · reading 8, searching 3` — the note while it is still true. */
function liveNoteText(total: number, verbs: ReadonlyMap<string, number>): string {
  const head = `${total} TOOL ${total === 1 ? 'CALL' : 'CALLS'}`;
  const breakdown = [...verbs.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([verb, count]) => `${PRESENT_PARTICIPLE[verb] ?? verb} ${count}`)
    .join(', ');
  return breakdown ? `${head} · ${breakdown}` : head;
}

/**
 * The corner's reading model: narration first, tools as footnotes.
 *
 * Three groups come out of one pass, and which group a thing lands in is the
 * whole design:
 *
 *   narration     the agent's own prose — primary tier, never collapsed
 *   actions       calls that executed, mutated, or failed — one line each
 *   observations  reads/searches/lists — folded behind one counted note
 *
 * The synthetic `activity_summary` receipt body publishes is deliberately *not*
 * narration: its text restates mechanism the note already states. Its `rollup`
 * is the only record of the observational calls body counts but never projects
 * as their own events, and its `observed` array — a compact target + short
 * result per folded call, capped independently of the tally — is the only
 * source for those calls' own review-sheet rows, since the calls themselves
 * never reach the wire.
 */
export function buildTurnActivity(items: readonly AgentActivityItem[]): TurnActivity {
  const narration: string[] = [];
  const tools = new Map<string, AgentActivityItem>();
  const wireRollup = new Map<string, number>();
  // Body cannot ship the folded calls themselves — that's the noise-control
  // fold, and it stays — but it ships a compact receipt (target + a taste of
  // the result) per call on the summary event. These become real review-sheet
  // rows so the sheet has something to show beyond the bare tally.
  const observations: TurnActivityAction[] = [];
  let plan: AgentActivityItem['plan'];
  let thoughtMs = 0;
  let anonymousIndex = 0;
  let observedIndex = 0;

  for (const item of items) {
    if (item.plan) plan = item.plan;
    if (item.kind === 'summary') {
      for (const [verb, count] of Object.entries(item.rollup ?? {})) {
        wireRollup.set(verb, (wireRollup.get(verb) ?? 0) + count);
      }
      if (item.thoughtMs && item.thoughtMs > 0) thoughtMs += item.thoughtMs;
      for (const call of item.observed ?? []) {
        observations.push({
          id: `observed-${observedIndex++}`,
          kind: 'tool',
          weight: 'observation',
          title: observedCallTitle(call.verb, call.target),
          ...(call.result ? { output: call.result } : {}),
        });
      }
      continue;
    }
    if (item.kind === 'output') {
      const prose = item.text?.trim();
      if (prose && narration.at(-1) !== prose) narration.push(prose);
      continue;
    }
    if (item.kind !== 'tool') continue;
    const key = item.id ?? `anonymous-${anonymousIndex++}`;
    tools.set(key, mergeToolActivity(tools.get(key), item));
  }

  const actions: TurnActivityAction[] = [];
  const localVerbs = new Map<string, number>();

  for (const [id, tool] of tools) {
    const weight = actionWeight(tool);
    const title = actionTitle(tool) ?? cleanTitle(tool.title) ?? 'Tool';
    const reason = weight === 'failure' ? failureReason(tool) : undefined;
    // Keep the tool call as the transcript row and its files as the next level
    // of the drill-down: tool -> file list -> patch. Flattening files onto the
    // slab made a multi-file edit indistinguishable from several unrelated
    // calls and left no way to understand which command produced which diff.
    if (tool.files?.length) {
      actions.push({
        id,
        kind: 'tool',
        weight,
        title,
        ...(reason ? { reason } : {}),
        ...(tool.status ? { status: tool.status } : {}),
        ...(tool.command ? { command: tool.command } : {}),
        ...(tool.input ? { input: tool.input } : {}),
        ...((tool.output ?? tool.text) ? { output: tool.output ?? tool.text } : {}),
        files: tool.files.map((file) => ({ ...file })),
      });
      continue;
    }

    const row: TurnActivityAction = {
      id,
      kind: 'tool',
      weight,
      title,
      ...(reason ? { reason } : {}),
      ...(tool.status ? { status: tool.status } : {}),
      ...(tool.command ? { command: tool.command } : {}),
      ...(tool.input ? { input: tool.input } : {}),
      ...((tool.output ?? tool.text) ? { output: tool.output ?? tool.text } : {}),
    };
    if (weight === 'observation') {
      observations.push(row);
      const verb = observationVerb(tool, title);
      localVerbs.set(verb, (localVerbs.get(verb) ?? 0) + 1);
    } else {
      actions.push(row);
    }
  }

  // The note stands for both what arrived as its own (filtered-out) event and
  // what only ever arrived as a wire tally, so the verbs merge before counting.
  const verbs = new Map(localVerbs);
  for (const [verb, count] of wireRollup) verbs.set(verb, (verbs.get(verb) ?? 0) + count);
  const total = [...verbs.values()].reduce((sum, count) => sum + count, 0);

  return {
    narration,
    actions,
    observations,
    ...(total ? { note: noteText(total, verbs), liveNote: liveNoteText(total, verbs) } : {}),
    noteCount: total,
    ...(thoughtMs > 0 ? { thoughtMs } : {}),
    ...(plan ? { plan } : {}),
  };
}

/**
 * The corner's current plan, for the pinned checklist above the transcript.
 *
 * A plan update replaces the whole checklist, never patches it, so the latest
 * one across every message's activity — in chronological order — is simply
 * the most recent plan the agent has published. Takes duck-typed messages
 * (not `ChatDisplayMessage`) so this stays a pure function over activity data
 * with no dependency on the projection layer's message shape.
 */
export function latestCornerPlan(
  messages: readonly { activity?: readonly AgentActivityItem[] }[],
): AgentActivityItem['plan'] | undefined {
  let plan: AgentActivityItem['plan'];
  for (const message of messages) {
    for (const item of message.activity ?? []) {
      if (item.plan) plan = item.plan;
    }
  }
  return plan;
}
