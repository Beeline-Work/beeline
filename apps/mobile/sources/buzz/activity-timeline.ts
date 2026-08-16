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

export type TurnActivityAction = {
  id: string;
  kind: 'file' | 'tool';
  title: string;
  status?: string;
  path?: string;
  command?: string;
  input?: string;
  output?: string;
  diff?: string;
};

export type TurnActivity = {
  summary: string;
  updates: string[];
  actions: TurnActivityAction[];
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
    return 'Command failed';
  }
  return 'Action failed';
}

function actionTitle(item: AgentActivityItem): string | undefined {
  const title = cleanTitle(item.title);
  const text = item.text ?? '';
  const source = `${title}\n${text}`;
  const normalized = title.toLowerCase();
  if (isFailure(item)) return failureTitle(item);
  if (/^(?:tool|result|action|output)$/i.test(title) && !text.trim()) return undefined;
  if (/\b(read|open|cat)\b/i.test(source)) {
    const count = fileCount(source);
    if (count && count > 1) return `Read ${count} files`;
    const file = firstFileName(source);
    return file ? `Read ${file}` : 'Read a file';
  }
  if (/\b(search|grep|\brg\b|find)\b/i.test(source)) {
    const terms = searchTerms(title) ?? searchTerms(text);
    return terms ? `Searched for ${terms}` : 'Searched code';
  }
  const command = source.match(
    /\bgit\s+(?:status|diff|log|show|branch|add|commit|checkout)\b[^\n]*/i,
  )?.[0];
  if (command) return `Ran ${clamp(redactPaths(command), 48)}`;
  if (/\b(bash|shell|execute|run)\b/i.test(source)) return 'Ran a command';
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
 * Only adjacent updates coalesce, so tool/reasoning order remains visible.
 */
export function buildActivityTimeline(
  items: readonly AgentActivityItem[],
): ActivityTimelineEntry[] {
  const entries: ActivityTimelineEntry[] = [];

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
    const previous = entries.at(-1);
    const isRead = title.startsWith('Read ');
    if (
      previous?.kind === 'action' &&
      (previous.title.toLowerCase() === title.toLowerCase() ||
        (isRead && previous.title.startsWith('Read ')))
    ) {
      previous.count += 1;
      if (isRead) previous.title = `Read ${previous.count} files`;
      previous.detail = appendDistinctDetail(previous.detail, item.text);
      continue;
    }

    entries.push({
      kind: 'action',
      title,
      count: 1,
      ...(item.text ? { detail: redactPaths(item.text) } : {}),
    });
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

function summaryText(files: number, tests: number, otherTools: number, hasPlan: boolean): string {
  const parts: string[] = [];
  if (files) parts.push(`Edited ${files} ${files === 1 ? 'file' : 'files'}`);
  if (tests) parts.push(tests === 1 ? 'ran tests' : `ran ${tests} test commands`);
  if (otherTools) parts.push(`${otherTools === 1 ? 'used 1 tool' : `used ${otherTools} tools`}`);
  if (hasPlan && !parts.length) parts.push('Updated the checklist');
  return parts.length ? `${parts.join(', ')}.` : 'Turn details.';
}

/** Build the three-depth corner model: prose, one summary, then inspectable actions. */
export function buildTurnActivity(items: readonly AgentActivityItem[]): TurnActivity {
  const updates: string[] = [];
  const tools = new Map<string, AgentActivityItem>();
  let plan: AgentActivityItem['plan'];
  let anonymousIndex = 0;

  for (const item of items) {
    if (item.plan) plan = item.plan;
    if (item.kind === 'output') {
      const update = item.text?.trim();
      if (update && updates.at(-1) !== update) updates.push(update);
      continue;
    }
    if (item.kind !== 'tool') continue;
    const key = item.id ?? `anonymous-${anonymousIndex++}`;
    tools.set(key, mergeToolActivity(tools.get(key), item));
  }

  const actions: TurnActivityAction[] = [];
  const seenFiles = new Set<string>();
  let testCommands = 0;
  let otherTools = 0;
  for (const [id, tool] of tools) {
    for (const file of tool.files ?? []) {
      const existingIndex = actions.findIndex(
        (action) => action.kind === 'file' && action.path === file.path,
      );
      const action: TurnActivityAction = {
        id: `${id}:file:${file.path}`,
        kind: 'file',
        title: file.path.split('/').filter(Boolean).at(-1) ?? file.path,
        path: file.path,
        ...(file.status ? { status: file.status } : {}),
        ...(file.diff ? { diff: file.diff } : {}),
      };
      if (existingIndex >= 0) actions[existingIndex] = { ...actions[existingIndex], ...action };
      else actions.push(action);
      seenFiles.add(file.path);
    }
    const title = actionTitle(tool) ?? cleanTitle(tool.title) ?? 'Tool';
    const isTest = /(?:^|\s)(?:test|tests|vitest|jest|pytest|cargo test|gradle)(?:\s|$)/i.test(
      `${title} ${tool.command ?? ''}`,
    );
    if (isTest) testCommands += 1;
    else if (!tool.files?.length && !tool.plan) otherTools += 1;
    actions.push({
      id,
      kind: 'tool',
      title,
      ...(tool.status ? { status: tool.status } : {}),
      ...(tool.command ? { command: tool.command } : {}),
      ...(tool.input ? { input: tool.input } : {}),
      ...((tool.output ?? tool.text) ? { output: tool.output ?? tool.text } : {}),
    });
  }

  return {
    summary: summaryText(seenFiles.size, testCommands, otherTools, Boolean(plan)),
    updates,
    actions,
    ...(plan ? { plan } : {}),
  };
}
