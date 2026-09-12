import type { ChatDisplayMessage } from './room-view-presentation';

export type GitHubLifecycleItem = {
  id: string;
  title: string;
  url?: string;
  verb: string;
  subject: 'PR' | 'issue' | 'push' | 'check' | 'event';
};

export type GitHubLifecycleRun = {
  headline: string;
  /** Newest first, matching the order a person scans an activity summary. */
  items: GitHubLifecycleItem[];
  /** Oldest first; the first id remains the stable rendered row key. */
  foldedIds: string[];
};

function subjectFor(message: ChatDisplayMessage, verb: string): GitHubLifecycleItem['subject'] {
  if (message.githubEvent?.type === 'pull-request' || /pull request/i.test(verb)) return 'PR';
  if (message.githubEvent?.type === 'issue') return 'issue';
  if (/check/i.test(verb)) return 'check';
  if (/push/i.test(verb)) return 'push';
  if (/merge/i.test(verb)) return 'PR';
  return 'event';
}

export function githubLifecycleItem(message: ChatDisplayMessage): GitHubLifecycleItem | undefined {
  if (message.githubEvent) {
    return {
      id: message.id,
      title: message.githubEvent.title,
      url: message.githubEvent.url,
      verb: message.githubEvent.action,
      subject: subjectFor(message, message.githubEvent.action),
    };
  }
  const event = message.isSystemNotice ? message.systemEvent : undefined;
  if (event?.subject.kind !== 'github') return undefined;
  return {
    id: message.id,
    title: event.object?.text ?? message.text,
    ...(event.object?.url ? { url: event.object.url } : {}),
    verb: event.verb,
    subject: subjectFor(message, event.verb),
  };
}

function normalizedVerb(item: GitHubLifecycleItem): string {
  if (/opened/i.test(item.verb)) return 'opened';
  if (/merged/i.test(item.verb)) return 'merged';
  if (/closed/i.test(item.verb)) return 'closed';
  if (/push/i.test(item.verb)) return 'pushed';
  if (/passed/i.test(item.verb)) return 'passed';
  if (/failed/i.test(item.verb)) return 'failed';
  if (/started/i.test(item.verb)) return 'started';
  return item.verb.trim().toLowerCase();
}

function headlinePart(item: GitHubLifecycleItem, count: number, repeatSubject: boolean): string {
  const verb = normalizedVerb(item);
  if (item.subject === 'push') return `${count} ${count === 1 ? 'push' : 'pushes'}`;
  if (repeatSubject) return `${count} ${verb}`;
  const noun =
    item.subject === 'PR'
      ? count === 1
        ? 'PR'
        : 'PRs'
      : item.subject === 'issue'
        ? count === 1
          ? 'issue'
          : 'issues'
        : item.subject === 'check'
          ? count === 1
            ? 'check'
            : 'checks'
          : count === 1
            ? 'GitHub event'
            : 'GitHub events';
  return `${count} ${noun} ${verb}`;
}

export function githubLifecycleHeadline(items: readonly GitHubLifecycleItem[]): string {
  const groups: Array<{ key: string; item: GitHubLifecycleItem; count: number }> = [];
  for (const item of items) {
    const key = `${item.subject}:${normalizedVerb(item)}`;
    const group = groups.find((candidate) => candidate.key === key);
    if (group) group.count += 1;
    else groups.push({ key, item, count: 1 });
  }
  return groups
    .map(({ item, count }, index) =>
      headlinePart(
        item,
        count,
        groups.slice(0, index).some((group) => group.item.subject === item.subject),
      ),
    )
    .join(' · ');
}

/**
 * Fold adjacent GitHub lifecycle rows at render time. A singleton remains
 * byte-for-byte the row it was; a run keeps its first id so an appended event
 * updates the mounted summary rather than creating a second card.
 */
export function foldGitHubLifecycleRuns(
  messages: readonly ChatDisplayMessage[],
): ChatDisplayMessage[] {
  const folded: ChatDisplayMessage[] = [];
  let run: { index: number; messages: ChatDisplayMessage[]; items: GitHubLifecycleItem[] } | null =
    null;
  for (const message of messages) {
    const item = githubLifecycleItem(message);
    if (!item) {
      run = null;
      folded.push(message);
      continue;
    }
    if (!run) {
      run = { index: folded.length, messages: [message], items: [item] };
      folded.push(message);
      continue;
    }
    run.messages.push(message);
    run.items.push(item);
    const anchor = run.messages[0]!;
    folded[run.index] = {
      ...anchor,
      timestamp: message.timestamp,
      githubLifecycleRun: {
        headline: githubLifecycleHeadline(run.items),
        items: [...run.items].reverse(),
        foldedIds: run.messages.map((entry) => entry.id),
      },
    };
  }
  return folded;
}
