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
      summary?: string;
      detail?: string;
      status?: string;
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

function actionTitle(item: AgentActivityItem): string {
  const title = oneLine(item.title)
    .replace(/^#+\s*/, '')
    .replace(/^\*\*|\*\*$/g, '');
  return clamp(title || (item.kind === 'tool' ? 'action' : 'output'), MAX_ACTION_TITLE);
}

function actionSummary(item: AgentActivityItem): string | undefined {
  const text = item.text ?? '';
  const exit = text.match(/(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?|code)\s*[:=]?\s*(-?\d+)/i);
  if (exit) return `exit ${exit[1]}`;
  const matches = text.match(/\b(\d+)\s+matches?\b/i);
  if (matches) return `${matches[1]} ${matches[1] === '1' ? 'match' : 'matches'}`;
  const files = text.match(/\b(\d+)\s+files?\b/i);
  if (files) return `${files[1]} ${files[1] === '1' ? 'file' : 'files'}`;

  const status = oneLine(item.status ?? '').toLowerCase();
  if (!status || status === 'completed' || status === 'complete' || status === 'success') {
    return undefined;
  }
  if (status === 'in_progress' || status === 'in progress' || status === 'pending') {
    return status.replace('_', ' ');
  }
  return clamp(status, 24);
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
    const previous = entries.at(-1);
    if (previous?.kind === 'action' && previous.title.toLowerCase() === title.toLowerCase()) {
      previous.detail = appendDistinctDetail(previous.detail, item.text);
      previous.status = item.status ?? previous.status;
      previous.summary = actionSummary(item) ?? previous.summary;
      continue;
    }

    const summary = actionSummary(item);
    entries.push({
      kind: 'action',
      title,
      ...(summary ? { summary } : {}),
      ...(item.text ? { detail: item.text } : {}),
      ...(item.status ? { status: item.status } : {}),
    });
  }

  return entries;
}
