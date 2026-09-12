import type { SystemEvent, SystemSubject } from '@beeline/api-contract/phone';

/**
 * System lines on the phone: one grammar, one renderer, folded runs.
 *
 * The server phrases every system notification (`apps/server/src/system-line.ts`)
 * as `<subject> <verb>[ <object>][ · <consequence>]` and stores the structured
 * event beside the text. The phone renders the event (names in brass, the
 * object linked by its URL) and folds consecutive lines that share a verb,
 * object and consequence into one: "@candy, @terra and @codex joined". Adjacent
 * repository notification cards also become one render-time lifecycle card.
 * A row from before the grammar has no event and renders its text verbatim.
 */
export type SystemLineMessage = {
  relay?: { direction: 'down' | 'up'; anchorMessageId?: string };
  relayReports?: SystemLineMessage[];
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
    actor?: string;
    title: string;
    url: string;
    branch?: string;
  };
  daemonFact?: {
    type: 'corner-complete' | 'checks-failing' | 'worktree-cleaned' | 'corner-open';
    cornerId: string;
    name?: string;
    objective: string;
    outcome?: 'landed' | 'abandoned';
    pullRequest?: { number?: number; title?: string; url: string };
  };
  authorIdentity?: { kind: 'human' | 'agent'; name: string; handle?: string };
  notificationLifecycleRun?: NotificationLifecycleRun;
};

export type NotificationLifecycleState =
  'Opened' | 'PR opened' | 'Checks failed' | 'Checks passed' | 'Merged' | 'Closed';

