import type { SystemLineMessage } from './system-lines';

export type NotificationLifecycleState = 'PR opened' | 'Merged' | 'Closed';
export type NotificationLifecycleRun = {
  subline: string;
  items: {
    id: string;
    title: string;
    state: NotificationLifecycleState;
    kindLine: string;
    kind: 'pull-request';
    url: string;
    actor: string;
    updatedBy: string;
  }[];
};

/** Group only consecutive PR cards. System notices and chat keep their own rows. */
export function foldPrLifecycleRuns<T extends SystemLineMessage>(messages: readonly T[]): T[] {
  const result: T[] = [];
  let run:
    | {
        anchor: T;
        ids: string[];
        items: Map<string, NotificationLifecycleRun['items'][number]>;
        start: number;
      }
    | undefined;
  for (const message of messages) {
    const event = message.githubEvent;
    const match = event?.url.match(
      /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#]|$)/i,
    );
    if (
      event?.type !== 'pull-request' ||
      !match ||
      message.deleted ||
      message.relayReports?.length ||
      !['opened', 'merged', 'closed'].includes(event.action)
    ) {
      run = undefined;
      result.push(message);
      continue;
    }
    if (!run) {
      run = { anchor: message, ids: [], items: new Map(), start: message.timestamp };
      result.push(message);
    }
    const key = `${match[1]}/${match[2]}/pull/${Number(match[3])}`.toLowerCase();
    const previous = run.items.get(key);
    run.ids.push(message.id);
    // Reinsertion keeps the most recently updated PR at the front of the card.
    run.items.delete(key);
    run.items.set(key, {
      id: previous?.id ?? message.id,
      title: event.title,
      state:
        event.action === 'opened' ? 'PR opened' : event.action === 'merged' ? 'Merged' : 'Closed',
      kindLine: `PR #${Number(match[3])}`,
      kind: 'pull-request',
      url: event.url,
      actor: event.actor,
      updatedBy: message.id,
    });
    const items = [...run.items.values()].reverse();
    const actors = [...new Set(items.map((item) => item.actor))];
    const clock = (stamp: number) => {
      const date = new Date(stamp * 1000);
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    };
    result[result.length - 1] = {
      ...run.anchor,
      timestamp: message.timestamp,
      foldedIds: [...run.ids],
      notificationLifecycleRun: {
        items,
        subline: `by ${actors.map((actor) => `@${actor.replace(/^@/, '')}`).join(', ')} · ${clock(run.start)} – ${clock(message.timestamp)}`,
      },
    };
  }
  return result;
}
