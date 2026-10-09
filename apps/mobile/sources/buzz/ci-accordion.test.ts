import { describe, expect, it } from 'vitest';
import { foldPrLifecycleRuns } from './pr-lifecycle';
import type { ChatDisplayMessage } from './room-view-presentation';
import { boundaryRowIndex, messageBoundaryIds } from './room-new-message-boundary';
import { newestVisibleMessageId } from './read-cursor-advance';

function check(
  id: string,
  name = 'SERVER SUITE',
  action = 'started',
  repository = 'acme/repo',
  head = 'a'.repeat(40),
): ChatDisplayMessage {
  return {
    id,
    text: `GitHub ${action} a check ${name}`,
    timestamp: 100,
    isUser: false,
    isSystemNotice: true,
    systemEvent: {
      subject: { kind: 'github', name: 'GitHub' },
      verb: `${action} a check`,
      object: { text: name, headSha: head, url: `https://github.com/${repository}/actions/runs/1` },
    },
  };
}
describe('Reproduction CI-ACCORDION-1', () => {
  it('shows twenty checks once at their latest state for forty events, keeping every anchor', () => {
    const messages = [
      ...Array.from({ length: 20 }, (_, i) => check(`start-${i}`, `CHECK ${i}`)),
      ...Array.from({ length: 20 }, (_, i) =>
        check(`end-${i}`, `CHECK ${i}`, i % 2 ? 'failed' : 'passed'),
      ),
    ];
    const rows = foldPrLifecycleRuns(messages);
    expect(rows).toHaveLength(1);
    const items = rows[0].notificationLifecycleRun!.items;
    expect(items).toHaveLength(20);
    expect(items.filter((item) => item.state === 'Checks passed')).toHaveLength(10);
    expect(items.filter((item) => item.state === 'Checks failed')).toHaveLength(10);
    expect(messageBoundaryIds(rows[0])).toEqual(messages.map((message) => message.id));
    expect(boundaryRowIndex(rows, 'end-19')).toBe(0);
    expect(newestVisibleMessageId(rows, rows)).toBe('end-19');
    const partitioned = [
      ...foldPrLifecycleRuns(messages.slice(0, 20)),
      ...foldPrLifecycleRuns(messages.slice(20)),
    ];
    expect(partitioned.map((row) => row.id)).toEqual(['start-0', 'end-0']);
  });
  it('distinguishes repositories, exact heads and exact check names, not shared target URLs', () => {
    const rows = foldPrLifecycleRuns([
      check('1'),
      check('2', 'MOBILE SUITE'),
      check('3', 'SERVER SUITE', 'started', 'other/repo'),
      check('4', 'SERVER SUITE', 'started', 'acme/repo', 'b'.repeat(40)),
      check('5', 'server suite'),
      check('6', 'SERVER SUITE', 'passed', 'ACME/REPO', 'A'.repeat(40)),
    ]);
    expect(rows[0].notificationLifecycleRun!.items).toHaveLength(5);
    expect(rows[0].notificationLifecycleRun!.items[0]).toMatchObject({
      id: '1',
      updatedBy: '6',
      state: 'Checks passed',
    });
  });
  it('preserves failure details and the latest check URL', () => {
    const failed = check('2', 'SERVER SUITE', 'failed');
    failed.systemEvent = {
      ...failed.systemEvent!,
      consequence: 'cancelled',
      object: {
        ...failed.systemEvent!.object!,
        url: 'https://github.com/acme/repo/actions/runs/2',
      },
    };
    expect(
      foldPrLifecycleRuns([check('1'), failed])[0].notificationLifecycleRun!.items[0],
    ).toMatchObject({
      id: '1',
      title: 'SERVER SUITE',
      state: 'Checks failed',
      kindLine: 'Check · aaaaaaa · cancelled',
      url: failed.systemEvent.object!.url,
    });
  });
  it('keeps mixed check notes in one card, including legacy API URLs and missing metadata', () => {
    const suite = check('suite', 'GitHub Actions check suite', 'passed');
    suite.systemEvent!.object!.url = 'https://api.github.com/repos/acme/repo/check-suites/42';
    const noUrl = check('no-url', 'COMMIT STATUS', 'passed');
    noUrl.systemEvent!.object!.url = undefined;
    const noHead = check('no-head', 'EXTERNAL CI', 'started');
    noHead.systemEvent!.object!.headSha = undefined;
    const noName = check('no-name', 'UNNAMED CI', 'started');
    noName.systemEvent!.object!.text = '';
    const messages = [check('server'), suite, noUrl, noHead, noName, check('mobile', 'MOBILE SUITE')];
    const rows = foldPrLifecycleRuns(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0].foldedIds).toEqual(messages.map((message) => message.id));
    expect(rows[0].notificationLifecycleRun?.items).toHaveLength(6);
    expect(rows[0].notificationLifecycleRun?.items.find((item) => item.updatedBy === 'suite')).toMatchObject({
      title: 'GitHub Actions check suite',
      url: `https://github.com/acme/repo/commit/${'a'.repeat(40)}/checks`,
    });
  });
  it.each([
    'chat',
    'notice',
    'deleted',
    'non-github',
    'other-verb',
    'reports',
    'issue',
    'pr',
  ])('keeps %s as a boundary', (kind) => {
    const boundary = check('boundary');
    if (kind === 'chat') {
      boundary.isSystemNotice = false;
      boundary.text = 'Hello';
    }
    if (kind === 'notice')
      boundary.systemEvent = {
        subject: { kind: 'system', name: 'Beeline' },
        verb: 'saved a brief',
      };
    if (kind === 'deleted') boundary.deleted = true;
    if (kind === 'non-github')
      boundary.systemEvent = {
        ...boundary.systemEvent!,
        subject: { kind: 'agent', name: 'Agent' },
      };
    if (kind === 'other-verb')
      boundary.systemEvent = { ...boundary.systemEvent!, verb: 'ran a workflow' };
    if (kind === 'reports') boundary.relayReports = [check('report')];
    if (kind === 'issue' || kind === 'pr') {
      boundary.systemEvent = undefined;
      boundary.githubEvent = {
        type: kind === 'pr' ? 'pull-request' : 'issue',
        action: 'opened',
        title: 'Change',
        actor: 'octocat',
        url: `https://github.com/acme/repo/${kind === 'pr' ? 'pull' : 'issues'}/1`,
      };
    }
    const rows = foldPrLifecycleRuns([check('1'), boundary, check('3', 'SERVER SUITE', 'passed')]);
    expect(rows.map((row) => row.id)).toEqual(['1', 'boundary', '3']);
    if (kind !== 'pr' && kind !== 'issue') expect(rows[1]).toBe(boundary);
  });
});