export type NotificationLifecycleRun = {
  headline: string;
  subline: string;
  items: {
    id: string;
    title: string;
    state: NotificationLifecycleState;
    kindLine: string;
    danger?: boolean;
    url?: string;
    cornerId?: string;
  }[];
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

/** Attach before partitioning at the unread boundary, so a new report can reach an older card. */
export function anchorRelayReports<T extends SystemLineMessage>(messages: readonly T[]): T[] {
  const reports = new Map<string, T[]>();
  const anchors = new Set(messages.filter((m) => m.daemonFact).map((m) => m.id));
  for (const message of messages) {
    const anchor = message.relay?.direction === 'up' ? message.relay.anchorMessageId : undefined;
    if (anchor && anchors.has(anchor)) {
      const group = reports.get(anchor) ?? [];
      group.push(message);
      reports.set(anchor, group);
    }
  }
  return messages.flatMap((message) => {
    const anchor = message.relay?.direction === 'up' ? message.relay.anchorMessageId : undefined;
    if (anchor && anchors.has(anchor)) return [];
    return [
      reports.has(message.id) ? { ...message, relayReports: reports.get(message.id) } : message,
    ];
  });
}

/**
 * Fold adjacent notification cards or same-verb system lines into the first
 * row of each run. `messages` is in transcript order (oldest first); the
 * folded row keeps the first row's id (a stable list/reveal key) and takes the
 * newest row's stamp. Ordinary messages and every non-notification card end a
 * notification run before the existing same-verb system-line fold resumes.
 */
export function foldSystemLines<T extends SystemLineMessage>(messages: readonly T[]): T[] {
  const folded: T[] = [];
  let run: { index: number; key: string; subjects: SystemSubject[]; ids: string[] } | null = null;
  let notificationRun:
    { index: number; anchor: T; events: NotificationLifecycleEvent[] } | undefined;
  for (const message of anchorRelayReports(messages)) {
    const notification = message.relayReports?.length
      ? undefined
      : notificationLifecycleEvent(message);
    if (notification) {
      run = null;
      if (!notificationRun) {
        notificationRun = { index: folded.length, anchor: message, events: [notification] };
        folded.push(message);
      } else {
        notificationRun.events.push(notification);
        folded[notificationRun.index] = {
          ...notificationRun.anchor,
          timestamp: message.timestamp,
          foldedIds: notificationRun.events.map((event) => event.id),
          notificationLifecycleRun: summarizeNotificationRun(notificationRun.events),
        };
      }
      continue;
    }
    notificationRun = undefined;
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

type NotificationLifecycleEvent = {
  id: string;
  timestamp: number;
  title: string;
  titleRank: number;
  state?: NotificationLifecycleState;
  actor?: string;
  cornerId?: string;
  prNumber?: number;
  kind: 'corner' | 'pull-request' | 'issue' | 'check';
  url?: string;
  refs: string[];
};

function notificationLifecycleEvent(
  message: SystemLineMessage,
): NotificationLifecycleEvent | undefined {
  const fact = message.daemonFact;
  if (fact) {
    const prNumber = fact.pullRequest?.number ?? pullRequestNumber(fact.pullRequest?.url);
    const state =
      fact.type === 'corner-open'
        ? 'Opened'
        : fact.type === 'checks-failing'
          ? 'Checks failed'
          : fact.type === 'corner-complete'
            ? 'Merged'
            : undefined;
    return {
      id: message.id,
      timestamp: message.timestamp,
      title: fact.name ?? fact.pullRequest?.title ?? fact.objective,
      titleRank: fact.type === 'worktree-cleaned' ? 0 : 3,
      ...(state ? { state } : {}),
      ...(message.authorIdentity
        ? { actor: message.authorIdentity.handle ?? message.authorIdentity.name }
        : {}),
      cornerId: fact.cornerId,
      ...(prNumber ? { prNumber } : {}),
      kind: 'corner',
      ...(fact.pullRequest?.url ? { url: fact.pullRequest.url } : {}),
      refs: [
        `corner:${fact.cornerId}`,
        ...repositoryRefs(fact.pullRequest?.url, prNumber, undefined),
      ],
    };
  }

  if (message.githubEvent) {
    const event = message.githubEvent;
    const prNumber = event.type === 'pull-request' ? pullRequestNumber(event.url) : undefined;
    return {
      id: message.id,
      timestamp: message.timestamp,
      title: event.title,
      titleRank: 2,
      state:
        event.type === 'issue'
          ? event.action === 'opened'
            ? 'Opened'
            : 'Closed'
          : event.action === 'opened'
            ? 'PR opened'
            : event.action === 'merged'
              ? 'Merged'
              : 'Closed',
      ...(event.actor ? { actor: event.actor } : {}),
      ...(prNumber ? { prNumber } : {}),
      kind: event.type,
      url: event.url,
      refs: repositoryRefs(event.url, prNumber, event.branch),
    };
  }

  const event = message.isSystemNotice ? message.systemEvent : undefined;
  if (event?.subject.kind !== 'github' || !/(passed|failed) a check/i.test(event.verb)) {
    return undefined;
  }
  const url = event.object?.url;
  const prNumber = pullRequestNumber(url);
  return {
    id: message.id,
    timestamp: message.timestamp,
    title: event.object?.text ?? message.text,
    titleRank: 0,
    state: /failed/i.test(event.verb) ? 'Checks failed' : 'Checks passed',
    ...(prNumber ? { prNumber } : {}),
    kind: 'check',
    ...(url ? { url } : {}),
    refs: repositoryRefs(url, prNumber, undefined),
  };
}

function pullRequestNumber(url: string | undefined): number | undefined {
  const match = url?.match(/\/pull\/(\d+)(?:\/|$)/i);
  return match ? Number(match[1]) : undefined;
}

function repositoryRefs(
  url: string | undefined,
  prNumber: number | undefined,
  branch: string | undefined,
): string[] {
  // These are the render-time joins available in the phone DTO. `cornerId`
  // joins daemon facts; normalized PR URL/number and GitHub head branch join
  // webhook rows. A completed corner carries both cornerId and PR identity,
  // making the two sets converge transitively without persisted linkage.
  return [
    ...(url
      ? [
          `url:${url
            .replace(/[?#].*$/, '')
            .replace(/\/$/, '')
            .toLowerCase()}`,
        ]
      : []),
    ...(prNumber ? [`pr:${prNumber}`] : []),
    ...(branch ? [`branch:${branch.toLowerCase()}`] : []),
  ];
}

function normalizeActor(actor: string): string {
  return `@${actor.replace(/^@/, '')}`;
}

function summarizeNotificationRun(
  events: readonly NotificationLifecycleEvent[],
): NotificationLifecycleRun {
  type Subject = { events: NotificationLifecycleEvent[]; refs: Set<string> };
  const subjects: Subject[] = [];
  for (const event of events) {
    const refs = event.refs.length ? event.refs : [`event:${event.id}`];
    const matches = subjects.filter((subject) => refs.some((ref) => subject.refs.has(ref)));
    if (!matches.length) {
      // Cleanup is presentation noise. It can extend an existing corner subject,
      // but it never creates a row of its own.
      if (!event.state) continue;
      subjects.push({ events: [event], refs: new Set(refs) });
      continue;
    }
    const target = matches[0]!;
    target.events.push(event);
    refs.forEach((ref) => target.refs.add(ref));
    for (const merged of matches.slice(1)) {
      target.events.push(...merged.events);
      merged.refs.forEach((ref) => target.refs.add(ref));
      subjects.splice(subjects.indexOf(merged), 1);
    }
  }

  const rows = subjects
    .map((subject) => {
      const byRunOrder = (left: NotificationLifecycleEvent, right: NotificationLifecycleEvent) =>
        events.indexOf(left) - events.indexOf(right);
      const stateEvent = subject.events
        .filter((event) => event.state)
        .sort(byRunOrder)
        .at(-1)!;
      const titleRank = Math.max(...subject.events.map((item) => item.titleRank));
      const titled = subject.events
        .filter((event) => event.titleRank === titleRank)
        .sort(byRunOrder)
        .at(-1)!;
      const corner = subject.events.find((event) => event.cornerId);
      const linked = subject.events
        .filter((event) => event.url)
        .sort(byRunOrder)
        .at(-1);
      const prNumber = subject.events
        .filter((event) => event.prNumber)
        .sort(byRunOrder)
        .at(-1)?.prNumber;
      const issue = subject.events.some((event) => event.kind === 'issue');
      return {
        id: subject.events[0]!.id,
        title: titled.title,
        state: stateEvent.state!,
        kindLine: corner
          ? `corner${prNumber ? ` · PR #${prNumber}` : ''}`
          : issue
            ? 'issue'
            : prNumber
              ? `PR #${prNumber}`
              : 'check',
        ...(stateEvent.state === 'Checks failed' ? { danger: true } : {}),
        ...(corner?.cornerId ? { cornerId: corner.cornerId } : {}),
        ...(!corner?.cornerId && linked?.url ? { url: linked.url } : {}),
        latestOrder: Math.max(...subject.events.map((event) => events.indexOf(event))),
      };
    })
    .sort((left, right) => right.latestOrder - left.latestOrder);

  const stateCounts = new Map<NotificationLifecycleState, number>();
  for (const row of rows) stateCounts.set(row.state, (stateCounts.get(row.state) ?? 0) + 1);
  const headline = [...stateCounts]
    .map(([state, count]) => `${count} ${state === 'PR opened' ? state : state.toLowerCase()}`)
    .join(' · ');
  const actors = [
    ...new Set(events.flatMap((event) => (event.actor ? [normalizeActor(event.actor)] : []))),
  ];
  const startedAt = Math.min(...events.map((event) => event.timestamp));
  const endedAt = Math.max(...events.map((event) => event.timestamp));
  const time = `${clockStamp(startedAt)} – ${clockStamp(endedAt)}`;
  return {
    headline,
    subline: `${actors.length ? `by ${actors.join(', ')} · ` : ''}${time}`,
    items: rows.map(({ latestOrder: _latestOrder, ...row }) => row),
  };
}

function clockStamp(seconds: number): string {
  const at = new Date(seconds * 1000);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}
