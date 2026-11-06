import { phoneFetch } from '../../../../tests/helpers/phone-operation.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { REVIEW_LOCKED_OPERATIONS } from '.././phone-service.js';
import { PushDeliveryLoop } from '.././background.js';
import { isRoomView } from '@beeline/api-contract/phone';
import { monolithFixture, HUMAN, WORKSPACE, REVIEW_SECRET, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: github-repositories', () => {
const fixture = monolithFixture();


  it('turns signed GitHub branch events into corner notes and closes a merged corner', async () => {
    fixture.processWebhook.mockImplementation((event, payload) =>
      fixture.githubOperations.processWebhook(event, payload),
    );
    await fixture.database.query(
      `INSERT INTO github_installations(
         installation_id,owner_id,account_id,account_login,account_type,repository_selection,status
       ) VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await fixture.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
       VALUES(101,77,'owner/widgets','main')`,
    );
    await fixture.database.query(
      `UPDATE rooms SET repository_key='owner/widgets',
         repository_remote='https://github.com/owner/widgets.git',
         repository_resolution='repository',github_installation_id=77 WHERE id=$1`,
      [ROOM],
    );
    const daemonRoomToken = await fixture.daemonOperation('getRoomGitHubToken', { roomId: ROOM });
    expect(daemonRoomToken.status).toBe(200);
    expect(await daemonRoomToken.json()).toMatchObject({ token: 'github-room-token' });
    const sourceMessageId = createHash('sha256').update('corner-request').digest('hex');
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Open a corner to ship the widget')`,
      [sourceMessageId, ROOM, HUMAN],
    );
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-request',
      name: 'Ship-widget',
      objective: 'Ship widget',
      repository: 'owner/widgets',
      targetBranch: 'main',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    // A corner's branch is derived from its id; nothing stores it.
    const branch = `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`;
    expect(
      (
        await fixture.daemonOperation('postCornerPlan', {
          cornerId,
          objective: 'A later plan write must not replace the fixed summary',
          items: [],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.daemonOperation('postCornerRemoteState', {
          cornerId,
          branch: branch,
          state: 'working',
          checks: 'unknown',
        })
      ).status,
    ).toBe(200);

    const base = {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
    };
    const issuePayload = {
      ...base,
      action: 'opened',
      issue: {
        number: 17,
        title: 'Handle narrow screens',
        html_url: 'https://github.com/owner/widgets/issues/17',
      },
      sender: { login: 'octocat' },
    };
    expect((await fixture.webhook('issues', 'room-issue-open', issuePayload)).status).toBe(202);
    expect((await fixture.webhook('issues', 'room-issue-open', issuePayload)).status).toBe(200);
    expect((await fixture.webhook('issues', 'room-issue-open-redelivery', issuePayload)).status).toBe(202);
    await fixture.webhook('pull_request', 'room-pr-open', {
      ...base,
      action: 'opened',
      pull_request: {
        number: 18,
        title: 'Improve documentation',
        html_url: 'https://github.com/owner/widgets/pull/18',
        head: { ref: 'docs/readme', sha: '2'.repeat(40) },
        base: { ref: 'main' },
        merged: false,
      },
      sender: { login: 'octocat' },
    });
    await fixture.webhook('issues', 'room-issue-closed-disabled', {
      ...issuePayload,
      action: 'closed',
    });
    expect(
      (
        await fixture.webhook('pull_request', 'corner-pr-open', {
          ...base,
          action: 'opened',
          pull_request: {
            number: 42,
            title: 'Ship the widget',
            html_url: 'https://github.com/owner/widgets/pull/42',
            head: { ref: branch, sha: '0'.repeat(40) },
            base: { ref: 'main' },
            mergeable_state: 'clean',
            merged: false,
          },
          sender: { login: 'octocat' },
        })
      ).status,
    ).toBe(202);
    const repositoryCards = await fixture.database.query<{ card: Record<string, unknown> }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='github-event' ORDER BY created_at`,
      [ROOM],
    );
    expect(repositoryCards.rows.map((row) => row.card)).toEqual([
      expect.objectContaining({
        type: 'issue',
        action: 'opened',
        actor: 'octocat',
        title: 'Handle narrow screens',
      }),
      expect.objectContaining({
        type: 'pull-request',
        action: 'opened',
        actor: 'octocat',
        title: 'Improve documentation',
        branch: 'docs/readme',
        targetBranch: 'main',
      }),
      expect.objectContaining({
        type: 'issue',
        action: 'closed',
        actor: 'octocat',
        title: 'Handle narrow screens',
      }),
      expect.objectContaining({
        type: 'pull-request', action: 'opened', branch: branch, cornerId,
      }),
    ]);
    // Room-level repository activity: issues and pull requests only. A
    // raw push and mainline CI never become a Room card.
    await fixture.webhook('push', 'room-push-main', {
      ...base,
      ref: 'refs/heads/main',
      after: '3'.repeat(40),
      compare: 'https://github.com/owner/widgets/compare/2...3',
      size: 2,
      commits: [{ id: 'a' }, { id: 'b' }],
      sender: { login: 'octocat' },
    });
    await fixture.webhook('check_suite', 'room-checks-main', {
      ...base,
      action: 'completed',
      check_suite: {
        id: 9,
        status: 'completed',
        conclusion: 'success',
        head_branch: 'main',
        head_sha: '3'.repeat(40),
        app: { name: 'Beeline CI' },
        url: 'https://github.com/owner/widgets/actions/runs/9',
      },
      sender: { login: 'octocat' },
    });
    const mainlineCards = await fixture.database.query<{ card: Record<string, unknown> }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='github-event'
       ORDER BY created_at`,
      [ROOM],
    );
    expect(mainlineCards.rows.map((row) => row.card)).toEqual([
      expect.objectContaining({ type: 'issue', action: 'opened' }),
      expect.objectContaining({ type: 'pull-request', action: 'opened' }),
      expect.objectContaining({ type: 'issue', action: 'closed' }),
      expect.objectContaining({ type: 'pull-request', action: 'opened', cornerId }),
    ]);
    // A push or mainline CI result on the default branch posted no card.
    expect(mainlineCards.rows.some((row) => row.card.type === 'push')).toBe(false);
    expect(mainlineCards.rows.some((row) => row.card.type === 'ci')).toBe(false);
    await fixture.webhook('push', 'corner-push', {
      ...base,
      ref: `refs/heads/${branch}`,
      after: '1'.repeat(40),
      compare: 'https://github.com/owner/widgets/compare/a...b',
      commits: [{ id: '1' }, { id: '2' }],
    });
    await fixture.webhook('check_run', 'corner-check-started', {
      ...base,
      action: 'in_progress',
      check_run: {
        id: 6,
        name: 'typecheck',
        status: 'in_progress',
        html_url: 'https://github.com/owner/widgets/actions/runs/6',
        check_suite: { head_branch: branch, head_sha: '1'.repeat(40) },
      },
    });
    Object.assign(fixture.githubApp, {
      readPullRequest: vi.fn(async () => ({
        number: 42,
        url: 'https://github.com/owner/widgets/pull/42',
        headSha: '1'.repeat(40),
        headRef: branch,
        merged: false,
        mergeability: 'clean',
      })),
    });
    fixture.githubRollupState = 'failed';
    await fixture.webhook('check_suite', 'corner-checks-failed', {
      ...base,
      action: 'completed',
      check_suite: {
        id: 7,
        status: 'completed',
        conclusion: 'failure',
        head_branch: branch,
        head_sha: '1'.repeat(40),
        app: { name: 'Beeline CI' },
        url: 'https://github.com/owner/widgets/actions/runs/7',
      },
    });
    // The owner's yes on a red head is kept, and nothing merges until the
    // head is green: there is no force past failing checks.
    const redApproval = await fixture.request('/v1/phone/operations/approveCornerMerge', 'POST', {
      cornerId,
    });
    expect(await redApproval.json()).toEqual({
      status: 'merge-requested',
      pullRequestUrl: 'https://github.com/owner/widgets/pull/42',
    });
    expect(
      await (await fixture.daemonOperation('getCornerRestoreState', { cornerId })).json(),
    ).toMatchObject({
      mergeApproval: { pullRequestNumber: 42, headSha: '1'.repeat(40) },
    });
    expect(fixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
    await fixture.database.query(
      `UPDATE corner_facts
       SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}',to_jsonb($2::text))
       WHERE corner_id=$1`,
      [cornerId, '2'.repeat(40)],
    );
    expect(
      await (await fixture.daemonOperation('getCornerRestoreState', { cornerId })).json(),
    ).toMatchObject({
      lifecycle: { pr: { number: 42, headSha: '2'.repeat(40) } },
      mergeApproval: { pullRequestNumber: 42, headSha: '1'.repeat(40) },
    });
    await fixture.database.query(
      `UPDATE corner_facts
       SET lifecycle=jsonb_set(lifecycle,'{pr,headSha}',to_jsonb($2::text))
       WHERE corner_id=$1`,
      [cornerId, '1'.repeat(40)],
    );
    fixture.githubRollupState = 'passed';
    await fixture.webhook('check_suite', 'corner-checks-passed', {
      ...base,
      action: 'completed',
      check_suite: {
        id: 7,
        status: 'completed',
        conclusion: 'success',
        head_branch: branch,
        head_sha: '1'.repeat(40),
        app: { name: 'Beeline CI' },
        url: 'https://github.com/owner/widgets/actions/runs/8',
      },
    });
    await fixture.webhook('check_run', 'corner-check-passed', {
      ...base,
      action: 'completed',
      check_run: {
        id: 6,
        name: 'typecheck',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/owner/widgets/actions/runs/6',
        check_suite: { head_branch: branch, head_sha: '1'.repeat(40) },
      },
    });
    await fixture.webhook('status', 'corner-checks-passed', {
      ...base,
      state: 'success',
      sha: '1'.repeat(40),
      target_url: 'https://github.com/owner/widgets/actions/runs/8',
      branches: [{ name: branch }],
    });
    const cornerBeforeMerge = (await (await fixture.request(`/v1/phone/rooms/${cornerId}`)).json()) as {
      messages: Array<{ text: string; presentation: string }>;
      cornerLifecycle: {
        checks: string;
        pr: { url: string; mergeability: string };
        checksSummary: { failing: string[]; checks: Array<{ name: string; status: string }> };
      };
    };
    expect(cornerBeforeMerge.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          presentation: 'system',
          text: '@octocat opened a pull request Ship the widget',
          systemEvent: {
            subject: { kind: 'github', name: '@octocat' },
            verb: 'opened a pull request',
            object: { text: 'Ship the widget', url: 'https://github.com/owner/widgets/pull/42' },
          },
        }),
        expect.objectContaining({
          text: expect.stringMatching(/^@GitHub pushed 2 commits to feature\/corner-[0-9a-f]{12} · at [0-9a-f]{12}$/),
        }),
        expect.objectContaining({
          text: '@GitHub found failing checks on Ship the widget · failing typecheck',
          systemEvent: expect.objectContaining({ verb: 'found failing checks on' }),
        }),
        expect.objectContaining({
          text: '@GitHub passed a check Beeline CI check suite',
          systemEvent: expect.objectContaining({
            kind: 'check-passed',
            verb: 'passed a check',
            object: expect.objectContaining({
              text: 'Beeline CI check suite',
              headSha: '1'.repeat(40),
            }),
          }),
        }),
      ]),
    );
    // B3 retains whole-head green/failure notes and suppresses per-check chatter.
    expect(cornerBeforeMerge.messages.some(message => message.text.startsWith('@GitHub started a check'))).toBe(false);
    expect(cornerBeforeMerge.messages.some(message => message.text === '@GitHub passed a check typecheck')).toBe(false);
    // No system line carries a colon, an em dash, a trailing period, or a URL.
    for (const message of cornerBeforeMerge.messages.filter((m) => m.presentation === 'system')) {
      expect(message.text).not.toMatch(/[:—]|\.$|https?:\/\//);
    }
    expect(cornerBeforeMerge.cornerLifecycle).toMatchObject({
      checks: 'passing',
      pr: { url: 'https://github.com/owner/widgets/pull/42', mergeability: 'clean' },
      checksSummary: {
        failing: [],
        checks: expect.arrayContaining([
          expect.objectContaining({ name: 'typecheck', status: 'passed' }),
        ]),
      },
    });
    expect(
      (
        await fixture.daemonOperation('postCornerRemoteState', {
          cornerId,
          branch: branch,
          state: 'working',
          checks: 'unknown',
        })
      ).status,
    ).toBe(200);
    const cornerAfterDaemonRestart = (await (
      await fixture.request(`/v1/phone/rooms/${cornerId}`)
    ).json()) as {
      cornerLifecycle: {
        lifecycle: string;
        checks: string;
        pr?: { url: string; mergeability?: string };
        checksSummary?: { status: string; checks: Array<{ name: string; status: string }> };
      };
    };
    expect(cornerAfterDaemonRestart.cornerLifecycle).toMatchObject({
      lifecycle: 'in-review',
      checks: 'passing',
      pr: { url: 'https://github.com/owner/widgets/pull/42', mergeability: 'clean' },
      checksSummary: {
        status: 'passing',
        checks: expect.arrayContaining([
          expect.objectContaining({ name: 'typecheck', status: 'passed' }),
        ]),
      },
    });
    // Corners hit by the pre-fix restart have already lost their PR payload. The next
    // pull-request webhook must recover them by their durable feature branch.
    await fixture.database.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
      cornerId,
      JSON.stringify({ branch: branch, checks: 'unknown', lifecycle: 'working' }),
    ]);
    await fixture.webhook('pull_request', 'corner-pr-recovery', {
      ...base,
      action: 'synchronize',
      pull_request: {
        number: 42,
        title: 'Ship the widget',
        html_url: 'https://github.com/owner/widgets/pull/42',
        head: { ref: branch, sha: '1'.repeat(40) },
        base: { ref: 'main' },
        mergeable_state: 'clean',
        merged: false,
      },
    });
    const cornerAfterWebhookRecovery = (await (
      await fixture.request(`/v1/phone/rooms/${cornerId}`)
    ).json()) as {
      cornerLifecycle: { lifecycle: string; pr?: { url: string; mergeability?: string } };
    };
    expect(cornerAfterWebhookRecovery.cornerLifecycle).toMatchObject({
      lifecycle: 'in-review',
      pr: { url: 'https://github.com/owner/widgets/pull/42', mergeability: 'clean' },
    });
    expect(
      (
        await fixture.database.query<{ text: string }>(
          `SELECT text FROM messages
           WHERE room_id=$1 AND system_event->>'kind'='check-passed'
             AND text='@GitHub passed a check Beeline CI check suite'`,
          [cornerId],
        )
      ).rows,
    ).toEqual([
      {
        text: '@GitHub passed a check Beeline CI check suite',
      },
    ]);

    const duplicateApproval = await fixture.request('/v1/phone/operations/approveCornerMerge', 'POST', {
      cornerId,
    });
    expect(await duplicateApproval.json()).toEqual({
      status: 'already-requested',
      pullRequestUrl: 'https://github.com/owner/widgets/pull/42',
    });
    // Green now: the same yes merges the exact head through landCorner.
    expect(fixture.githubApp.mergePullRequest).toHaveBeenCalledOnce();
    expect(fixture.githubApp.mergePullRequest).toHaveBeenCalledWith(
      77,
      101,
      'owner/widgets',
      42,
      '1'.repeat(40),
    );

    const deviceToken = 'github-merge-device-token-1234567890';
    await fixture.database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
       VALUES($1,$2,'android','physical')`,
      [deviceToken, HUMAN],
    );
    const send = vi.fn().mockResolvedValue(undefined);
    const pushes = new PushDeliveryLoop(fixture.database, { send });
    expect(await pushes.runOnce()).toBe(0);
    const mergedPayload = {
      ...base,
      action: 'closed',
      pull_request: {
        number: 42,
        title: 'Ship the widget',
        html_url: 'https://github.com/owner/widgets/pull/42',
        head: { ref: branch, sha: '1'.repeat(40) },
        base: { ref: 'main' },
        merged: true,
        merged_at: '2026-09-02T14:00:00Z',
        merge_commit_sha: 'f'.repeat(40),
        merged_by: { login: 'owner' },
        commits: 3,
        changed_files: 5,
      },
    };
    expect((await fixture.webhook('pull_request', 'corner-pr-merged', mergedPayload)).status).toBe(202);
    expect(
      (
        (await (await fixture.daemonOperation('listRoomCorners', { roomId: ROOM })).json()) as {
          corners: {
            cornerId: string;
            pullRequestNumber?: number;
            mergeCommitSha?: string;
            closedAt?: number;
          }[];
        }
      ).corners.find((corner) => corner.cornerId === cornerId),
    ).toEqual(
      expect.objectContaining({
        pullRequestNumber: 42,
        mergeCommitSha: 'f'.repeat(40),
        closedAt: expect.any(Number),
      }),
    );
    expect(
      (await fixture.webhook('pull_request', 'corner-pr-merged-semantic-retry', mergedPayload)).status,
    ).toBe(202);
    // The normal PR event reports the landing once, even when GitHub retries.
    expect(await pushes.runOnce()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(await pushes.runOnce()).toBe(0);
    expect(
      (
        await fixture.database.query<{ count: number }>(
          `SELECT count(*)::int count FROM messages
           WHERE room_id=$1 AND card_type='daemon-fact' AND card->>'type'='corner-complete'`,
          [ROOM],
        )
      ).rows[0]?.count,
    ).toBe(0);
    // The opener never subscribed to merged and gets no turn from it.
    expect(
      (
        await fixture.database.query(
          `SELECT command.agent_id FROM agent_commands command
           JOIN messages source ON source.id=command.source_message_id
           WHERE command.room_id=$1 AND source.card_type='daemon-fact'
             AND source.card->>'type'='corner-complete'`,
          [ROOM],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await fixture.database.query<{ count: number }>(
          `SELECT count(*)::int count FROM messages
           WHERE room_id=$1 AND card_type='github-event'
             AND card->>'type'='pull-request' AND card->>'action'='merged'`,
          [ROOM],
        )
      ).rows[0]?.count,
    ).toBe(1);
    const close = await fixture.daemonOperation('getCornerCloseRequests', { cornerId });
    expect(close.status).toBe(200);
    expect(await close.json()).toMatchObject({ closeRequested: true });
    const closedTranscript = await fixture.daemonOperation('getRoomConversation', { roomId: cornerId });
    expect((await closedTranscript.json()).items).toContainEqual(
      expect.objectContaining({ body: '@owner merged Ship the widget' }),
    );
    const parent = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      messages: Array<{
        text: string;
        presentation: string;
        daemonFact?: {
          type: string;
          cornerId: string;
          name?: string;
          objective: string;
          outcome?: string;
          pullRequest?: { number?: number; title?: string; url: string; targetBranch?: string };
        };
      }>;
    };
    expect(parent.messages.filter((message) => message.daemonFact?.cornerId === cornerId)).toEqual([
      expect.objectContaining({ daemonFact: expect.objectContaining({
        type: 'corner-open', cornerId, name: 'Ship-widget', objective: 'Ship-widget',
      }) }),
    ]);
    expect(parent.messages).toContainEqual(expect.objectContaining({
      githubEvent: expect.objectContaining({ type: 'pull-request', action: 'merged', cornerId }),
    }));
    const listed = (await (await fixture.request(`/v1/phone/rooms/${ROOM}/corners`)).json()) as {
      corners: Array<{ corner: { id: string; about?: string }; state: string }>;
    };
    expect(listed.corners.find((item) => item.corner.id === cornerId)).toBeUndefined();
    const archived = (await (
      await fixture.request(`/v1/phone/rooms/${ROOM}/corners?archived=1`)
    ).json()) as {
      corners: Array<{ corner: { id: string }; state: string; closedAt?: number }>;
    };
    expect(archived.corners).toContainEqual(
      expect.objectContaining({
        corner: expect.objectContaining({ id: cornerId }),
        state: 'archived',
        closedAt: expect.any(Number),
      }),
    );
    expect(
      (
        await fixture.database.query<{ archived: boolean }>(
          `SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`,
          [cornerId],
        )
      ).rows[0]?.archived,
    ).toBe(true);
    expect(
      (
        await fixture.database.query<{
          approved_by: string;
          pull_request_number: number;
          head_sha: string;
        }>(
          `SELECT approved_by,pull_request_number,head_sha
           FROM corner_merge_approvals WHERE corner_id=$1`,
          [cornerId],
        )
      ).rows[0],
    ).toEqual({
      approved_by: HUMAN,
      pull_request_number: 42,
      head_sha: '1'.repeat(40),
    });
    const approvalAfterMerge = await fixture.request('/v1/phone/operations/approveCornerMerge', 'POST', {
      cornerId,
    });
    expect(await approvalAfterMerge.json()).toEqual({
      status: 'already-merged',
      pullRequestUrl: 'https://github.com/owner/widgets/pull/42',
    });
    expect(fixture.githubApp.deleteBranch).toHaveBeenCalledWith(77, 101, 'owner/widgets', branch);
  });


  it('keeps the phone GitHub repository contract aligned through the real HTTP surface', async () => {
    await fixture.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,account_avatar_url,repository_selection,status) VALUES(77,$1,'42','owner','User','https://avatars.test/owner','selected','active')`,
      [HUMAN],
    );
    await fixture.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,private) VALUES(101,77,'owner/widgets','trunk',false)`,
    );

    const listed = await fixture.request('/v1/phone/operations/listGitHubRepositories', 'POST', {});
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      installed: true,
      installations: [
        {
          installationId: 77,
          accountId: '42',
          accountLogin: 'owner',
          accountType: 'User',
          accountAvatarUrl: 'https://avatars.test/owner',
          repositorySelection: 'selected',
          status: 'active',
          repositoryCount: 1,
          manageUrl: 'https://github.com/settings/installations/77',
        },
      ],
      repositories: [
        {
          id: 101,
          fullName: 'owner/widgets',
          installationId: 77,
          defaultBranch: 'trunk',
          private: false,
        },
      ],
    });

    const begun = await fixture.request('/v1/phone/operations/beginGitHubInstallation', 'POST', {
      redirectUri: 'beeline://buzz/github-installation',
    });
    expect(begun.status).toBe(200);
    expect(await begun.json()).toEqual({
      url: 'https://github.com/apps/beeline-test/installations/new?state=server-state',
    });

    const created = await fixture.request('/v1/phone/operations/createGitHubRepository', 'POST', {
      installationId: 77,
      name: 'new-repo',
      private: true,
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({
      id: 102,
      fullName: 'owner/new-repo',
      installationId: 77,
      defaultBranch: 'main',
      private: true,
    });

    const linked = await fixture.request('/v1/phone/operations/setRoomRepository', 'POST', {
      roomId: ROOM,
      key: 'github:101',
      name: 'owner/widgets',
      remote: 'git://github.com/owner/widgets',
      targetBranch: 'trunk',
      githubInstallationId: 77,
    });
    expect(linked.status).toBe(200);
    expect(await linked.json()).toEqual(
      expect.objectContaining({
        channelId: ROOM,
        binding: {
          key: 'github:101',
          name: 'owner/widgets',
          remote: 'git://github.com/owner/widgets',
          localOnly: false,
          githubInstallationId: 77,
        },
        targetBranch: 'trunk',
        githubEventsEnabled: true,
        source: 'config',
      }),
    );

    const targeted = await fixture.request('/v1/phone/operations/setRoomTargetBranch', 'POST', {
      roomId: ROOM,
      targetBranch: 'release',
    });
    expect(targeted.status).toBe(200);
    expect((await targeted.json()).targetBranch).toBe('release');

    const room = await fixture.request(`/v1/phone/rooms/${ROOM}`);
    expect((await room.json()).repository).toEqual(
      expect.objectContaining({
        key: 'github:101',
        name: 'owner/widgets',
        targetBranch: 'release',
        githubEventsEnabled: true,
      }),
    );

    const invalid = await fixture.request('/v1/phone/operations/setRoomRepository', 'POST', {
      roomId: ROOM,
      key: 'github:999',
      name: 'owner/not-installed',
      remote: 'git://github.com/owner/not-installed',
      targetBranch: 'main',
      githubInstallationId: 77,
    });
    expect(invalid.status).toBe(403);
    expect(await invalid.json()).toEqual({
      error: 'GitHub repository access denied',
    });

    // Unassigning severs the binding and returns the Room to chat-only; the
    // Room, its messages, and any corner copies of the repo are untouched.
    // The authority axis mirrors assign: a plain member is refused.
    const memberToken = await fixture.phoneToken('repo-member');
    const memberId = createHash('sha256').update('github:repo-member').digest('hex');
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, memberId, ROOM],
    );
    const refusedUnassign = await fixture.operation('removeRoomRepository', { roomId: ROOM }, memberToken);
    expect(refusedUnassign.status).toBe(403);

    const unassigned = await fixture.request('/v1/phone/operations/removeRoomRepository', 'POST', {
      roomId: ROOM,
    });
    expect(unassigned.status).toBe(204);
    const chatOnly = await fixture.request(`/v1/phone/rooms/${ROOM}`);
    const chatOnlyView = (await chatOnly.json()) as {
      repository?: unknown;
      repositoryResolution: string;
    };
    expect(chatOnlyView.repository).toBeUndefined();
    expect(chatOnlyView.repositoryResolution).toBe('none');

    // A double unassign is idempotent: a retried call still succeeds.
    const again = await fixture.request('/v1/phone/operations/removeRoomRepository', 'POST', {
      roomId: ROOM,
    });
    expect(again.status).toBe(204);

    // Reassigning the same repository afterwards works.
    const relinked = await fixture.request('/v1/phone/operations/setRoomRepository', 'POST', {
      roomId: ROOM,
      key: 'github:101',
      name: 'owner/widgets',
      remote: 'git://github.com/owner/widgets',
      targetBranch: 'main',
      githubInstallationId: 77,
    });
    expect(relinked.status).toBe(200);
    expect((await relinked.json()).binding).toEqual(
      expect.objectContaining({ key: 'github:101', name: 'owner/widgets' }),
    );
  });


  it("surfaces a Room repository's auto-merge setting live, independent of its reviewer", async () => {
    await fixture.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
       VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await fixture.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,allow_auto_merge)
       VALUES(101,77,'owner/widgets','main',false)`,
    );
    await fixture.database.query(
      `UPDATE rooms SET repository_key='github:101',repository_name='owner/widgets',
         repository_remote='git://github.com/owner/widgets',repository_resolution='repository',
         github_installation_id=77 WHERE id=$1`,
      [ROOM],
    );

    const before = await fixture.request(`/v1/phone/rooms/${ROOM}`);
    const beforeView = await before.json();
    expect(isRoomView(beforeView)).toBe(true);
    expect(beforeView.repository).toEqual(
      expect.objectContaining({ key: 'github:101', allowAutoMerge: false }),
    );

    // GitHub's auto-merge toggle changes on its own, with nobody touching the
    // Room's reviewer. The Room read reflects the current fact immediately.
    await fixture.database.query(
      `UPDATE github_repositories SET allow_auto_merge=true WHERE repository_id=101`,
    );

    const after = await fixture.request(`/v1/phone/rooms/${ROOM}`);
    const afterView = await after.json();
    expect(isRoomView(afterView)).toBe(true);
    expect(afterView.repository).toEqual(
      expect.objectContaining({ key: 'github:101', allowAutoMerge: true }),
    );
  });


  it('completes the GitHub App callback on the monolith route', async () => {
    const response = await phoneFetch(
      `${fixture.origin}/v1/github/install/callback?state=server-state&installation_id=77`,
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('beeline://buzz/github-installation?installed=1');
    expect(fixture.completeInstallation).toHaveBeenCalledWith('server-state', 77);
  });


  it('refuses the review identity every GitHub and repository write', async () => {
    const session = (await (await fixture.redeemReview(REVIEW_SECRET)).json()) as { accessToken: string };
    const lockedOperations = [
      ['actOnRepositoryCard', { roomId: ROOM, cardId: 'a'.repeat(64), action: 'refresh' }],
      ['beginGitHubInstallation', {}],
      ['createGitHubRepository', { installationId: 1, name: 'demo' }],
      [
        'setRoomRepository',
        {
          roomId: ROOM,
          key: 'github:1',
          name: 'a/b',
          remote: 'git://github.com/a/b',
          targetBranch: 'main',
        },
      ],
      ['removeRoomRepository', { roomId: ROOM }],
      ['beginGitHubIdentityBind', {}],
      ['completeGitHubIdentityBind', {}],
      ['recoverGitHubIdentity', {}],
      ['adoptGitHubHandle', {}],
      ['dispatchRoomWorkflow', { roomId: ROOM, workflowName: 'Release' }],
    ] as const;
    expect(REVIEW_LOCKED_OPERATIONS).toEqual(new Set(lockedOperations.map(([name]) => name)));
    for (const [name, payload] of lockedOperations) {
      const refused = await fixture.operation(name, payload, session.accessToken);
      expect([refused.status, name]).toEqual([403, name]);
    }
  });
});
