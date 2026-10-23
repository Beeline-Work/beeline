import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimAgentCommand, createAgentCommand, routeHumanMessage } from './agent-command.js';
import { computerViewToken, createComputerSession } from './computer-session.js';
import { announceAgentLifecycle } from './connection-presence.js';
import { setCornerHold } from './corner-holds.js';
import { recordPersonMergeYes } from './corner-merge-approval.js';
import { migrate } from './database.js';
import { LiveHub } from './live.js';
import {
  AGENT_OWNER_AUTHORITY_MESSAGE,
  PhoneService,
  SPENDING_OWNER_AUTHORITY_MESSAGE,
  WORKSPACE_ADMIN_AUTHORITY_MESSAGE,
} from './phone-service.js';
import { PgliteDatabase } from './test-support.js';
import { humanRoomAdmin, humanRoomMember } from './workflow-admin.js';

// Permissions come from three places only: the agent's owner, the Workspace
// role, or plain presence in the Room. Each person here holds one Workspace
// role and a different Room/DM role, so any check that still reads the Room or
// DM role gives the wrong answer.
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const WS_OWNER = 'a'.repeat(64); // Workspace owner, Room member
const WS_ADMIN = 'b'.repeat(64); // Workspace admin, Room member
const ROOM_ADMIN = 'c'.repeat(64); // Workspace member, Room and DM admin
const AGENT_OWNER = 'e'.repeat(64); // Workspace member who owns the agent
const AGENT = 'd'.repeat(64);
const PEOPLE = [WS_OWNER, WS_ADMIN, ROOM_ADMIN, AGENT_OWNER] as const;

