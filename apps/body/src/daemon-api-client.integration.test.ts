import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../server/src/database.js';
import { PgliteDatabase } from '../../server/src/test-support.js';
import { TokenAuth } from '../../server/src/auth.js';
import { PhoneService } from '../../server/src/phone-service.js';
import { DaemonService } from '../../server/src/daemon-service.js';
import { LiveHub } from '../../server/src/live.js';
import { createBeelineServer } from '../../server/src/server.js';
import { DaemonApiClient } from './daemon-api-client.js';

const HUMAN = createHash('sha256').update('github:daemon-client-owner').digest('hex');
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

describe('daemon API client against the local monolith', () => {
  let database: PgliteDatabase;
  let auth: TokenAuth;
  let server: ReturnType<typeof createBeelineServer>;
  let origin: string;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,github_subject) VALUES($1,'human','Owner','owner'),($2,'agent','Bee',NULL)`,
      [HUMAN, AGENT],
    );
    await database.query(
      `INSERT INTO agents(agent_id,owner_id,soul,selected_model,selected_effort,model_catalog)
       VALUES($1,$2,$3::jsonb,'gpt-5','high',$4::jsonb)`,
      [
        AGENT,
        HUMAN,
        JSON.stringify({ name: 'Bee', instructions: 'Help carefully.' }),
        JSON.stringify([{ id: 'gpt-5', category: 'model', options: [] }]),
      ],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,
      [WORKSPACE, HUMAN, AGENT, ROOM],
    );
    auth = new TokenAuth(database, async () => ({
      subject: 'owner',
      login: 'owner',
      name: 'Owner',
    }));
    const live = new LiveHub();
    server = createBeelineServer({
      database,
      auth,
      phone: new PhoneService(database, 'http://placeholder'),
      daemon: new DaemonService(database, live),
      live,
      mediaMaximumBytes: 1024,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  });

  it('exchanges a token and round-trips inbox, receipts, authority, settings, presence, and corners', async () => {
    const exchange = await auth.createDaemonExchange(AGENT);
    const exchanged = await fetch(`${origin}/v1/auth/daemon/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exchangeToken: exchange.exchangeToken }),
    });
    expect(exchanged.status).toBe(200);
    const token = (await exchanged.json()) as { daemonToken: string; agentId: string };
    const client = new DaemonApiClient(origin, token.daemonToken, AGENT);

    await expect(
      client.execute('getRoomAuthority', { roomId: ROOM, principalId: HUMAN }),
    ).resolves.toEqual(
      expect.objectContaining({ workspaceId: WORKSPACE, role: 'owner', member: true }),
    );
    await expect(
      client.execute('getAgentConfiguration', { agentId: AGENT, roomId: ROOM }),
    ).resolves.toEqual(
      expect.objectContaining({ soul: { name: 'Bee', instructions: 'Help carefully.' } }),
    );

    const message = await client.execute('postRoomMessage', {
      roomId: ROOM,
      requestId: 'a'.repeat(64),
      text: 'daemon reply',
    });
    const activation = await client.execute('getRoomInbox', {
      roomId: ROOM,
      startAtLatest: true,
    });
    expect(activation).toEqual({ items: [], cursor: expect.any(String) });
    const afterActivation = await client.execute('postRoomMessage', {
      roomId: ROOM,
      requestId: 'd'.repeat(64),
      text: 'after activation',
    });
    await expect(
      client.execute('getRoomInbox', { roomId: ROOM, after: activation.cursor }),
    ).resolves.toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            id: afterActivation.id,
            authorId: AGENT,
            body: 'after activation',
          }),
        ],
      }),
    );
    expect(message.id).not.toBe(afterActivation.id);

    await client.execute('postAgentTurnReceipt', {
      agentId: AGENT,
      roomId: ROOM,
      requestId: 'a'.repeat(64),
      status: 'complete',
      generationId: 'generation-1',
    });
    expect(
      (
        await database.query<{ status: string }>(
          `SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
          [ROOM, 'a'.repeat(64), AGENT],
        )
      ).rows[0]?.status,
    ).toBe('complete');

    await client.execute('postAgentPresence', {
      agentId: AGENT,
      roomId: ROOM,
      status: 'online',
    });
    await expect(
      client.execute('getAgentPresence', { agentId: AGENT, roomId: ROOM }),
    ).resolves.toEqual(expect.objectContaining({ status: 'online' }));

    const corner = await client.execute('createCorner', {
      roomId: ROOM,
      requestId: 'c'.repeat(64),
      name: 'Cutover corner',
      task: 'Verify the monolith cut',
    });
    await client.execute('postCornerLifecycle', {
      cornerId: corner.cornerId,
      status: 'working',
      objective: 'Verify the monolith cut',
    });
    await client.execute('postCornerRemoteState', {
      cornerId: corner.cornerId,
      branch: 'fm/verify-monolith-cut',
      state: 'in-review',
      checks: 'passing',
      pullRequest: {
        number: 812,
        url: 'https://github.com/lunchboxfortwo/beeline/pull/812',
        title: 'Verify the monolith cut',
        targetBranch: 'main',
        headSha: '1'.repeat(40),
        mergeability: 'clean',
      },
    });
    expect(
      (
        await database.query<{ lifecycle: Record<string, unknown> }>(
          `SELECT lifecycle FROM corner_facts WHERE corner_id=$1`,
          [corner.cornerId],
        )
      ).rows[0]?.lifecycle,
    ).toEqual(
      expect.objectContaining({
        lifecycle: 'in-review',
        checks: 'passing',
        pr: expect.objectContaining({ number: 812, targetBranch: 'main' }),
      }),
    );

    await client.execute('postRoomMessage', {
      roomId: ROOM,
      text: 'Merged pull request #812 into main.',
      presentation: 'card',
      tags: { cornerId: corner.cornerId, outcome: 'landed' },
    });
    await client.execute('postCornerRemoteState', {
      cornerId: corner.cornerId,
      branch: 'fm/verify-monolith-cut',
      state: 'gone',
      checks: 'passing',
    });
    await client.execute('archiveCorner', { cornerId: corner.cornerId });
    expect(
      (
        await database.query<{ archived: boolean }>(
          `SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`,
          [corner.cornerId],
        )
      ).rows[0]?.archived,
    ).toBe(true);
    expect(
      (
        await database.query<{ text: string }>(
          `SELECT text FROM messages WHERE room_id=$1 AND presentation='card' ORDER BY created_at DESC LIMIT 1`,
          [ROOM],
        )
      ).rows[0]?.text,
    ).toBe('Merged pull request #812 into main.');
    await expect(client.execute('listRoomCorners', { roomId: ROOM })).resolves.toEqual(
      expect.objectContaining({
        corners: [expect.objectContaining({ cornerId: corner.cornerId, parentRoomId: ROOM })],
      }),
    );
    expect(
      (
        await database.query(
          `SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
          [corner.cornerId, HUMAN],
        )
      ).rowCount,
    ).toBe(1);
    await expect(client.execute('getDaemonBootstrap', { agentId: AGENT })).resolves.toEqual(
      expect.objectContaining({
        rooms: [expect.objectContaining({ roomId: ROOM })],
      }),
    );
  });
});
