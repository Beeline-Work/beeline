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
};

/** "@candy" · "@candy and @terra" · "@candy, @terra and @codex". */
export function joinSystemNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
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
