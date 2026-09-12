import type { SystemEvent, SystemSubject } from '@beeline/api-contract/phone';

/**
 * System lines on the phone: one grammar, one renderer, folded runs.
 *
 * The server phrases every system notification (`apps/server/src/system-line.ts`)
 * as `<subject> <verb>[ <object>][ · <consequence>]` and stores the structured
 * event beside the text. The phone renders the event (names in brass, the
 * object linked by its URL) and folds consecutive lines that share a verb,
 * object and consequence into one: "@candy, @terra and @codex joined". A row from
 * before the grammar has no event and renders its text verbatim.
 */
export type SystemLineMessage = {
  id: string;
  text: string;
  timestamp: number;
  isSystemNotice?: boolean;
  systemEvent?: SystemEvent;
  /** Every subject of a folded run, oldest first; absent on a single line. */
  systemSubjects?: SystemSubject[];
  /** The ids of every row folded into this one, oldest first. */
  foldedIds?: string[];
  githubEvent?: {
    type: 'pull-request' | 'issue';
    action: 'opened' | 'closed' | 'merged';
    title: string;
    url: string;
  };
  githubLifecycleRun?: {
    headline: string;
    items: { id: string; title: string; url?: string }[];
  };
};

/** "@candy" · "@candy and @terra" · "@candy, @terra and @codex". */
export function joinSystemNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function systemLineSubjects(message: {
  systemEvent?: SystemEvent;
  systemSubjects?: SystemSubject[];
}): SystemSubject[] {
  return message.systemSubjects ?? (message.systemEvent ? [message.systemEvent.subject] : []);
}

/** The plain text of an event for one or several subjects (previews, accessibility). */
export function systemLineText(event: SystemEvent, subjects?: readonly SystemSubject[]): string {
  const names = (subjects ?? [event.subject]).map((subject) => subject.name);
  const head = [joinSystemNames(names), event.verb].filter(Boolean).join(' ');
  const line = event.object?.text ? `${head} ${event.object.text}` : head;
  return event.consequence ? `${line} · ${event.consequence}` : line;
}

function foldKey(event: SystemEvent): string {
  return JSON.stringify([
    event.verb,
    event.object?.text ?? '',
    event.object?.id ?? '',
    event.object?.url ?? '',
    event.consequence ?? '',
  ]);
}

function subjectKey(subject: SystemSubject): string {
  return subject.id ?? `${subject.kind}:${subject.name}`;
}

/**
 * Fold adjacent system lines sharing one verb (and object and consequence)
 * into the first of the run. `messages` is in transcript order (oldest first);
 * the folded row keeps the first row's id (a stable key for the list and the
 * reveal ledger) and takes the newest row's stamp.
 */
export function foldSystemLines<T extends SystemLineMessage>(messages: readonly T[]): T[] {
  const folded: T[] = [];
  let run: { index: number; key: string; subjects: SystemSubject[]; ids: string[] } | null = null;
  let githubRun: { index: number; anchor: T; items: GitHubFoldItem[] } | undefined;
  for (const message of messages) {
    const githubItem = githubFoldItem(message);
    if (githubItem) {
      run = null;
      if (!githubRun) {
        githubRun = { index: folded.length, anchor: message, items: [githubItem] };
        folded.push(message);
      } else {
        githubRun.items.push(githubItem);
        folded[githubRun.index] = {
          ...githubRun.anchor,
          timestamp: message.timestamp,
          githubLifecycleRun: {
            headline: githubHeadline(githubRun.items),
            items: [...githubRun.items].reverse().map(({ id, title, url }) => ({
              id,
              title,
              ...(url ? { url } : {}),
            })),
          },
        };
      }
      continue;
    }
    githubRun = undefined;
    const event = message.isSystemNotice ? message.systemEvent : undefined;
    if (!event) {
      run = null;
      folded.push(message);
      continue;
    }
    const key = foldKey(event);
    if (run && run.key === key) {
      const seen = new Set(run.subjects.map(subjectKey));
      if (!seen.has(subjectKey(event.subject))) run.subjects.push(event.subject);
      run.ids.push(message.id);
      const anchor = folded[run.index]!;
      folded[run.index] = {
        ...anchor,
        timestamp: message.timestamp,
        text: systemLineText(event, run.subjects),
        systemSubjects: [...run.subjects],
        foldedIds: [...run.ids],
      };
      continue;
    }
    run = { index: folded.length, key, subjects: [event.subject], ids: [message.id] };
    folded.push(message);
  }
  return folded;
}

type GitHubFoldItem = {
  id: string;
  title: string;
  url?: string;
  verb: string;
  subject: 'PR' | 'issue' | 'push' | 'check' | 'event';
};

function githubFoldItem(message: SystemLineMessage): GitHubFoldItem | undefined {
  const event = message.isSystemNotice ? message.systemEvent : undefined;
  if (!message.githubEvent && event?.subject.kind !== 'github') return undefined;
  const verb = message.githubEvent?.action ?? event!.verb;
  const subject = message.githubEvent
    ? message.githubEvent.type === 'pull-request'
      ? 'PR'
      : 'issue'
    : /pull request|merge/i.test(verb)
      ? 'PR'
      : /check/i.test(verb)
        ? 'check'
        : /push/i.test(verb)
          ? 'push'
          : 'event';
  return {
    id: message.id,
    title: message.githubEvent?.title ?? event?.object?.text ?? message.text,
    ...((message.githubEvent?.url ?? event?.object?.url)
      ? { url: message.githubEvent?.url ?? event?.object?.url }
      : {}),
    verb,
    subject,
  };
}

function githubHeadline(items: readonly GitHubFoldItem[]): string {
  const groups = new Map<string, { item: GitHubFoldItem; count: number }>();
  for (const item of items) {
    const verb =
      ['opened', 'merged', 'closed', 'pushed', 'passed', 'failed', 'started'].find((candidate) =>
        item.verb.toLowerCase().includes(candidate.replace(/ed$/, '')),
      ) ?? item.verb.toLowerCase();
    const key = `${item.subject}:${verb}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { item: { ...item, verb }, count: 1 });
  }
  const named = new Set<string>();
  return [...groups.values()]
    .map(({ item, count }) => {
      if (item.subject === 'push') return `${count} ${count === 1 ? 'push' : 'pushes'}`;
      const repeated = named.has(item.subject);
      named.add(item.subject);
      if (repeated) return `${count} ${item.verb}`;
      const noun = item.subject === 'event' ? 'GitHub event' : item.subject;
      return `${count} ${noun}${count === 1 ? '' : 's'} ${item.verb}`;
    })
    .join(' · ');
}
