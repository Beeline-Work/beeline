import { cornerDisplayName, cornerShortTitle } from '@beeline/api-contract/phone';
import type { SystemLineMessage } from './system-lines';

// The NAME titles a corner card; a card written before the name existed
// falls back to the same three-word derivation every other corner surface
// uses (C89). Single and grouped cards share it so a group of one matches.
export function lifecycleCornerTitle(fact: {
  name?: string;
  objective: string;
  cornerId: string;
}): string {
  return cornerShortTitle(undefined, fact.name ?? cornerDisplayName(fact.objective), fact.cornerId);
}

export type NotificationLifecycleState =
  | 'Filed'
  | 'Commented'
  | 'Reopened'
  | (string & {})
  | 'Opened'
  | 'PR opened'
  | 'Merged'
  | 'Closed'
  | 'Checks running'
  | 'Checks passed'
  | 'Checks failed'
  | 'Checks cancelled';
export type NotificationLifecycleRun = {
  subline: string;
  items: {
    id: string;
    title: string;
    state: NotificationLifecycleState;
    kindLine: string;
    kind: 'corner' | 'pull-request' | 'issue' | 'check' | 'notice' | 'payment' | 'wallet';
    url?: string;
    cornerId?: string;
    /** A check cell's commit, lowercase. */
    headSha?: string;
    actor: string;
    updatedBy: string;
  }[];
};

type LifecycleItem = NotificationLifecycleRun['items'][number];

