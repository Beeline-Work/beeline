import { phoneFetch } from '../../../../tests/helpers/phone-operation.js';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenAuth } from '.././auth.js';
import { PhoneService } from '.././phone-service.js';
import { GitHubHttpError } from '@beeline/auth/github';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: github-repositories', () => {
const fixture = monolithFixture();


  it('creates Rooms with or without an installed repository binding', async () => {
    await fixture.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_login,account_type) VALUES(42,$1,'owner','User')`,
      [HUMAN],
    );
    await fixture.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(77,42,'owner/worker','trunk')`,
    );

    const plain = await fixture.request('/v1/phone/operations/createRoom', 'POST', {
      workspaceId: WORKSPACE,
      name: 'plain-room',
    });
    expect(plain.status).toBe(200);
    const plainId = ((await plain.json()) as { id: string }).id;
    expect(
      (await new PhoneService(fixture.database, fixture.origin).readRoom(plainId, HUMAN))?.repository,
    ).toBeUndefined();
    expect(
      (
        await fixture.database.query<{
          repository_key: string | null;
          repository_remote: string | null;
          github_installation_id: string | null;
        }>(
          `SELECT repository_key,repository_remote,github_installation_id FROM rooms WHERE id=$1`,
          [plainId],
        )
      ).rows[0],
    ).toEqual({
      repository_key: null,
      repository_remote: null,
      github_installation_id: null,
    });

    const bound = await fixture.request('/v1/phone/operations/createRoom', 'POST', {
      workspaceId: WORKSPACE,
      name: 'repository-room',
      repositoryId: 77,
    });
    expect(bound.status).toBe(200);
    const boundId = ((await bound.json()) as { id: string }).id;
    expect((await new PhoneService(fixture.database, fixture.origin).readRoom(boundId, HUMAN))?.repository).toEqual(
      expect.objectContaining({
        key: 'github:77',
        name: 'owner/worker',
        remote: 'git://github.com/owner/worker',
        targetBranch: 'trunk',
        githubInstallationId: 42,
      }),
    );
    const chats = (await (await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
      chats: Array<{ room: { id: string }; repositoryName?: string }>;
    };
    expect(chats.chats.find((item) => item.room.id === boundId)?.repositoryName).toBe(
      'owner/worker',
    );
  });


  it('defaults a new Room to its repository visibility unless the client chooses one', async () => {
    await fixture.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_login,account_type) VALUES(42,$1,'owner','User')`,
      [HUMAN],
    );
    await fixture.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,private)
       VALUES(77,42,'owner/secret','main',true),(78,42,'owner/open','main',false),
             (79,42,'owner/unknown','main',NULL)`,
    );
    const visibilityOf = async (body: Record<string, unknown>) => {
      const created = await fixture.request('/v1/phone/operations/createRoom', 'POST', {
        workspaceId: WORKSPACE,
        ...body,
      });
      expect(created.status).toBe(200);
      const { id } = (await created.json()) as { id: string };
      return (
        await fixture.database.query<{ visibility: string }>(`SELECT visibility FROM rooms WHERE id=$1`, [
          id,
        ])
      ).rows[0]?.visibility;
    };

    expect(await visibilityOf({ name: 'no-repo' })).toBe('public');
    expect(await visibilityOf({ name: 'private-repo', repositoryId: 77 })).toBe('invite-only');
    expect(await visibilityOf({ name: 'public-repo', repositoryId: 78 })).toBe('public');
    expect(await visibilityOf({ name: 'unknown-repo', repositoryId: 79 })).toBe('invite-only');
    expect(
      await visibilityOf({ name: 'private-made-public', repositoryId: 77, visibility: 'public' }),
    ).toBe('public');
    expect(
      await visibilityOf({
        name: 'public-made-private',
        repositoryId: 78,
        visibility: 'invite-only',
      }),
    ).toBe('invite-only');
  });


  it('moves colliding agents on join and preserves a human handle when their GitHub login changes', async () => {
    const directMember = 'd'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Direct member','bee')`,
      [directMember],
    );
    expect(
      (
        await fixture.operation('addWorkspaceMember', {
          workspaceId: WORKSPACE,
          memberId: directMember,
          role: 'member',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.database.query<{ handle: string }>(`SELECT handle FROM identities WHERE id=$1`, [
          AGENT,
        ])
      ).rows[0]?.handle,
    ).toBe('bee_2');

    const invite = (await (await fixture.operation('createInvite', { workspaceId: WORKSPACE })).json()) as {
      token: string;
    };
    const invitee = await fixture.phoneToken('bee_2');
    expect(
      (await fixture.request('/v1/phone/operations/redeemInvite', 'POST', { token: invite.token }, invitee))
        .status,
    ).toBe(200);
    expect(
      (
        await fixture.database.query<{ handle: string }>(`SELECT handle FROM identities WHERE id=$1`, [
          AGENT,
        ])
      ).rows[0]?.handle,
    ).toBe('bee_3');

    const renamedLogin = new TokenAuth(fixture.database, async () => ({
      subject: 'owner',
      login: 'bee_3',
      name: 'Owner',
    }));
    await renamedLogin.exchangeGitHubOidc('owner-renamed-login');
    expect(
      (
        await fixture.database.query<{ handle: string }>(`SELECT handle FROM identities WHERE id=$1`, [
          HUMAN,
        ])
      ).rows[0]?.handle,
    ).toBe('owner');
    expect(
      (
        await fixture.database.query<{ handle: string }>(`SELECT handle FROM identities WHERE id=$1`, [
          AGENT,
        ])
      ).rows[0]?.handle,
    ).toBe('bee_3');
  });


  it('recovers a GitHub identity conflict and exposes the predecessor over HTTP', async () => {
    const predecessor = 'c'.repeat(64);
    await fixture.database.query(`UPDATE identities SET github_subject=NULL WHERE id=$1`, [HUMAN]);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle,github_subject) VALUES($1,'human','Old Owner','old-owner','owner')`,
      [predecessor],
    );
    await fixture.database.query(
      `UPDATE identity_external_links SET identity_id=$1,audience='old-oauth-client'
       WHERE provider='github' AND subject='owner'`,
      [predecessor],
    );
    const state = 'r'.repeat(43);
    await fixture.request('/v1/phone/operations/beginGitHubIdentityBind', 'POST', {
      redirectUri: 'beeline://buzz/github-callback',
      state,
    });
    expect(
      (
        await fixture.request('/v1/phone/operations/completeGitHubIdentityBind', 'POST', {
          challenge: 'github-code',
          proof: state,
        })
      ).status,
    ).toBe(409);
    const recovered = await fixture.request('/v1/phone/operations/recoverGitHubIdentity', 'POST', {
      challenge: 'github-code',
      proof: state,
    });
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toEqual({ personId: HUMAN, recovered: true });
    await expect(
      (await fixture.request('/v1/phone/operations/getIdentityRecovery', 'POST', {})).json(),
    ).resolves.toEqual({ candidates: [{ personId: predecessor, handle: 'old-owner' }] });
  });


  it('archives a repository corner for any member agent, not only its opener', async () => {
    const helper = 'e'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Helper','helper')`,
      [helper],
    );
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [helper, HUMAN]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, helper, ROOM],
    );
    const helperToken = (await fixture.auth.exchangeDaemonToken(
      (await fixture.auth.createDaemonExchange(helper)).exchangeToken,
    ))!.daemonToken;
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'repository-corner-close',
      name: 'Ship-widget',
      objective: 'Ship the widget and close up',
      repository: 'owner/widgets',
      targetBranch: 'main',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };

    // Reach is checked on the target corner, not on the turn's room: an agent
    // outside the corner and its parent is refused even when it names a Room it
    // does belong to.
    const elsewhere = '66666666-6666-4666-8666-666666666666';
    await fixture.database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Elsewhere')`, [
      elsewhere,
      WORKSPACE,
    ]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, elsewhere, helper],
    );
    await fixture.database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id IN ($1,$2) AND identity_id=$3`,
      [cornerId, ROOM, helper],
    );
    expect(
      (await fixture.daemonOperation('archiveCorner', { roomId: elsewhere, cornerId }, helperToken))
        .status,
    ).toBe(403);
    expect(
      (
        await fixture.daemonOperation(
          'closeCornerPullRequest',
          { roomId: elsewhere, cornerId },
          helperToken,
        )
      ).status,
    ).toBe(403);
    await fixture.database.query(
      `UPDATE memberships SET removed_at=NULL WHERE room_id IN ($1,$2) AND identity_id=$3`,
      [cornerId, ROOM, helper],
    );

    // A member that did not open the corner closes it, no merge required.
    expect((await fixture.daemonOperation('archiveCorner', { cornerId }, helperToken)).status).toBe(200);
    expect(
      (
        await fixture.database.query<{ archived: boolean; close_requested: boolean }>(
          `SELECT room.archived_at IS NOT NULL archived,room.archived_at IS NOT NULL close_requested
           FROM rooms room JOIN corner_facts fact ON fact.corner_id=room.id WHERE room.id=$1`,
          [cornerId],
        )
      ).rows[0],
    ).toMatchObject({ archived: true, close_requested: true });
  });


  it('serves bounded GitHub room tokens and deduplicates signed webhooks', async () => {
    const roomToken = await fixture.request(`/v1/phone/github/room-token/${ROOM}`);
    expect(roomToken.status).toBe(200);
    expect(((await roomToken.json()) as { token: string }).token).toBe('github-room-token');
    // A GitHub outage is a bad gateway that names GitHub's status, not this
    // server's own 503; other GitHub refusals keep their mapping.
    fixture.roomTokenFailure = new GitHubHttpError('GitHub installation token', 500);
    const outage = await fixture.request(`/v1/phone/github/room-token/${ROOM}`);
    expect(outage.status).toBe(502);
    expect(await outage.json()).toEqual({ error: 'GitHub installation token failed: HTTP 500' });
    fixture.roomTokenFailure = new GitHubHttpError('GitHub installation token', 422);
    expect((await fixture.request(`/v1/phone/github/room-token/${ROOM}`)).status).toBe(503);
    fixture.roomTokenFailure = undefined;
    const payload = Buffer.from(JSON.stringify({ action: 'opened' }));
    const signature = `sha256=${createHmac('sha256', 'webhook-secret').update(payload).digest('hex')}`;
    const send = () =>
      phoneFetch(`${fixture.origin}/v1/github/webhook`, {
        method: 'POST',
        headers: {
          'x-hub-signature-256': signature,
          'x-github-delivery': 'delivery-1',
          'x-github-event': 'pull_request',
          'content-type': 'application/json',
        },
        body: payload,
      });
    fixture.processWebhook.mockRejectedValueOnce(new Error('transient webhook failure'));
    expect((await send()).status).toBe(503);
    expect(
      (
        await fixture.database.query(`SELECT 1 FROM github_webhook_deliveries WHERE delivery_id=$1`, [
          'delivery-1',
        ])
      ).rowCount,
    ).toBe(0);
    expect((await send()).status).toBe(202);
    const duplicate = await send();
    expect(duplicate.status).toBe(200);
    expect(((await duplicate.json()) as { duplicate: boolean }).duplicate).toBe(true);
    expect(fixture.processWebhook).toHaveBeenCalledTimes(2);
    expect(
      (
        await fixture.database.query<{ received: boolean }>(
          `SELECT received_at IS NOT NULL received FROM github_webhook_deliveries WHERE delivery_id=$1`,
          ['delivery-1'],
        )
      ).rows,
    ).toEqual([{ received: true }]);
  });
});