describe('permissions: agent owner, Workspace admin, or anyone in the Room', () => {
  let database: PgliteDatabase;
  let live: LiveHub;
  let phone: PhoneService;
  let corner: string;
  let messageSeq = 0;
  const dms = new Map<string, string>();
  const placesFor = (person: string) => [
    ['Room', ROOM],
    ['corner', corner],
    ['DM', dms.get(person)!],
  ] as const;

  beforeEach(async () => {
    database = new PgliteDatabase();
    live = new LiveHub();
    await migrate(database);
    phone = new PhoneService(database, 'http://local.test', undefined, undefined, live);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Workspace Owner','wsowner'),($2,'human','Workspace Admin','wsadmin'),
       ($3,'human','Room Admin','roomadmin'),($4,'human','Agent Owner','agentowner'),
       ($5,'agent','Bee','bee')`,
      [WS_OWNER, WS_ADMIN, ROOM_ADMIN, AGENT_OWNER, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id,harness) VALUES($1,$2,'claude')`, [
      AGENT,
      AGENT_OWNER,
    ]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [ROOM, WORKSPACE]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$3,'owner'),($1,NULL,$4,'admin'),($1,NULL,$5,'member'),($1,NULL,$6,'member'),($1,NULL,$7,'member'),
       ($1,$2,$3,'member'),($1,$2,$4,'member'),($1,$2,$5,'admin'),($1,$2,$6,'member'),($1,$2,$7,'member')`,
      [WORKSPACE, ROOM, WS_OWNER, WS_ADMIN, ROOM_ADMIN, AGENT_OWNER, AGENT],
    );
    corner = (await phone.execute('createHumanCorner', { roomId: ROOM, title: 'role-check' }, WS_OWNER)).id;
    await database.query(
      `UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{pr}',$2::jsonb) WHERE corner_id=$1`,
      [corner, JSON.stringify({ number: 1, headSha: '1'.repeat(40) })],
    );
    dms.clear();
    for (const person of PEOPLE) {
      const dm = await phone.execute('resolveDirectMessage', { workspaceId: WORKSPACE, participantId: AGENT }, person);
      dms.set(person, dm.id);
    }
    // A DM row that claims admin must not raise a Workspace member.
    await database.query(`UPDATE memberships SET role='admin' WHERE room_id=$1 AND identity_id=$2`, [
      dms.get(ROOM_ADMIN),
      ROOM_ADMIN,
    ]);
    await announceAgentLifecycle(database, live, ROOM, AGENT, { lifecycleId: 'boot-1' });
  });

  afterEach(async () => database.close());

  async function send(roomId: string, author: string, text: string): Promise<string> {
    const id = (++messageSeq).toString(16).padStart(64, '0');
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
      id,
      roomId,
      author,
      text,
    ]);
    await routeHumanMessage(database, id);
    return id;
  }

  async function lifecycleLine(roomId: string) {
    return (
      await database.query<{ verb: string; consequence: string | null }>(
        `SELECT system_event->>'verb' verb,system_event->>'consequence' consequence FROM messages
         WHERE room_id=$1 AND presentation IN ('system','card') AND author_id=$2
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        [roomId, AGENT],
      )
    ).rows[0];
  }

  async function startTurn(roomId: string, author: string) {
    const ask = await send(roomId, author, 'hello');
    const command = await createAgentCommand(database, {
      roomId,
      agentId: AGENT,
      sourceMessageId: ask,
      reason: 'human_tag',
    });
    await claimAgentCommand(database, roomId, AGENT, command!.id, `generation-${ask.slice(-4)}`);
    return ask;
  }

  async function errorOf(work: Promise<unknown>): Promise<string | undefined> {
    try {
      await work;
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it('anyone in the Room, corner or DM may restart, stop, retry and debug an agent they do not own', async () => {
    for (const [, roomId] of placesFor(ROOM_ADMIN)) {
      await send(roomId, ROOM_ADMIN, '@bee debug');
      expect((await lifecycleLine(roomId))?.verb).toBe('reported diagnostics');
      await startTurn(roomId, AGENT_OWNER);
      await send(roomId, ROOM_ADMIN, '@bee stop');
      expect((await lifecycleLine(roomId))?.verb).toBe('stopped its running turn');
      const ask = await startTurn(roomId, AGENT_OWNER);
      await database.query(`UPDATE agent_turns SET status='failed' WHERE room_id=$1 AND request_id=$2`, [roomId, ask]);
      await send(roomId, ROOM_ADMIN, '@bee retry');
      expect((await lifecycleLine(roomId))?.verb).toBe('queued a retry for its last failed turn');
    }
    // The reported path: a person who does not own the agent sends `@bee /restart`
    // from the phone in their DM with it.
    const dm = dms.get(WS_OWNER)!;
    const restartId = 'f'.repeat(64);
    await phone.execute(
      'sendRoomMessage',
      { roomId: dm, messageId: restartId, text: '@bee /restart', mentions: [AGENT] },
      WS_OWNER,
    );
    await routeHumanMessage(database, restartId);
    expect((await lifecycleLine(dm))?.verb).toBe('queued a restart');
    expect((await database.query(`SELECT 1 FROM agent_commands WHERE action='restart'`)).rowCount).toBe(1);
  });

  it('only the agent owner may sign it in, in every place, whatever their role', async () => {
    for (const person of [WS_OWNER, WS_ADMIN, ROOM_ADMIN])
      for (const [, roomId] of placesFor(person)) {
        await send(roomId, person, '@bee login');
        expect(await lifecycleLine(roomId)).toEqual({
          verb: 'did not sign in to Claude',
          consequence: 'only its owner may sign it in',
        });
      }
    for (const [, roomId] of placesFor(AGENT_OWNER)) {
      await send(roomId, AGENT_OWNER, '@bee login');
      expect((await lifecycleLine(roomId))?.verb).toBe('started a Claude sign-in');
    }
  });

  it('anyone in the Room may stop another person’s turn from the phone', async () => {
    for (const [, roomId] of placesFor(ROOM_ADMIN)) {
      const ask = await startTurn(roomId, AGENT_OWNER);
      await expect(
        phone.execute('cancelAgentTurn', { roomId, requestId: ask, agentId: AGENT }, ROOM_ADMIN),
      ).resolves.not.toThrow();
    }
  });

  it('anyone in the Room may watch a browser share; a Workspace spectator may not, whatever their Room row says', async () => {
    await database.query(`UPDATE memberships SET role='spectator' WHERE room_id=$1 AND identity_id=$2`, [ROOM, ROOM_ADMIN]);
    await database.query(
      `UPDATE memberships SET role='spectator' WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,
      [WORKSPACE, WS_OWNER],
    );
    for (const [viewer, allowed] of [[ROOM_ADMIN, true], [WS_OWNER, false]] as const)
      for (const [, roomId] of placesFor(viewer)) {
        const share = await createComputerSession(database, live, {
          roomId,
          agentId: AGENT,
          sessionId: `share-${roomId}-${viewer.slice(0, 4)}`,
          upstreamUrl: 'body:',
        });
        expect(Boolean(await computerViewToken(database, share.id, viewer))).toBe(allowed);
      }
  });

  it('anyone in the Room may start or cancel a workflow run; only Workspace admins manage schedules', async () => {
    for (const person of PEOPLE)
      for (const [, roomId] of placesFor(person)) {
        expect(await humanRoomMember(database, roomId, person)).toBe(true);
        expect(await humanRoomAdmin(database, roomId, person)).toBe(person === WS_OWNER || person === WS_ADMIN);
      }
    expect(await errorOf(phone.execute('readScheduledWork', { roomId: ROOM }, ROOM_ADMIN))).toBe(
      WORKSPACE_ADMIN_AUTHORITY_MESSAGE,
    );
    expect(await errorOf(phone.execute('readScheduledWork', { roomId: ROOM }, WS_ADMIN))).toBeUndefined();
    // A plain member passes the start gate; this one fails later only because
    // no such workflow is saved.
    expect(
      await errorOf(phone.execute('startOwnedWorkflow', { roomId: ROOM, name: 'none', roleBindings: {} }, ROOM_ADMIN)),
    ).not.toMatch(/room access denied|admin/i);
  });

  it('merge yes, holds and corner close follow the Workspace role, never the Room role', async () => {
    await expect(recordPersonMergeYes(database, corner, ROOM_ADMIN)).rejects.toThrow('owner or admin');
    await expect(recordPersonMergeYes(database, corner, WS_ADMIN)).resolves.toMatchObject({ recorded: true });

    const roomAdminHold = await database.transaction((db) => setCornerHold(db, { cornerId: corner }, ROOM_ADMIN));
    const adminHold = await database.transaction((db) => setCornerHold(db, { cornerId: corner }, WS_ADMIN));
    expect(
      (
        await database.query<{ actor_id: string; standing: string }>(
          `SELECT actor_id,standing FROM corner_merge_holds WHERE corner_id=$1 ORDER BY actor_id`,
          [corner],
        )
      ).rows,
    ).toEqual([
      { actor_id: WS_ADMIN, standing: 'admin' },
      { actor_id: ROOM_ADMIN, standing: 'member' },
    ]);
    await expect(
      database.transaction((db) => setCornerHold(db, { cornerId: corner, releaseHoldId: adminHold.holdId }, ROOM_ADMIN)),
    ).rejects.toThrow('hold release denied');
    await expect(
      database.transaction((db) =>
        setCornerHold(db, { cornerId: corner, releaseHoldId: roomAdminHold.holdId }, WS_ADMIN),
      ),
    ).resolves.toMatchObject({ holdId: roomAdminHold.holdId });

    await expect(phone.execute('requestCornerClose', { roomId: corner }, ROOM_ADMIN)).rejects.toThrow(
      'corner close access denied',
    );
    await expect(phone.execute('requestCornerClose', { roomId: corner }, WS_ADMIN)).resolves.not.toThrow();
  });

  it('views and member lists carry the Workspace role', async () => {
    for (const [, roomId] of placesFor(WS_ADMIN))
      expect((await phone.readRoom(roomId, WS_ADMIN))?.viewer).toMatchObject({
        role: 'admin',
        permissions: { manage: true },
      });
    for (const [, roomId] of placesFor(ROOM_ADMIN))
      expect((await phone.readRoom(roomId, ROOM_ADMIN))?.viewer).toMatchObject({
        role: 'member',
        permissions: { manage: false },
      });
    const roster = (await phone.readRoom(ROOM, WS_OWNER))?.members ?? [];
    expect(roster.find((member) => member.identity.pubkey === ROOM_ADMIN)?.role).toBe('member');
    expect(roster.find((member) => member.identity.pubkey === WS_ADMIN)?.role).toBe('admin');
  });

  it('only the agent owner approves its Trusty Squire spending, in every place', async () => {
    let seq = 0;
    for (const [, roomId] of placesFor(AGENT_OWNER)) {
      const permissionId = `spend-${++seq}`;
      const requestId = `request-${seq}`;
      await database.query(
        `INSERT INTO permission_authority(permission_id,room_id,principal_id,request_id,scope,status)
         VALUES($1,$2,$3,$4,'{"type":"money.spend","merchant":"shop"}'::jsonb,'pending')`,
        [permissionId, roomId, ROOM_ADMIN, requestId],
      );
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
         VALUES($1,$2,$3,'spend','card','permission',$4::jsonb)`,
        [
          String(seq).padStart(64, '9'),
          roomId,
          AGENT,
          JSON.stringify({
            permissionId,
            requestId,
            agent: { pubkey: AGENT, kind: 'agent', name: 'Bee' },
            requester: { pubkey: ROOM_ADMIN, kind: 'human', name: 'Room Admin' },
            tool: 'money.spend',
            repository: 'shop',
            purpose: 'squire-spending',
            ownerId: AGENT_OWNER,
            status: 'pending',
          }),
        ],
      );
      const input = { roomId, permissionId, requestId, agentId: AGENT, repository: 'shop', decision: 'allow' as const };
      // The requester (a Room admin), the Workspace owner and a Workspace admin
      // are all refused: it is not their agent.
      for (const person of [ROOM_ADMIN, WS_OWNER, WS_ADMIN])
        expect(await errorOf(phone.execute('decideWritePermission', input, person))).toBe(
          SPENDING_OWNER_AUTHORITY_MESSAGE,
        );
      expect(await errorOf(phone.execute('decideWritePermission', input, AGENT_OWNER))).toBeUndefined();
    }
  });

  it('only the agent owner decides its key grants and changes its model and billing', async () => {
    let seq = 0;
    for (const [, roomId] of placesFor(AGENT_OWNER)) {
      const grantId = `10000000-0000-4000-8000-00000000000${++seq}`;
      await database.query(
        `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status)
         VALUES($1,$2,$3,'secret','vault://key','use the key',$4,$5,'pending')`,
        [grantId, AGENT, WORKSPACE, ROOM_ADMIN, roomId],
      );
      for (const person of [WS_OWNER, WS_ADMIN, ROOM_ADMIN])
        expect(await errorOf(phone.execute('decideAgentGrant', { grantId, decision: 'deny' }, person))).toBe(
          AGENT_OWNER_AUTHORITY_MESSAGE,
        );
      expect(
        await errorOf(phone.execute('decideAgentGrant', { grantId, decision: 'deny' }, AGENT_OWNER)),
      ).not.toBe(AGENT_OWNER_AUTHORITY_MESSAGE);
    }
    const model = { workspaceId: WORKSPACE, agentId: AGENT, fastMode: true };
    const usage = { workspaceId: WORKSPACE, agentId: AGENT };
    for (const person of [WS_OWNER, WS_ADMIN, ROOM_ADMIN]) {
      expect(await errorOf(phone.execute('updateAgentModelSelection', model, person))).toBe(
        AGENT_OWNER_AUTHORITY_MESSAGE,
      );
      expect(await errorOf(phone.execute('refreshAgentUsage', usage, person))).toBe(AGENT_OWNER_AUTHORITY_MESSAGE);
    }
    expect(await errorOf(phone.execute('updateAgentModelSelection', model, AGENT_OWNER))).not.toBe(
      AGENT_OWNER_AUTHORITY_MESSAGE,
    );
    expect(await errorOf(phone.execute('refreshAgentUsage', usage, AGENT_OWNER))).toBeUndefined();
  });

  it('refusals name the real rule and never a Room role', () => {
    expect([AGENT_OWNER_AUTHORITY_MESSAGE, SPENDING_OWNER_AUTHORITY_MESSAGE, WORKSPACE_ADMIN_AUTHORITY_MESSAGE]).toEqual([
      "Only the agent's owner can change this",
      'Only its owner can approve this spending',
      'workspace admins only',
    ]);
    const source = dirname(fileURLToPath(import.meta.url));
    const offenders = readdirSync(source)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .flatMap((file) =>
        readFileSync(join(source, file), 'utf8')
          .split('\n')
          .map((text, index) => ({ file, line: index + 1, text }))
          .filter(({ text }) => /(Error|deny)\(.*\b[Rr]oom (manager|admin|owner)/.test(text)),
      );
    expect(offenders).toEqual([]);
  });
});
