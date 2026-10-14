import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';
import { foldPrLifecycleRuns } from '../sources/buzz/pr-lifecycle';
const base = {
  text: '',
  isUser: false,
  timestamp: 1791991980,
  authorIdentity: { pubkey: 'ruby', kind: 'agent' as const, name: 'Ruby', handle: 'ruby' },
};
function corner(
  id: string,
  type: NonNullable<ChatDisplayMessage['daemonFact']>['type'],
  pr = false,
  outcome: 'landed' | 'abandoned' = 'landed',
): ChatDisplayMessage {
  return {
    ...base,
    id,
    daemonFact: {
      type,
      cornerId: id,
      name: id,
      objective: 'Keep lifecycle navigation and status consistent.',
      ...(type === 'corner-complete' ? { outcome } : {}),
      ...(pr
        ? {
            pullRequest: {
              number: 2468,
              title: 'Align lifecycle cards',
              url: 'https://github.com/Beeline-Work/beeline/pull/2468',
            },
          }
        : {}),
    },
  };
}
function github(id: string, type: string, action: string): ChatDisplayMessage {
  return {
    ...base,
    id,
    githubEvent: {
      type,
      action,
      actor: 'octocat',
      title: 'Align lifecycle cards',
      url: `https://github.com/Beeline-Work/beeline/${type === 'issue' ? 'issues' : 'pull'}/2468`,
    },
  };
}
function check(result: 'started' | 'passed' | 'failed'): ChatDisplayMessage {
  return foldPrLifecycleRuns([
    {
      ...base,
      id: `check-${result}`,
      isSystemNotice: true,
      systemEvent: {
        subject: { kind: 'github', name: 'GitHub' },
        verb: `${result} a check`,
        object: {
          text: 'TYPECHECK',
          headSha: 'a'.repeat(40),
          url: 'https://github.com/Beeline-Work/beeline/actions/runs/38607472993',
        },
      },
    },
  ])[0];
}
const merged = corner('merged-pr', 'corner-complete', true);
// A card written before corners had names: no name, a long objective and a PR title.
const legacy: ChatDisplayMessage = {
  ...merged,
  id: 'legacy-named-pr',
  daemonFact: {
    ...merged.daemonFact!,
    cornerId: 'legacy-named-pr',
    name: undefined,
    objective: 'Keep every lifecycle card consistent across both platforms',
  },
};
const opened = corner('opened-corner', 'corner-open');
export const lifecycleFixtures: { name: string; message: ChatDisplayMessage; expand?: boolean }[] =
  [
    { name: 'corner-open-no-pr', message: opened },
    { name: 'corner-open-pr', message: corner('opened-pr', 'corner-open', true) },
    { name: 'corner-merged-pr', message: merged },
    { name: 'corner-merged-no-pr', message: corner('legacy-merged', 'corner-complete') },
    {
      name: 'corner-closed-pr',
      message: corner('closed-pr', 'corner-complete', true, 'abandoned'),
    },
    {
      name: 'corner-closed-no-pr',
      message: corner('closed-corner', 'corner-complete', false, 'abandoned'),
    },
    { name: 'worktree-cleaned', message: corner('cleaned-corner', 'worktree-cleaned') },
    { name: 'corner-checks-failing', message: corner('failing-corner', 'checks-failing', true) },
    ...['opened', 'merged', 'closed'].map((action) => ({
      name: `github-pr-${action}`,
      message: github(`pr-${action}`, 'pull-request', action),
    })),
    ...['opened', 'closed'].map((action) => ({
      name: `github-issue-${action}`,
      message: github(`issue-${action}`, 'issue', action),
    })),
    { name: 'grouped-corners', message: foldPrLifecycleRuns([opened, merged])[0] },
    { name: 'grouped-expanded', message: foldPrLifecycleRuns([opened, merged])[0], expand: true },
    {
      name: 'group-of-one',
      message: foldPrLifecycleRuns([merged, { ...merged, id: 'merged-update' }])[0],
    },
    { name: 'corner-merged-pr-nameless', message: legacy },
    {
      name: 'nameless-group-of-one',
      message: foldPrLifecycleRuns([legacy, { ...legacy, id: 'legacy-update' }])[0],
    },
    {
      name: 'issue-group-of-one',
      message: foldPrLifecycleRuns([
        github('issue-opened', 'issue', 'opened'),
        github('issue-opened-update', 'issue', 'opened'),
      ])[0],
    },
    {
      name: 'grouped-issues',
      message: foldPrLifecycleRuns([
        github('issue-a', 'issue', 'opened'),
        {
          ...github('issue-b', 'issue', 'closed'),
          githubEvent: {
            ...github('issue-b', 'issue', 'closed').githubEvent!,
            url: 'https://github.com/Beeline-Work/beeline/issues/2400',
          },
        },
      ])[0],
    },
    {
      name: 'mixed-activity',
      message: foldPrLifecycleRuns([opened, github('issue-mixed', 'issue', 'closed')])[0],
    },
    ...(['started', 'passed', 'failed'] as const).map((result) => ({
      name: `check-${result}`,
      message: check(result),
    })),
  ];
