import type { SystemEvent, SystemSubject } from '@beeline/api-contract/phone';

/**
 * System lines on the phone: one grammar, one renderer, one row per message.
 *
 * The server phrases every system notification (`apps/server/src/system-line.ts`)
 * as `<subject> <verb>[ <object>][ · <consequence>]` and stores the structured
 * event beside the text. The phone renders the event (names in brass, the
 * object linked by its URL). Every event keeps its original transcript row.
 * A row from before the grammar has no event and renders its text verbatim.
 */
export type SystemLineMessage = {
  relay?: { direction: 'down' | 'up'; anchorMessageId?: string };
  relayReports?: SystemLineMessage[];
  id: string;
  text: string;
  timestamp: number;
  isSystemNotice?: boolean;
  /** A deleted message's line; it holds that message's place, so it never folds. */
  deleted?: boolean;
  systemEvent?: SystemEvent;
  /** Every subject of a folded run, oldest first; absent on a single line. */
  systemSubjects?: SystemSubject[];
  /** The ids of every row folded into this one, oldest first. */
  foldedIds?: string[];
  githubEvent?: {
    type: string;
    action: string;
    actor: string;
    title: string;
    url: string;
    branch?: string;
    targetBranch?: string;
  };
  daemonFact?: {
    type: 'corner-complete' | 'checks-failing' | 'worktree-cleaned' | 'corner-open';
    cornerId: string;
    name?: string;
    objective: string;
    sourceMessageId?: string;
    outcome?: 'landed' | 'abandoned';
    pullRequest?: { number?: number; title?: string; url: string };
  };
  authorIdentity?: { kind: 'human' | 'agent'; name: string; handle?: string };
  notificationLifecycleRun?: NotificationLifecycleRun;
};

export type NotificationLifecycleState =
  | 'Opened'
  | 'PR opened'
  | 'Checks running'
  | 'Checks failed'
  | 'Checks passed'
  | 'Merged'
  | 'Closed'
  | 'Starred'
  | 'Ran'
  | 'Succeeded'
  | 'Failed';

export type NotificationLifecycleRun = {
  headline: string;
  subline: string;
  items: {
    id: string;
    title: string;
    state: NotificationLifecycleState;
    kindLine: string;
    danger?: boolean;
    kind?: 'corner' | 'pull-request' | 'issue' | 'check';
    url?: string;
    cornerId?: string;
    actor?: string;
    objective?: string;
  }[];
};

type HeadlineSubject = 'PR' | 'Check' | 'Issue' | 'Star' | 'Workflow';

const HEADLINE_ORDER: readonly HeadlineSubject[] = ['PR', 'Check', 'Issue', 'Star', 'Workflow'];
const HEADLINE_STATES: Readonly<Record<HeadlineSubject, readonly NotificationLifecycleState[]>> = {
  PR: ['PR opened', 'Opened', 'Closed', 'Merged', 'Checks passed', 'Checks failed'],
  Check: ['Checks passed', 'Checks failed', 'Checks running'],
  Issue: ['Opened', 'Closed'],
  Star: ['Starred'],
  Workflow: ['Ran', 'Succeeded', 'Failed'],
};

function headlineSubject(item: NotificationLifecycleRun['items'][number]): HeadlineSubject {
  if (item.kind === 'check') return 'Check';
  if (/^(workflow|run #)/i.test(item.kindLine)) return 'Workflow';
  if (/^issue/i.test(item.kindLine)) return 'Issue';
  if (/^star/i.test(item.kindLine)) return 'Star';
  return 'PR';
}

/** Subject-first, fixed-order lifecycle grammar shared by one-row and folded cards. */
export function formatNotificationHeadlines(
  items: readonly NotificationLifecycleRun['items'][number][],
): string[] {
  return HEADLINE_ORDER.flatMap((subject) => {
    const subjectItems = items.filter((item) => headlineSubject(item) === subject);
    if (!subjectItems.length) return [];
    if (subject === 'Star') return [`Star ${subjectItems.length}`];
    const counts = HEADLINE_STATES[subject].flatMap((state) => {
      const count = subjectItems.filter((item) => item.state === state).length;
      if (!count) return [];
      const word =
        state === 'PR opened'
          ? 'opened'
          : state === 'Checks failed'
            ? 'failed'
            : state === 'Checks passed'
              ? subject === 'Check'
                ? 'passed'
                : 'succeeded'
              : state === 'Checks running'
                ? 'running'
                : state.toLowerCase();
      return [`${count} ${word}`];
    });
    return counts.length ? [`${subject} ${counts.join(', ')}`] : [];
  });
}

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