/** Presentation only: each committed event keeps its own line and destination. */
export function lifecycleItem(message: SystemLineMessage): LifecycleItem | undefined {
  if (message.deleted) return;
  const fact = message.daemonFact;
  const event = message.githubEvent;
  const base = { id: message.id, updatedBy: message.id, actor: '' };
  if (message.walletTx) {
    const tx = message.walletTx;
    return {
      ...base,
      title: `${tx.amountText} · ${tx.counterparty} · ${tx.chain} · ${tx.balanceAfterUsd} left`,
      state: tx.direction === 'out' ? 'Sent' : 'Received',
      kind: 'payment',
      kindLine: 'Payment',
      actor: tx.agentName ?? '',
      url: tx.txUrl,
    };
  }
  if (message.walletDelegation) {
    const grant = message.walletDelegation;
    return {
      ...base,
      title:
        'standing' in grant
          ? 'Agents may sign · stands until revoked'
          : `Agents may sign · until ${new Date(grant.expiresAt).toLocaleString()} · renews in the app`,
      state: 'Permission granted',
      kind: 'wallet',
      kindLine: 'Wallet',
    };
  }
  if (fact) {
    if (fact.type === 'corner-open' || fact.type === 'corner-complete') {
      return {
        ...base,
        title: lifecycleCornerTitle(fact),
        state:
          fact.outcome === 'landed'
            ? 'Merged'
            : fact.type === 'corner-complete'
              ? 'Closed'
              : 'Opened',
        kind: 'corner',
        kindLine: 'corner',
        cornerId: fact.cornerId,
        ...(fact.outcome === 'landed' && fact.pullRequest ? { url: fact.pullRequest.url } : {}),
      };
    }
    if (fact.type !== 'checks-failing') return;
    return {
      ...base,
      title: lifecycleCornerTitle(fact),
      state: 'Checks failed',
      kind: 'check',
      kindLine: 'Checks',
      cornerId: fact.cornerId,
      url: fact.pullRequest?.url,
    };
  }
  if (event && ['pull-request', 'issue'].includes(event.type)) {
    const number = event.url.match(/\/(?:pull|issues)\/(\d+)/)?.[1];
    const issue = event.type === 'issue';
    const state =
      issue && event.action === 'opened'
        ? 'Filed'
        : event.action === 'opened'
          ? 'PR opened'
          : event.action.charAt(0).toUpperCase() + event.action.slice(1);
    return {
      ...base,
      title: event.title,
      state,
      kind: issue ? 'issue' : 'pull-request',
      ...(event.cornerId ? { cornerId: event.cornerId } : {}),
      kindLine: `${issue ? 'Issue' : 'PR'}${number ? ` #${number}` : ''}`,
      url: event.url,
      actor: event.actor,
    };
  }
  const check = message.isSystemNotice ? message.systemEvent : undefined;
  if (check?.subject.kind !== 'github') return;
  const action = check.verb.match(/^(started|passed|failed) a check$/)?.[1];
  if (!action) {
    const url = check.object?.url;
    const target = url?.match(/\/(pull|issues)\/(\d+)(?:[/?#]|$)/);
    const kind = target?.[1] === 'pull' ? 'pull-request' : target ? 'issue' : 'notice';
    const verb = check.verb.replace(/ a pull request$/, '');
    const state = kind === 'issue' && verb === 'opened' ? 'Filed' : verb;
    return {
      ...base,
      title: check.object?.text ?? message.text,
      state,
      kind,
      kindLine: target ? `${kind === 'issue' ? 'Issue' : 'PR'} #${target[2]}` : 'GitHub',
      url,
      actor: check.subject.name,
    };
  }
  const object = check.object;
  const head = /^[a-f0-9]{40}$/i.test(object?.headSha ?? '')
    ? object!.headSha!.toLowerCase()
    : undefined;
  const repository = object?.url?.match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\//i);
  const url =
    repository && head
      ? `https://github.com/${repository[1]}/${repository[2]}/commit/${head}/checks`
      : object?.url;
  return {
    ...base,
    title: object?.text || message.text,
    kind: 'check',
    kindLine: 'Check',
    state:
      action === 'started'
        ? 'Checks running'
        : action === 'passed'
          ? 'Checks passed'
          : 'Checks failed',
    url,
    headSha: head,
    actor: check.subject.name,
  };
}

export function lifecycleSummary(items: readonly LifecycleItem[]): string {
  const counts = new Map<string, { kind: string; state: string; count: number }>();
  for (const item of items) {
    const kind =
      item.kind === 'pull-request'
        ? 'PR'
        : item.kind === 'issue'
          ? 'issue'
          : item.kind === 'check'
            ? 'check'
            : item.kind === 'payment'
              ? 'payment'
              : item.kind === 'wallet'
                ? 'wallet'
                : item.kind === 'corner'
                  ? 'corner'
                  : 'notice';
    const state = item.state.replace(/^(PR|Checks) /, '').toLowerCase();
    const key = `${kind}:${state}`;
    const group = counts.get(key) ?? { kind, state, count: 0 };
    group.count++;
    counts.set(key, group);
  }
  return [...counts.values()]
    .map(({ kind, state, count }) => `${count} ${kind}${count === 1 ? '' : 's'} ${state}`)
    .join(' · ');
}

/** Chat and actionable notices end a run. Corner closes are silent. */
export function foldPrLifecycleRuns<T extends SystemLineMessage>(messages: readonly T[]): T[] {
  const corners = new Map<string, string>();
  const canonical = (url: string) => url.split(/[?#]/)[0].replace(/\/$/, '').toLowerCase();
  for (const message of messages) {
    const fact = message.daemonFact;
    if (fact?.pullRequest?.url) corners.set(canonical(fact.pullRequest.url), fact.cornerId);
  }
  const result: T[] = [];
  let run: { anchor: T; ids: string[]; items: LifecycleItem[]; index: number } | undefined;
  for (const message of messages) {
    const fact = message.deleted ? undefined : message.daemonFact;
    if (
      (fact?.type === 'corner-complete' &&
        !fact.sourceMessageId &&
        message.systemEvent?.kind !== 'corner-opened' &&
        !(fact.outcome === 'landed' && fact.pullRequest)) ||
      fact?.type === 'worktree-cleaned'
    ) {
      // Retain hidden ids for jumps/read cursors without drawing another close notice.
      if (run) {
        run.ids.push(message.id);
        result[run.index] = { ...result[run.index], foldedIds: [...run.ids] };
      }
      continue;
    }
    const item = lifecycleItem(message);
    if (!item) {
      run = undefined;
      result.push(message);
      continue;
    }
    if (!run) {
      run = { anchor: message, ids: [], items: [], index: result.length };
      result.push(message);
    }
    run.ids.push(message.id);
    run.items.push({
      ...item,
      ...(item.url && !item.cornerId && corners.has(canonical(item.url))
        ? { cornerId: corners.get(canonical(item.url)) }
        : {}),
    });
    result[run.index] = {
      ...run.anchor,
      timestamp: message.timestamp,
      foldedIds: [...run.ids],
      notificationLifecycleRun: { items: [...run.items], subline: '' },
    };
  }
  return result;
}
