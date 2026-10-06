import type { SystemLineMessage } from './system-lines';

export type NotificationLifecycleState =
  'PR opened' | 'Merged' | 'Closed' | 'Checks running' | 'Checks passed' | 'Checks failed';
export type NotificationLifecycleRun = {
  subline: string;
  items: {
    id: string;
    title: string;
    state: NotificationLifecycleState;
    kindLine: string;
    kind: 'pull-request' | 'check';
    url: string;
    actor: string;
    updatedBy: string;
  }[];
};

type LifecycleItem = NotificationLifecycleRun['items'][number];

function lifecycleItem(
  message: SystemLineMessage,
): { key: string; item: LifecycleItem } | undefined {
  if (message.deleted || message.relayReports?.length) return undefined;
  const event = message.githubEvent;
  const pr = event?.url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#]|$)/i);
  if (
    event?.type === 'pull-request' &&
    pr &&
    ['opened', 'merged', 'closed'].includes(event.action)
  ) {
    return {
      key: `${pr[1]}/${pr[2]}/pull/${Number(pr[3])}`.toLowerCase(),
      item: {
        id: message.id,
        title: event.title,
        state:
          event.action === 'opened' ? 'PR opened' : event.action === 'merged' ? 'Merged' : 'Closed',
        kindLine: `PR #${Number(pr[3])}`,
        kind: 'pull-request',
        url: event.url,
        actor: event.actor,
        updatedBy: message.id,
      },
    };
  }
  const check = message.isSystemNotice ? message.systemEvent : undefined;
  const action = check?.verb.match(/^(started|passed|failed) a check$/)?.[1];
  const object = check?.object;
  const repository = object?.url?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\//i);
  // Missing identity stays a readable system line; never join by a title or PR number.
  if (
    check?.subject.kind !== 'github' ||
    !action ||
    !repository ||
    !object?.text ||
    !/^[a-f0-9]{40}$/i.test(object.headSha ?? '')
  )
    return undefined;
  const head = object.headSha!.toLowerCase();
  return {
    key: JSON.stringify([`${repository[1]}/${repository[2]}`.toLowerCase(), head, object.text]),
    item: {
      id: message.id,
      title: object.text,
      state:
        action === 'started'
          ? 'Checks running'
          : action === 'passed'
            ? 'Checks passed'
            : 'Checks failed',
      kindLine: `Check · ${head.slice(0, 7)}${check.consequence ? ` · ${check.consequence}` : ''}`,
      kind: 'check',
      url: object.url!,
      actor: check.subject.name,
      updatedBy: message.id,
    },
  };
}

/** Consecutive PR or CI cards share their own accordion; chat and ordinary notices end it. */
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
    const lifecycle = lifecycleItem(message);
    if (!lifecycle) {
      run = undefined;
      result.push(message);
      continue;
    }
    if (!run || [...run.items.values()][0]?.kind !== lifecycle.item.kind) {
      run = { anchor: message, ids: [], items: new Map(), start: message.timestamp };
      result.push(message);
    }
    const { key, item } = lifecycle;
    const previous = run.items.get(key);
    run.ids.push(message.id);
    // Reinsertion keeps the most recently updated item at the front of the card.
    run.items.delete(key);
    run.items.set(key, {
      ...item,
      id: previous?.id ?? message.id,
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
