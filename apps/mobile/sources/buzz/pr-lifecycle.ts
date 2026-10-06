import type { SystemLineMessage } from './system-lines';

export type NotificationLifecycleState =
  | 'Opened'
  | 'PR opened'
  | 'Merged'
  | 'Closed'
  | 'Checks running'
  | 'Checks passed'
  | 'Checks failed';
export type NotificationLifecycleRun = {
  subline: string;
  items: {
    id: string;
    title: string;
    state: NotificationLifecycleState;
    kindLine: string;
    kind: 'corner' | 'pull-request' | 'issue' | 'check';
    url?: string;
    cornerId?: string;
    actor: string;
    updatedBy: string;
  }[];
};

type LifecycleItem = NotificationLifecycleRun['items'][number];
/** A corner cleanup has no state: it only extends a cell that already exists. */
type LifecycleEvent = {
  keys: string[];
  item: Omit<LifecycleItem, 'state'> & { state?: NotificationLifecycleState };
  // A corner's name outranks the PR title it shares a cell with; cleanup never retitles.
  titleRank: number;
  prNumber?: number;
};

const GITHUB_ITEM = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)(?:[/?#]|$)/i;

function githubItem(url: string | undefined) {
  const match = url?.match(GITHUB_ITEM);
  if (!match) return undefined;
  const number = Number(match[4]);
  return {
    key: `${match[1]}/${match[2]}/${match[3]}/${number}`.toLowerCase(),
    pull: match[3].toLowerCase() === 'pull',
    number,
  };
}

function lifecycleItem(message: SystemLineMessage): LifecycleEvent | undefined {
  if (message.deleted || message.relayReports?.length) return undefined;
  const fact = message.daemonFact;
  // A corner opened from a message is that message's marker, never a lifecycle cell.
  if (fact?.sourceMessageId) return undefined;
  if (fact) {
    const pr = githubItem(fact.pullRequest?.url);
    const prNumber = fact.pullRequest?.number ?? (pr?.pull ? pr.number : undefined);
    const state =
      fact.type === 'corner-open'
        ? 'Opened'
        : fact.type === 'checks-failing'
          ? 'Checks failed'
          : fact.type === 'corner-complete'
            ? fact.outcome === 'abandoned'
              ? 'Closed'
              : 'Merged'
            : undefined;
    return {
      // The full PR URL joins a corner to its GitHub events; a bare number could cross repos.
      keys: [`corner:${fact.cornerId}`, ...(pr?.pull ? [pr.key] : [])],
      item: {
        id: message.id,
        title: fact.name ?? fact.pullRequest?.title ?? fact.objective,
        ...(state ? { state } : {}),
        kindLine: prNumber ? `corner · PR #${prNumber}` : 'corner',
        kind: 'corner',
        ...(fact.pullRequest?.url ? { url: fact.pullRequest.url } : {}),
        cornerId: fact.cornerId,
        actor: message.authorIdentity
          ? (message.authorIdentity.handle ?? message.authorIdentity.name)
          : '',
        updatedBy: message.id,
      },
      titleRank: fact.type === 'worktree-cleaned' ? 0 : 3,
      ...(prNumber ? { prNumber } : {}),
    };
  }
  const event = message.githubEvent;
  const github = githubItem(event?.url);
  if (
    event?.type === 'issue' &&
    github &&
    !github.pull &&
    ['opened', 'closed'].includes(event.action)
  ) {
    return {
      keys: [github.key],
      item: {
        id: message.id,
        title: event.title,
        state: event.action === 'opened' ? 'Opened' : 'Closed',
        kindLine: 'issue',
        kind: 'issue',
        url: event.url,
        actor: event.actor,
        updatedBy: message.id,
      },
      titleRank: 2,
    };
  }
  if (
    event?.type === 'pull-request' &&
    github?.pull &&
    ['opened', 'merged', 'closed'].includes(event.action)
  ) {
    return {
      keys: [github.key],
      titleRank: 2,
      prNumber: github.number,
      item: {
        id: message.id,
        title: event.title,
        state:
          event.action === 'opened' ? 'PR opened' : event.action === 'merged' ? 'Merged' : 'Closed',
        kindLine: `PR #${github.number}`,
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
    keys: [JSON.stringify([`${repository[1]}/${repository[2]}`.toLowerCase(), head, object.text])],
    titleRank: 0,
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

/**
 * Consecutive PR, issue and corner cards share one accordion; CI checks keep their own.
 * Chat and ordinary notices end a run. A lone corner fact keeps its own card.
 */
export function foldPrLifecycleRuns<T extends SystemLineMessage>(messages: readonly T[]): T[] {
  const result: T[] = [];
  type Cell = { keys: Set<string>; item: LifecycleItem; titleRank: number; prNumber?: number };
  let run: { anchor: T; checks: boolean; ids: string[]; cells: Cell[]; start: number } | undefined;
  for (const message of messages) {
    const lifecycle = lifecycleItem(message);
    if (!lifecycle) {
      run = undefined;
      result.push(message);
      continue;
    }
    const checks = lifecycle.item.kind === 'check';
    if (!run || run.checks !== checks) {
      run = { anchor: message, checks, ids: [], cells: [], start: message.timestamp };
      result.push(message);
    }
    run.ids.push(message.id);
    const matches = run.cells.filter((cell) => lifecycle.keys.some((key) => cell.keys.has(key)));
    const { state, ...item } = lifecycle.item;
    if (matches.length || state) {
      // Ids join the run in order, so the earliest cell keeps a stable accordion key.
      const first = matches.length
        ? matches.reduce((left, right) =>
            run!.ids.indexOf(right.item.id) < run!.ids.indexOf(left.item.id) ? right : left,
          ).item
        : undefined;
      const titled = [...matches]
        .reverse()
        .reduce<Cell | undefined>(
          (best, cell) => (!best || cell.titleRank > best.titleRank ? cell : best),
          undefined,
        );
      const keepTitle = titled && titled.titleRank > lifecycle.titleRank;
      const cornerId = item.cornerId ?? matches.find((cell) => cell.item.cornerId)?.item.cornerId;
      const prNumber = lifecycle.prNumber ?? matches.find((cell) => cell.prNumber)?.prNumber;
      const url = item.url ?? matches.find((cell) => cell.item.url)?.item.url;
      const actor = item.actor || matches.find((cell) => cell.item.actor)?.item.actor || '';
      const merged: Cell = {
        keys: new Set([...matches.flatMap((cell) => [...cell.keys]), ...lifecycle.keys]),
        titleRank: Math.max(lifecycle.titleRank, ...matches.map((cell) => cell.titleRank)),
        ...(prNumber ? { prNumber } : {}),
        item: {
          ...item,
          id: first?.id ?? message.id,
          title: keepTitle ? titled.item.title : item.title,
          state: state ?? first!.state,
          ...(cornerId
            ? {
                kind: 'corner' as const,
                cornerId,
                kindLine: prNumber ? `corner · PR #${prNumber}` : 'corner',
              }
            : {}),
          ...(url ? { url } : {}),
          actor,
        },
      };
      // Reinsertion keeps the most recently updated item at the front of the card.
      run.cells = [...run.cells.filter((cell) => !matches.includes(cell)), merged];
    }
    const items = run.cells.map((cell) => cell.item).reverse();
    // A run with no cell, or one corner fact alone, keeps the message's own card.
    if (!items.length || (run.ids.length === 1 && items[0]!.kind === 'corner')) continue;
    const actors = [...new Set(items.flatMap((item) => (item.actor ? [item.actor] : [])))];
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
        subline: `${actors.length ? `by ${actors.map((actor) => `@${actor.replace(/^@/, '')}`).join(', ')} · ` : ''}${clock(run.start)} – ${clock(message.timestamp)}`,
      },
    };
  }
  return result;
}
