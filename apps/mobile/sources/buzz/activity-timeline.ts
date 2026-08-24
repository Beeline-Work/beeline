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
  kind: 'tool' | 'thought';
  weight: ActionWeight;
  title: string;
  /** The transcript's compact verb-object copy. Always <= 40 characters. */
  label: string;
  /** Settled state projected from the existing activity status. */
  outcome: 'running' | 'success' | 'failure';
  /** Existing receipts expose this for thoughts; tools omit it when unknown. */
  durationMs?: number;
  toolKind?: string;
  status?: string;
  /**
   * One plain-language line projected from the tool result saying WHY this
   * failed — `exit 1: vitest: not found`, never a bare generic status.
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
  /** Ordered machine ledger. It is the rendering authority for transcript rows. */
  steps: TurnActivityAction[];
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
export const MAX_LEDGER_LABEL = 40;

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
  const status = item.status ?? '';
  if (/\b(?:failed|error|unavailable|denied)\b/i.test(status)) return true;
  // A settled status is the event's authority. Successful output frequently
  // contains phrases such as "0 errors" and must not be reclassified by copy.
  if (/\b(?:completed|complete|success|succeeded|passed|done)\b/i.test(status)) return false;
  return /\b(?:failed|error|unavailable|not available|cannot|can't)\b/i.test(item.text ?? '');
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
  const statusCode = Number(item.status?.match(/(?:exit|code)\s*(\d+)/i)?.[1]);
  if (!raw) return Number.isFinite(statusCode) ? `exit ${statusCode}` : undefined;
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
  text = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\s*at\s+\S+\s*\(/.test(line))
    .filter((line) => !/^node:internal\//.test(line))
    .filter((line) => !/(?:ELIFECYCLE|ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL)/i.test(line))
    .filter((line) => !/^npm (?:ERR!|error) (?:code|command|lifecycle|path|cwd)\b/i.test(line))
    .filter((line) => !/^Command failed with exit code \d+\.?$/i.test(line));
  const all = lines.join(' \u2014 ');

  const notFound =
    text.match(/(?:sh:\s*)?\d*:?\s*([\w@./-]+):\s*not found/i) ??
    text.match(/(?:^|\n)\s*([\w@./-]+):\s*command not found\b/i);
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
  const errorLine = lines.find((line) =>
    /(?:^|\b)(?:error(?:\s+TS\d+)?|ERR!|Traceback|FATAL|exception|cannot|failed:)\b/i.test(line),
  );
  const detail = errorLine ?? lines.find((line) => !/^>\s/.test(line));
  const code = exitCode ?? (Number.isFinite(statusCode) ? statusCode : undefined);
  if (!detail) return code !== undefined ? `exit ${code}` : undefined;
  const clean = oneLine(detail).replace(/^(?:npm|pnpm)\s+(?:ERR!|error)\s*/i, '');
  return clamp(code !== undefined ? `exit ${code}: ${clean}` : clean, 110);
}

function activityOutcome(item: AgentActivityItem): TurnActivityAction['outcome'] {
  if (isFailure(item)) return 'failure';
  if (/(?:in[_ -]?progress|running|pending|started|working)/i.test(item.status ?? '')) {
    return 'running';
  }
  return 'success';
}

function commandLabel(command: string): string | undefined {
  const clean = oneLine(command)
    .replace(/^(?:env\s+\S+=\S+\s+)*/, '')
    .replace(/^(?:bash|sh|zsh)\s+-[lc]+\s+['"]?/, '')
    .replace(/["']$/, '');
  if (/\b(?:typecheck|tsc\b)/i.test(clean)) return 'type checks';
  if (
    /\b(?:vitest|jest|mocha|playwright|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test)\b/i.test(
      clean,
    )
  )
    return 'tests';
  if (/\b(?:eslint|npm\s+(?:run\s+)?lint|pnpm\s+(?:run\s+)?lint)\b/i.test(clean)) return 'lint';
  if (/\b(?:gradle|npm|pnpm|yarn|bun)\b.*\bbuild\b/i.test(clean)) return 'build';
  if (/\bgit\s+(?:status|diff|log|show)\b/i.test(clean)) return 'review changes';
  if (/\bgit\s+commit\b/i.test(clean)) return 'commit changes';
  const executable = clean.match(/(?:^|&&\s*|;\s*)([\w@./-]+)(?:\s+([^;&|]+))?/);
  if (!executable) return undefined;
  const name = executable[1].split('/').at(-1) ?? executable[1];
  const firstArg = executable[2]?.trim().split(/\s+/)[0];
  return firstArg && !firstArg.startsWith('-') ? `${name} ${firstArg}` : name;
}

/** Concise historical-safe verb-object label derived only from existing fields. */
export function ledgerStepLabel(item: AgentActivityItem): string {
  const kind = item.toolKind?.toLowerCase();
  const source = `${item.title} ${item.command ?? ''} ${item.input ?? ''}`;
  const file = item.files?.[0]?.path.split('/').filter(Boolean).at(-1) ?? firstFileName(source);
  const genericTitle = /^(?:tool|execute|command|shell|bash|result|output|action)$/i.test(
    cleanTitle(item.title),
  );
  let label: string | undefined;
  if (kind === 'read' || /^(?:read|open|cat)\b/i.test(item.title)) {
    label = file ? `read ${file}` : 'read files';
  } else if (kind === 'search' || /\b(?:search|grep|\brg\b|find)\b/i.test(item.title)) {
    const terms = searchTerms(item.command ?? item.input ?? item.title);
    label = terms ? `search ${terms}` : 'search code';
  } else if (kind === 'fetch') {
    label = 'fetch web';
  } else if (['edit', 'write', 'move', 'delete'].includes(kind ?? '')) {
    const verb = kind === 'write' ? 'write' : kind;
    label = file ? `${verb} ${file}` : `${verb} files`;
  }
  const commandDerived = item.command ? commandLabel(item.command) : undefined;
  if (
    !label &&
    commandDerived &&
    /^(?:type checks|tests|lint|build|review changes|commit changes)$/.test(commandDerived)
  ) {
    label = commandDerived;
  }
  if (!label && !genericTitle) {
    label = cleanTitle(item.title)
      .replace(/^(?:ran|run|running|completed|reviewed|updated|prepared|committed)\s+/i, '')
      .replace(/[-_]+/g, ' ')
      .toLowerCase();
  }
  if (!label) label = commandDerived;
  return clamp(redactPaths(label || 'tool step'), MAX_LEDGER_LABEL);
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
  if (
    /\b(?:npm|pnpm|yarn|bun|node|npx|python|cargo|make|gradle|docker|kubectl|curl|wget|chmod|rm|cp|mv)\b/i.test(
      source,
    )
  ) {
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
  type OrderedStep = { kind: 'tool'; id: string } | { kind: 'projected'; step: TurnActivityAction };

  const narration: string[] = [];
  const tools = new Map<string, AgentActivityItem>();
  const ordered: OrderedStep[] = [];
  const wireRollup = new Map<string, number>();
  let plan: AgentActivityItem['plan'];
  let thoughtMs = 0;
  let anonymousIndex = 0;
  let observedIndex = 0;
  let thoughtIndex = 0;
  let pendingThought: TurnActivityAction | undefined;

  for (const item of items) {
    if (item.plan) plan = item.plan;
    if (item.kind === 'output') {
      const prose = item.text?.trim();
      if (prose && narration.at(-1) !== prose) narration.push(prose);
      continue;
    }
    if (item.kind === 'thinking') {
      const previous = ordered.at(-1);
      if (
        previous?.kind === 'projected' &&
        previous.step.kind === 'thought' &&
        !previous.step.durationMs
      ) {
        previous.step.output = appendDistinctDetail(previous.step.output, item.text);
        pendingThought = previous.step;
      } else {
        const thought: TurnActivityAction = {
          id: `thought-${thoughtIndex++}`,
          kind: 'thought',
          weight: 'observation',
          title: 'Thought',
          label: 'thought',
          outcome: 'success',
          ...(item.text ? { output: item.text } : {}),
        };
        ordered.push({
          kind: 'projected',
          step: thought,
        });
        pendingThought = thought;
      }
      continue;
    }
    if (item.kind === 'summary') {
      for (const [verb, count] of Object.entries(item.rollup ?? {})) {
        wireRollup.set(verb, (wireRollup.get(verb) ?? 0) + count);
      }
      if (item.thoughtMs && item.thoughtMs > 0) {
        thoughtMs += item.thoughtMs;
        if (pendingThought) {
          pendingThought.durationMs = (pendingThought.durationMs ?? 0) + item.thoughtMs;
          pendingThought = undefined;
        } else {
          ordered.push({
            kind: 'projected',
            step: {
              id: `thought-${thoughtIndex++}`,
              kind: 'thought',
              weight: 'observation',
              title: 'Thought',
              label: 'thought',
              outcome: 'success',
              durationMs: item.thoughtMs,
            },
          });
        }
      }
      for (const call of item.observed ?? []) {
        const title = observedCallTitle(call.verb, call.target);
        ordered.push({
          kind: 'projected',
          step: {
            id: `observed-${observedIndex++}`,
            kind: 'tool',
            weight: 'observation',
            title,
            label: clamp(title.toLowerCase(), MAX_LEDGER_LABEL),
            outcome: 'success',
            toolKind: call.verb,
            ...(call.result ? { output: call.result } : {}),
          },
        });
      }
      // Older transcripts have only the rollup. Keep that historical work
      // visible without fabricating targets or raw output that never existed.
      if (!item.observed?.length) {
        for (const [verb, count] of Object.entries(item.rollup ?? {})) {
          const label = `${PRESENT_PARTICIPLE[verb] ?? verb} ${count}`;
          ordered.push({
            kind: 'projected',
            step: {
              id: `summary-${observedIndex++}`,
              kind: 'tool',
              weight: 'observation',
              title: label,
              label: clamp(label, MAX_LEDGER_LABEL),
              outcome: 'success',
              toolKind: verb,
            },
          });
        }
      }
      continue;
    }
    if (item.kind !== 'tool') continue;
    const id = item.id ?? `anonymous-${anonymousIndex++}`;
    if (!tools.has(id)) ordered.push({ kind: 'tool', id });
    tools.set(id, mergeToolActivity(tools.get(id), item));
  }

  const toolSteps = new Map<string, TurnActivityAction>();
  const actions: TurnActivityAction[] = [];
  const observations: TurnActivityAction[] = [];
  const localVerbs = new Map<string, number>();
  for (const [id, tool] of tools) {
    const weight = actionWeight(tool);
    const title = actionTitle(tool) ?? cleanTitle(tool.title) ?? 'Tool';
    const reason = weight === 'failure' ? failureReason(tool) : undefined;
    const row: TurnActivityAction = {
      id,
      kind: 'tool',
      weight,
      title,
      label: ledgerStepLabel(tool),
      outcome: activityOutcome(tool),
      ...(reason ? { reason } : {}),
      ...(tool.toolKind ? { toolKind: tool.toolKind } : {}),
      ...(tool.status ? { status: tool.status } : {}),
      ...(tool.command ? { command: tool.command } : {}),
      ...(tool.input ? { input: tool.input } : {}),
      ...((tool.output ?? tool.text) ? { output: tool.output ?? tool.text } : {}),
      ...(tool.files?.length ? { files: tool.files.map((file) => ({ ...file })) } : {}),
    };
    toolSteps.set(id, row);
    if (weight === 'observation') {
      observations.push(row);
      const verb = observationVerb(tool, title);
      localVerbs.set(verb, (localVerbs.get(verb) ?? 0) + 1);
    } else {
      actions.push(row);
    }
  }

  const steps = ordered.flatMap((entry) => {
    if (entry.kind === 'projected') return [entry.step];
    const step = toolSteps.get(entry.id);
    return step ? [step] : [];
  });
  for (const step of steps) {
    if (step.kind === 'tool' && step.weight === 'observation' && !toolSteps.has(step.id)) {
      observations.push(step);
    }
  }
  const verbs = new Map(localVerbs);
  for (const [verb, count] of wireRollup) verbs.set(verb, (verbs.get(verb) ?? 0) + count);
  const total = [...verbs.values()].reduce((sum, count) => sum + count, 0);

  return {
    narration,
    steps,
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
