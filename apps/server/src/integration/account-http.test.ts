import { phoneFetch } from '../../../../tests/helpers/phone-operation.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PhoneService } from '.././phone-service.js';
import { LiveHub } from '.././live.js';
import { DEFAULT_MEDIA_MAXIMUM_BYTES } from '.././server.js';
import { announceAgentLifecycle } from '.././connection-presence.js';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: account-http', () => {
const fixture = monolithFixture();

  it('retires welcome cards for fresh and existing accounts, including older clients', async () => {
    const fresh = 'e'.repeat(64);
    await fixture.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Fresh')`, [
      fresh,
    ]);
    await fixture.database.query(`UPDATE identities SET welcome_cards_due=NULL WHERE id=$1`, [HUMAN]);
    expect(await (await fixture.operation('readWelcomeCards', {})).json()).toEqual({ due: false });
    expect(await fixture.phone.execute('readWelcomeCards', {}, fresh)).toEqual({ due: false });
    expect(await fixture.phone.execute('completeWelcomeCards', {}, fresh)).toEqual({ due: false });
    expect(await fixture.phone.execute('readWelcomeCards', {}, fresh)).toEqual({ due: false });
    expect(await fixture.phone.execute('readWelcomeCards', {}, HUMAN)).toEqual({ due: false });
    await expect(fixture.phone.execute('readWelcomeCards',{},AGENT)).rejects.toThrow('human identity required');
    await expect(fixture.phone.execute('completeWelcomeCards',{},AGENT)).rejects.toThrow('human identity required');
  });


  it('binds a Chrome subscription to the authenticated person and removes it on opt-out', async () => {
    const previousPublic = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    const previousPrivate = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = 'test-public-key';
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = 'test-private-key';
    try {
      expect(await (await fixture.operation('readWebPushKey', {})).json()).toEqual({
        publicKey: 'test-public-key',
      });
      const token = 'https://fcm.googleapis.com/fcm/send/test-subscription';
      const keys = { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) };
      const registered = await fixture.operation('registerPushDevice', {
        token,
        platform: 'web',
        environment: 'physical',
        keys,
      });
      expect(registered.status).toBe(200);
      expect(
        (
          await fixture.database.query<{ identity_id: string; web_keys: typeof keys }>(
            `SELECT identity_id,web_keys FROM push_devices WHERE token=$1`,
            [token],
          )
        ).rows,
      ).toEqual([{ identity_id: HUMAN, web_keys: keys }]);
      expect(
        (
          await fixture.operation('registerPushDevice', {
            token: 'http://push.example.org/subscription',
            platform: 'web',
            environment: 'physical',
            keys,
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
      const safariToken = 'https://web.push.apple.com/test-subscription';
      expect((await fixture.operation('registerPushDevice', {
        token: safariToken,
        platform: 'web',
        environment: 'physical',
        keys,
      })).status).toBe(200);
      expect((await fixture.database.query(`SELECT identity_id FROM push_devices WHERE token=$1`, [safariToken])).rows)
        .toEqual([{ identity_id: HUMAN }]);
      expect(
        (
          await fixture.operation('unregisterPushDevice', {
            token,
            platform: 'web',
            environment: 'physical',
          })
        ).status,
      ).toBe(204);
      expect(
        (await fixture.database.query(`SELECT token FROM push_devices WHERE token=$1`, [token])).rows,
      ).toEqual([]);
    } finally {
      if (previousPublic === undefined) delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
      else process.env.WEB_PUSH_VAPID_PUBLIC_KEY = previousPublic;
      if (previousPrivate === undefined) delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
      else process.env.WEB_PUSH_VAPID_PRIVATE_KEY = previousPrivate;
    }
  });


  it('persists manager role changes and refuses an admin editing a peer admin', async () => {
    const adminToken = await fixture.phoneToken('role-change-admin');
    const adminId = createHash('sha256').update('github:role-change-admin').digest('hex');
    const memberId = createHash('sha256').update('github:role-change-member').digest('hex');
    await fixture.phoneToken('role-change-member');
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: adminId,
      role: 'admin',
    });
    await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId, role: 'member' });

    expect(
      (
        await fixture.operation(
          'addWorkspaceMember',
          { workspaceId: WORKSPACE, memberId, role: 'admin' },
          adminToken,
        )
      ).status,
    ).toBe(200);
    const currentRole = async () =>
      (
        await fixture.database.query<{ role: string }>(
          `SELECT role FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,
          [WORKSPACE, memberId],
        )
      ).rows[0]?.role;
    expect(await currentRole()).toBe('admin');

    expect(
      (
        await fixture.operation(
          'addWorkspaceMember',
          { workspaceId: WORKSPACE, memberId, role: 'member' },
          adminToken,
        )
      ).status,
    ).toBe(403);
    expect(await currentRole()).toBe('admin');
    expect(
      (await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId, role: 'member' }))
        .status,
    ).toBe(200);
    expect(await currentRole()).toBe('member');
    expect(
      (await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId, role: 'owner' }))
        .status,
    ).toBe(200);
    expect(await currentRole()).toBe('owner');
  });


  it('carries the resolved all-offline Room footer state on the deck item', async () => {
    await fixture.database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
       VALUES($1,$2,'presence','presence',$3::jsonb)`,
      [
        ROOM,
        AGENT,
        JSON.stringify({ status: 'offline', observedAt: Math.floor(Date.now() / 1_000) }),
      ],
    );

    const readRoomItem = async () =>
      (await fixture.phone.readChats(WORKSPACE, HUMAN))?.chats.find((chat) => chat.room.id === ROOM);
    expect(await readRoomItem()).toMatchObject({ agentsOffline: true });

    await fixture.database.query(
      `UPDATE live_outputs SET body=$3::jsonb,updated_at=clock_timestamp()
       WHERE room_id=$1 AND agent_id=$2 AND kind='presence'`,
      [
        ROOM,
        AGENT,
        JSON.stringify({ status: 'online', observedAt: Math.floor(Date.now() / 1_000) }),
      ],
    );
    expect((await readRoomItem())?.agentsOffline).toBeUndefined();
  });


  it('rejects durable output activity in a top-level Room', async () => {
    expect(
      (
        await fixture.daemonOperation('postAgentActivity', {
          agentId: AGENT,
          roomId: ROOM,
          requestId: 'top-level-output',
          activity: [{ kind: 'output', title: 'Update', text: 'Inspecting the request.' }],
        })
      ).status,
    ).toBe(400);
  });


  it('stays silent for parentless continuity outside the conversation window', async () => {
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES($1,$2,$3,'@owner Aged-out answer.',now()-interval '1 hour')`,
      ['d'.repeat(64), ROOM, AGENT],
    );
    for (let index = 0; index < 200; index += 1) {
      await fixture.database.query(
        `INSERT INTO messages(id,room_id,author_id,text)
         VALUES($1,$2,$3,$4)`,
        [index.toString(16).padStart(64, '0'), ROOM, HUMAN, `Later message ${index}.`],
      );
    }

    const sent = await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: 'e'.repeat(64),
      text: 'No active exchange remains.',
    });
    expect(sent.status).toBe(200);
    const notices = await fixture.database.query<{ text: string }>(
      `SELECT text FROM messages WHERE room_id=$1 AND presentation='system'`,
      [ROOM],
    );
    expect(notices.rows).toEqual([]);
  });


  it('reports daemon bundle readiness over public monolith HTTP', async () => {
    const sourceSha = 'd03cff8f'.padEnd(40, '0');
    await announceAgentLifecycle(fixture.database, new LiveHub(), ROOM, AGENT, {
      lifecycleId: 'release-readiness',
      releaseVersion: 'v0.0.22',
      sourceSha,
    });

    const response = await phoneFetch(`${fixture.origin}/v1/releases/daemon-readiness`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      daemons: [
        {
          agentPubkey: AGENT,
          state: 'ready',
          version: 'v0.0.22',
          sha: sourceSha,
          observedAt: expect.any(Number),
        },
      ],
      summary: { total: 1, ready: 1, neverSeen: 0 },
    });
  });


  it('renews durable phone credentials until explicit sign-out and rejects revoked daemon credentials', async () => {
    const initial = await fixture.auth.exchangeGitHubOidc('proof');
    const refreshed = await fixture.request(
      '/v1/auth/refresh',
      'POST',
      { refreshToken: initial.refreshToken },
      '',
    );
    expect(refreshed.status).toBe(200);
    const successor = (await refreshed.json()) as { accessToken: string; refreshToken: string };
    expect(successor.accessToken).not.toBe(initial.accessToken);
    expect(successor.refreshToken).toBe(initial.refreshToken);
    const replay = await fixture.request(
      '/v1/auth/refresh',
      'POST',
      { refreshToken: initial.refreshToken },
      '',
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ refreshToken: initial.refreshToken, identityId: initial.identityId });
    expect((await fixture.request('/v1/auth/refresh', 'POST', { refreshToken: successor.refreshToken }, '')).status).toBe(200);
    expect((await fixture.request('/v1/auth/logout', 'POST', { refreshToken: initial.refreshToken }, '')).status).toBe(200);
    expect((await fixture.request('/v1/auth/logout', 'POST', { refreshToken: initial.refreshToken }, '')).status).toBe(200);
    const stale = await fixture.request('/v1/auth/refresh', 'POST', { refreshToken: initial.refreshToken }, '');
    expect(stale.status).toBe(401);
    await fixture.database.query(`UPDATE daemon_tokens SET revoked_at=now()`);
    expect(
      (
        await fixture.request(
          '/v1/daemon/operations/getDaemonBootstrap',
          'POST',
          { agentId: AGENT },
          fixture.daemonToken,
        )
      ).status,
    ).toBe(401);
  });


  it('runs the face ceremony: set, read back on every identity view, refuse an unknown id, clear', async () => {
    const operation = (name: string, payload: unknown = {}) =>
      fixture.request(`/v1/phone/operations/${name}`, 'POST', payload);
    const viewerFace = async () =>
      ((await (await operation('getManagedIdentity')).json()) as { face?: string }).face;

    expect(await viewerFace()).toBeUndefined();

    expect((await operation('updateIdentityFace', { faceId: 'owl' })).status).toBe(204);
    expect(await viewerFace()).toBe('owl');

    const sent = await operation('sendRoomMessage', { roomId: ROOM, text: 'hoot' });
    expect(sent.status).toBe(200);
    const room = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      viewer: { identity: { pubkey: string; face?: string } };
      members: { identity: { pubkey: string; face?: string } }[];
      messages: { text: string; author: { pubkey: string; face?: string } }[];
    };
    expect(room.viewer.identity.face).toBe('owl');
    expect(room.members.find((member) => member.identity.pubkey === HUMAN)?.identity.face).toBe(
      'owl',
    );
    expect(room.messages.find((message) => message.text === 'hoot')?.author.face).toBe('owl');
    const workspace = (await (await fixture.request(`/v1/phone/workspaces/${WORKSPACE}`)).json()) as {
      viewer: { identity: { face?: string } };
      members: { identity: { pubkey: string; face?: string } }[];
    };
    expect(workspace.viewer.identity.face).toBe('owl');
    expect(
      workspace.members.find((member) => member.identity.pubkey === HUMAN)?.identity.face,
    ).toBe('owl');

    const refused = await operation('updateIdentityFace', { faceId: 'dragon' });
    expect(refused.status).toBe(400);
    expect(await viewerFace()).toBe('owl');
    expect((await operation('updateIdentityFace', {})).status).toBe(400);
    expect(await viewerFace()).toBe('owl');

    expect((await operation('updateIdentityFace', { faceId: null })).status).toBe(204);
    expect(await viewerFace()).toBeUndefined();
    const cleared = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      viewer: { identity: { face?: string } };
    };
    expect(cleared.viewer.identity).not.toHaveProperty('face');
  });


  it('proves every auth identity phone operation through bearer-authenticated HTTP', async () => {
    const operation = (name: string, payload: unknown = {}) =>
      fixture.request(`/v1/phone/operations/${name}`, 'POST', payload);

    await expect((await operation('getAuthCapabilities')).json()).resolves.toEqual({
      github: true,
      repositoryOnboarding: true,
    });
    await expect((await operation('getManagedIdentity')).json()).resolves.toEqual({
      personId: HUMAN,
      name: 'Owner',
      handle: 'owner',
      pushLevel: 'attention',
      speakingSpeed: 1.15,
      providers: [{ provider: 'github', login: 'owner', reconnect: true }],
    });

    for (const speakingSpeed of [1.3, 1.5, 1.15]) {
      const saved = await operation('updateIdentitySpeakingSpeed', { speakingSpeed });
      expect(saved.status).toBe(200);
      await expect(saved.json()).resolves.toMatchObject({ personId: HUMAN, speakingSpeed });
      await expect((await operation('getManagedIdentity')).json()).resolves.toMatchObject({ speakingSpeed });
    }
    expect((await operation('updateIdentitySpeakingSpeed', { speakingSpeed: 2 })).status).toBe(400);

    const profile = await operation('updatePersonProfile', {
      name: 'Captain',
      avatar: 'https://images.example/captain.png',
    });
    expect(profile.status).toBe(200);
    await expect(profile.json()).resolves.toEqual({
      personId: HUMAN,
      name: 'Captain',
      handle: 'owner',
      avatar: 'https://images.example/captain.png',
    });
    const cleared = await operation('updatePersonProfile', { avatar: '' });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toEqual({
      personId: HUMAN,
      name: 'Captain',
      handle: 'owner',
    });

    const colliding = await operation('updatePersonProfile', { handle: 'bee' });
    expect(colliding.status).toBe(200);
    await expect((await operation('getManagedIdentity')).json()).resolves.toMatchObject({
      handle: 'bee',
    });
    expect(
      (
        await fixture.database.query<{ handle: string }>(`SELECT handle FROM identities WHERE id=$1`, [
          AGENT,
        ])
      ).rows[0]?.handle,
    ).toBe('bee_2');

    const claimed = await operation('claimManagedHandle', { handle: 'captain.owner' });
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toMatchObject({ handle: 'captain.owner' });
    expect((await operation('claimManagedHandle', { handle: 'Not Valid' })).status).toBe(400);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Other','already-taken')`,
      ['d'.repeat(64)],
    );
    expect((await operation('claimManagedHandle', { handle: 'already-taken' })).status).toBe(409);
    expect((await operation('updatePersonProfile', { handle: 'already-taken' })).status).toBe(409);
    expect((await operation('claimManagedHandle', { handle: 'channel' })).status).toBe(400);
    expect((await operation('updatePersonProfile', { handle: 'system' })).status).toBe(400);
    await expect((await operation('adoptGitHubHandle')).json()).resolves.toMatchObject({
      personId: HUMAN,
      handle: 'owner',
    });
    await expect((await operation('getIdentityRecovery')).json()).resolves.toEqual({
      candidates: [],
    });

    const state = 's'.repeat(43);
    const started = await operation('beginGitHubIdentityBind', {
      redirectUri: 'beeline://buzz/github-callback',
      state,
    });
    expect(started.status).toBe(200);
    expect(((await started.json()) as { url: string }).url).toContain(`state=${state}`);
    const completed = await operation('completeGitHubIdentityBind', {
      challenge: 'github-code',
      proof: state,
    });
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toEqual({ personId: HUMAN, recovered: false });

    const link = await fixture.database.query<{ audience: string }>(
      `SELECT audience FROM identity_external_links WHERE provider='github' AND subject='owner'`,
    );
    expect(link.rows[0]?.audience).toBe('github');
  });


  it('stores and serves media bytes through token auth with the configured cap', async () => {
    expect(DEFAULT_MEDIA_MAXIMUM_BYTES).toBe(25 * 1024 * 1024);
    const upload = await phoneFetch(`${fixture.origin}/v1/phone/media`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fixture.accessToken}`,
        'content-type': 'image/png',
        'x-file-name': 'tiny.png',
      },
      body: Buffer.from('png-bytes'),
    });
    expect(upload.status).toBe(201);
    const attachment = (await upload.json()) as { url: string };
    const sent = await fixture.request('/v1/phone/operations/sendRoomMessage', 'POST', {
      roomId: ROOM,
      text: 'image',
      attachments: [{ url: attachment.url, name: 'tiny.png', mimeType: 'image/png', size: 9 }],
    });
    expect(sent.status).toBe(200);
    const media = await phoneFetch(attachment.url, {
      headers: { authorization: `Bearer ${fixture.accessToken}` },
    });
    expect(media.status).toBe(200);
    expect(Buffer.from(await media.arrayBuffer()).toString()).toBe('png-bytes');
    expect(
      (
        await phoneFetch(`${fixture.origin}/v1/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, {
          headers: { authorization: `Bearer ${fixture.accessToken}` },
        })
      ).status,
    ).toBe(404);
    const tooLarge = await phoneFetch(`${fixture.origin}/v1/phone/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.accessToken}` },
      body: Buffer.alloc(1024 * 1024 + 1),
    });
    expect(tooLarge.status).toBe(400);
  });


  it('refreshes a working receipt from activity but leaves a terminal receipt untouched', async () => {
    const requestId = '5'.repeat(64);
    await fixture.daemonOperation('postAgentTurnReceipt', { roomId: ROOM, requestId, status: 'working' });
    await fixture.database.query(
      `UPDATE agent_turns SET created_at=now()-interval '2 minutes'
       WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [ROOM, requestId, AGENT],
    );
    await fixture.daemonOperation('postAgentActivity', {
      roomId: ROOM,
      requestId,
      activity: [{ kind: 'thinking', title: 'Still working', status: 'in_progress' }],
    });
    expect(
      (
        await fixture.database.query<{ fresh: boolean }>(
          `SELECT created_at>now()-interval '5 seconds' fresh FROM agent_turns
           WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
          [ROOM, requestId, AGENT],
        )
      ).rows[0],
    ).toEqual({ fresh: true });

    await fixture.daemonOperation('postAgentTurnReceipt', { roomId: ROOM, requestId, status: 'failed' });
    await fixture.database.query(
      `UPDATE agent_turns SET created_at=now()-interval '1 minute'
       WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [ROOM, requestId, AGENT],
    );
    await fixture.daemonOperation('postAgentActivity', {
      roomId: ROOM,
      requestId,
      activity: [{ kind: 'thinking', title: 'Late activity', status: 'complete' }],
    });
    expect(
      (
        await fixture.database.query<{ status: string; old: boolean }>(
          `SELECT status,created_at<now()-interval '30 seconds' old FROM agent_turns
           WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
          [ROOM, requestId, AGENT],
        )
      ).rows[0],
    ).toEqual({ status: 'failed', old: true });
  });


  it('keeps unresolved human blockers waiting past 21 updates without treating a failed wake as a blocker', async () => {
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-owed-crowded',
      name: 'Pick-a-lid',
      objective: 'Pick a lid for the widget',
    });
    const { cornerId } = (await created.json()) as { cornerId: string };
    await fixture.settleCornerWorkPastGap(cornerId);
    const state = async () =>
      (await new PhoneService(fixture.database, fixture.origin).readCorners(ROOM, HUMAN))?.corners.find(
        (item) => item.corner.id === cornerId,
      )?.state;
    let updates = 0;
    const crowd = async () => {
      for (let index = 0; index < 21; index += 1) {
        updates += 1;
        await fixture.database.query(
          `INSERT INTO messages(id,room_id,author_id,text,created_at)
           VALUES($1,$2,$3,'Still working.',now()+$4::interval)`,
          [`crowded-update-${updates}`, cornerId, AGENT, `${updates} seconds`],
        );
      }
    };

    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES('crowded-tag',$1,$2,'needs-decision: @owner hinged or loose?',now())`,
      [cornerId, AGENT],
    );
    await crowd();
    expect(await state()).toBe('waiting');
    updates += 1;
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES('crowded-answer',$1,$2,'Hinged.',now()+$3::interval)`,
      [cornerId, HUMAN, `${updates} seconds`],
    );
    expect(await state()).toBe('idle');

    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at)
       VALUES('crowded-question',$1,$2,'Hinged or loose?','card','choice',$3::jsonb,now())`,
      [
        cornerId,
        AGENT,
        JSON.stringify({ mode: 'question', status: 'open', requester: { pubkey: HUMAN } }),
      ],
    );
    await crowd();
    expect(await state()).toBe('waiting');
    await fixture.database.query(
      `UPDATE messages SET card=jsonb_set(card,'{status}','"closed"') WHERE id='crowded-question'`,
    );
    expect(await state()).toBe('idle');

    const grantId = '99999999-9999-4999-8999-999999999992';
    await fixture.database.query(
      `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status)
       VALUES($1,$2,$3,'host','example.com','fetch docs',$2,$4,'pending')`,
      [grantId, AGENT, WORKSPACE, cornerId],
    );
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at)
       VALUES('crowded-grant',$1,$2,'Allow Bee to reach example.com','card','grant-request',$3::jsonb,now())`,
      [
        cornerId,
        AGENT,
        JSON.stringify({ grants: [{ grantId, kind: 'host', target: 'example.com' }] }),
      ],
    );
    await crowd();
    expect(await state()).toBe('waiting');
    await fixture.database.query(`UPDATE agent_grants SET status='approved' WHERE id=$1`, [grantId]);
    expect(await state()).toBe('idle');

    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at)
       VALUES('crowded-blocked',$1,$2,'Agent could not be reached','system','corner-agent-unreachable',$4::jsonb,now()+$3::interval)`,
      [cornerId, AGENT, `${updates} seconds`, JSON.stringify({ recipientIds: [HUMAN], status: 'open' })],
    );
    await crowd();
    expect(await state()).toBe('idle');
  });


  it('Reproduction R1: open and revise accept formatted reproduction and multi-line stand-ins', async () => {
    await fixture.database.query(`UPDATE rooms SET repository_key='example/repository',repository_resolution='repository' WHERE id=$1`, [ROOM]);
    const proofs = [
      '**Reproduction R1:** steps fail',
      'Reproduction retained-id\nStand-in: upload the fixture through the adapter.',
      '## Reproduction\nReproduction not feasible: reason\nStand-in: check',
      '## Reproduction\nReproduction not feasible: reason Stand-in: check',
      '',
    ];
    for (const [index, proof] of proofs.entries()) {
      const content = `## Intent\nBug fix.\n${proof}`;
      const opened = await fixture.daemonOperation('createCorner', {
        roomId: ROOM, requestId: `r1-open-${index}`, name: `Proof-${index}`,
        objective: 'Check reproduction warnings', repository: 'example/repository',
        brief: { content },
      });
      expect(opened.status).toBe(200);
      const created = await opened.json() as { cornerId: string; warnings?: string[] };
      expect(Boolean(created.warnings?.length)).toBe(index === proofs.length - 1);
      const revised = await fixture.daemonOperation('reviseCornerBrief', {
        roomId: ROOM, requestId: `r1-revise-${index}`, cornerId: created.cornerId,
        expectedRevision: 1, brief: { content, change: 'Repeat reproduction proof' },
      });
      expect(revised.status).toBe(200);
      const result = await revised.json() as { warnings?: string[] };
      expect(Boolean(result.warnings?.length)).toBe(index === proofs.length - 1);
      console.info(`Reproduction R1: format=${index + 1}; open warnings=${created.warnings?.length ?? 0}; revise warnings=${result.warnings?.length ?? 0}`);
    }
  });


  it('records a real reconnect tap without restarting the active Google ceremony', async () => {
    await fixture.daemonOperation('postAgentMachineReport', { machineId: 'tap-machine', machineName: 'squire' });
    await fixture.daemonOperation('postConnectorVault', { connections: [] });
    const posted = await fixture.daemonOperation('postSquireLoginWall', { roomId: ROOM, wall: 'google_session', message: 'expired' });
    const { offerId } = await posted.json() as { offerId: string };
    const readWork = async () => (await fixture.database.query<{ work: Record<string, unknown> }>(`SELECT squire_work work FROM agents WHERE agent_id=$1`, [AGENT])).rows[0]!.work;
    const before = await readWork();
    const accepted = await fixture.operation('acceptConnectorOffer', { offerId });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ status: 'connecting', connectorId: 'squire:tap-machine' });
    expect(await readWork()).toEqual(before);
    await fixture.daemonOperation('installConnector', { connectorId: 'squire:tap-machine', pairingGeneration: Number(before.generation), signedInAs: 'owner@example.com' });
    await fixture.daemonOperation('postConnectorVault', { connections: [] });
    const card = (await fixture.database.query<{ card: Record<string, any> }>(`SELECT card FROM messages WHERE card_type='connector-offer'`)).rows[0]!.card;
    expect(card.status).toBe('accepted');
    expect(card.acceptedBy.pubkey).toBe(HUMAN);
  });


  it('refuses a per-item kind: its own owner already wakes directly, with no subscription involved', async () => {
    // grant-decided, choice-answered, choice-skipped, poll-closed,
    // turn-cancelled, squire-approval-decided and connector-offer-decided all
    // answer ONE ask and already wake that ask's owner outright (`wakes:
    // [...]` at the call site). A Room-wide subscription to any of them would
    // wake the subscriber on every OTHER agent's item too, forever.
    for (const kind of ['grant-decided', 'choice-answered', 'turn-cancelled']) {
      const refused = await fixture.daemonOperation('setEventSubscriptions', {
        roomId: ROOM,
        kinds: [kind],
      });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(((await refused.json()) as { error: string }).error).toMatch(
        new RegExp(`${kind} wakes its own item's owner automatically`),
      );
    }
    // Nothing was written by any of the refusals.
    expect(
      await (await fixture.daemonOperation('listEventSubscriptions', { roomId: ROOM })).json(),
    ).toEqual({ kinds: [] });
  });
});
