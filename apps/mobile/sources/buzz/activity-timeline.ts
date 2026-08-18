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

export type TurnActivityAction = {
  id: string;
  kind: 'file' | 'tool';
  weight: ActionWeight;
  title: string;
  status?: string;
  path?: string;
  command?: string;
  input?: string;
  output?: string;
  diff?: string;
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
  /** How many calls that note stands for, including wire-only tallies. */
  noteCount: number;
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
 * narration: its text restates mechanism the note already states, and its
 * `rollup` is the only record of the observational calls body counts but never
 * projects as their own events, so it feeds the count and nothing else.
 */
export function buildTurnActivity(items: readonly AgentActivityItem[]): TurnActivity {
  const narration: string[] = [];
  const tools = new Map<string, AgentActivityItem>();
  const wireRollup = new Map<string, number>();
  let plan: AgentActivityItem['plan'];
  let anonymousIndex = 0;

  for (const item of items) {
    if (item.plan) plan = item.plan;
    if (item.kind === 'summary') {
      for (const [verb, count] of Object.entries(item.rollup ?? {})) {
        wireRollup.set(verb, (wireRollup.get(verb) ?? 0) + count);
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
  const observations: TurnActivityAction[] = [];
  const localVerbs = new Map<string, number>();

  for (const [id, tool] of tools) {
    const weight = actionWeight(tool);
    const title = actionTitle(tool) ?? cleanTitle(tool.title) ?? 'Tool';
    // A tool call that touched files *is* its files: one row per path, carrying
    // the call's own command/output so the drill-down loses nothing. Emitting a
    // parent row beside them printed the same edit twice.
    if (tool.files?.length) {
      for (const file of tool.files) {
        const row: TurnActivityAction = {
          id: `${id}:file:${file.path}`,
          kind: 'file',
          weight,
          title: file.path.split('/').filter(Boolean).at(-1) ?? file.path,
          path: file.path,
          ...(file.status ?? tool.status ? { status: file.status ?? tool.status } : {}),
          ...(file.diff ? { diff: file.diff } : {}),
          ...(tool.command ? { command: tool.command } : {}),
          ...(tool.input ? { input: tool.input } : {}),
          ...((tool.output ?? tool.text) ? { output: tool.output ?? tool.text } : {}),
        };
        const existing = actions.findIndex(
          (action) => action.kind === 'file' && action.path === file.path,
        );
        if (existing >= 0) actions[existing] = { ...actions[existing], ...row };
        else actions.push(row);
      }
      continue;
    }

    const row: TurnActivityAction = {
      id,
      kind: 'tool',
      weight,
      title,
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
    ...(total ? { note: noteText(total, verbs) } : {}),
    noteCount: total,
    ...(plan ? { plan } : {}),
  };
}
