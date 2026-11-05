import { describe, expect, it, vi, PushDeliveryLoop, runMaintenance, TokenAuth, seedCornerOpening, migratedDatabase, insertCornerFacts, ensureSystemDirectMessageRoom, ensureSystemIdentity, SYSTEM_IDENTITY_ID } from './background.test-support.js';

describe('background advisory-lock ownership', () => {
  it('names the inline action a notification can answer, and only that one', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        agent = 'c'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        agentDm = '33333333-3333-4333-8333-333333333333';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle,push_level)
         VALUES($1,'human','Owner','owner','attention'),($2,'agent','Wren','wren','off')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'Direct',$3::jsonb)`,
        [agentDm, workspace, JSON.stringify([human, agent].sort())],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member'),($1,$3,$4,'member')`,
        [workspace, human, agentDm, agent],
      );
      const systemDm = await ensureSystemDirectMessageRoom(db, workspace, human);
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment)
         VALUES('owner-device-token-12345678901234567890',$1,'android','physical')`,
        [human],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);
      const grant = (id: string, status: string) =>
        db.query(
          `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status)
           VALUES($1,$2,$3,'host','api.stripe.com','checking the webhook',$4,$5,$6)`,
          [id, agent, workspace, human, agentDm, status],
        );
      const pending = '55555555-5555-4555-8555-555555555555',
        second = '66666666-6666-4666-8666-666666666666',
        settled = '77777777-7777-4777-8777-777777777777';
      await grant(pending, 'pending');
      await grant(second, 'pending');
      await grant(settled, 'once');
      const card = (grants: string[]) =>
        JSON.stringify({
          agent: { pubkey: agent, name: 'wren' },
          grants: grants.map((grantId) => ({ grantId, kind: 'host', target: 'api.stripe.com' })),
        });
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES
         ($1,$2,$3,'@wren asked @owner for host api.stripe.com','card','grant-request',$4::jsonb),
         ($5,$2,$3,'@wren asked @owner for host api.stripe.com and host b','card','grant-request',$6::jsonb),
         ($7,$2,$3,'@wren asked @owner for host api.stripe.com','card','grant-request',$8::jsonb),
         ($9,$2,$3,'Beeline 1.2 is out','system',NULL,NULL),
         ($10,$11,$12,'are you there?','message',NULL,NULL)`,
        [
          '1'.repeat(64),
          systemDm,
          SYSTEM_IDENTITY_ID,
          card([pending]),
          '2'.repeat(64),
          card([pending, second]),
          '3'.repeat(64),
          card([settled]),
          '4'.repeat(64),
          '5'.repeat(64),
          agentDm,
          agent,
        ],
      );
      expect(await loop.runOnce()).toBe(5);
      const sent = new Map(
        send.mock.calls.map(([, message]) => [message.messageId as string, message.action]),
      );
      expect(sent.get('1'.repeat(64))).toEqual({
        kind: 'grant',
        grantId: pending,
        grantKind: 'host',
        grantTarget: 'api.stripe.com',
        agentName: 'wren',
      });
      // Three buttons cannot answer two asks, and a settled ask needs none.
      expect(sent.get('2'.repeat(64))).toBeUndefined();
      expect(sent.get('3'.repeat(64))).toBeUndefined();
      // The @system DM is read-only: no Reply on its lines.
      expect(sent.get('4'.repeat(64))).toBeUndefined();
      expect(sent.get('5'.repeat(64))).toEqual({ kind: 'reply', authorName: 'Wren' });
    } finally {
      await db.close();
    }
  });

  it('sends a permission ask whole and stays quiet for an automatic access receipt', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        agent = 'c'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '33333333-3333-4333-8333-333333333333';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle,push_level)
         VALUES($1,'human','Owner','owner','attention'),($2,'agent','Wren','wren','off')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
        room,
        workspace,
      ]);
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`,
        [workspace, human],
      );
      const systemDm = await ensureSystemDirectMessageRoom(db, workspace, human);
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment)
         VALUES('owner-device-token-12345678901234567890',$1,'android','physical')`,
        [human],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);
      const pending = '55555555-5555-4555-8555-555555555555',
        auto = '66666666-6666-4666-8666-666666666666';
      const target = `node scripts/check.mjs ${'--workspace apps/server '.repeat(8).trim()}`;
      await db.query(
        `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,auto)
         VALUES($1,$3,$4,'command',$6,'check',$5,$7,'pending',false),
               ($2,$3,$4,'mcp','openaiDeveloperDocs','read docs',$5,$7,'approved',true)`,
        [pending, auto, agent, workspace, human, target, room],
      );
      const ask = `Owner wants wren to use ${target}`;
      expect(ask.length).toBeGreaterThan(200);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES
         ($1,$2,$3,$4,'card','grant-request',$5::jsonb),
         ($6,$2,$3,'@wren was granted mcp openaiDeveloperDocs · auto-approved','system','grant-auto',$7::jsonb)`,
        [
          '1'.repeat(64),
          systemDm,
          agent,
          ask,
          JSON.stringify({
            agent: { pubkey: agent, name: 'wren' },
            grants: [{ grantId: pending, kind: 'command', target }],
          }),
          '2'.repeat(64),
          JSON.stringify({ grantId: auto }),
        ],
      );
      expect(await loop.runOnce()).toBe(1);
      expect(send.mock.calls.map(([, message]) => message)).toEqual([
        expect.objectContaining({ messageId: '1'.repeat(64), text: ask, permission: true }),
      ]);
    } finally {
      await db.close();
    }
  });

  it('delivers member-join pushes at Full', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        other = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle,push_level) VALUES
         ($1,'human','Owner','owner','full'),($2,'human','Other','other','attention')`,
        [human, other],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,
        [workspace, human, other],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES
         ('owner-device-token-12345678901234567890',$1,'android','physical'),
         ('other-device-token-12345678901234567890',$2,'android','physical')`,
        [human, other],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);
      await db.query(
        `INSERT INTO workspace_join_notifications(id,workspace_id,joining_identity_id,text)
         VALUES('join-1',$1,$2,'@other joined Hive')`,
        [workspace, other],
      );
      await db.query(
        `INSERT INTO workspace_join_notification_devices(notification_id,device_token)
         VALUES('join-1','owner-device-token-12345678901234567890'),
                ('join-1','other-device-token-12345678901234567890')`,
      );
      // Member lifecycle rides Full.
      expect(await loop.runOnce()).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(
        'owner-device-token-12345678901234567890',
        expect.objectContaining({ text: '@other joined Hive' }),
      );
    } finally {
      await db.close();
    }
  });

  it("does not deliver another person's corner event to a Default member", async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        other = 'b'.repeat(64),
        agent = 'c'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        corner = '33333333-3333-4333-8333-333333333333';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'human','Owner','owner'),($2,'human','Other','other'),($3,'agent','Bee','bee')`,
        [human, other, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES
         ($1,$3,'Room',NULL),($2,$3,'Corner',$1)`,
        [room, corner, workspace],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,
        [workspace, room, human, other, agent],
      );
      await insertCornerFacts(db, { cornerId: corner, ownerAgentId: agent, commissionedBy: other });
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment)
         VALUES('owner-device-token-12345678901234567890',$1,'android','physical')`,
        [human],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
         VALUES($1,$2,$3,'@bee opened a corner Other work','card','daemon-fact',$4::jsonb)`,
        [
          '1'.repeat(64),
          room,
          agent,
          JSON.stringify({ type: 'corner-open', cornerId: corner, objective: 'Other work' }),
        ],
      );

      expect(await loop.runOnce()).toBe(0);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await db.close();
    }
  });

  it('keeps untagged corner completion quiet but preserves addressed wake decisions', async () => {
    const db = await migratedDatabase();
    try {
      const commissioner = 'a'.repeat(64),
        other = 'b'.repeat(64),
        agent = 'c'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        corner = '33333333-3333-4333-8333-333333333333';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'human','Owner','owner'),($2,'human','Other','other'),($3,'agent','Bee','bee')`,
        [commissioner, other, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES
         ($1,$3,'Room',NULL),($2,$3,'Corner',$1)`,
        [room, corner, workspace],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member') `,
        [workspace, room, commissioner, other, agent],
      );
      await insertCornerFacts(db, { cornerId: corner, ownerAgentId: agent, commissionedBy: commissioner });
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES
         ('owner-device-token-12345678901234567890',$1,'android','physical'),
         ('other-device-token-12345678901234567890',$2,'android','physical')`,
        [commissioner, other],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);
      await ensureSystemIdentity(db);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES
         ($1,$2,$3,'GitHub merged Ship push policy','card','daemon-fact',$4::jsonb),
         ($5,$6,$7,'@owner may need to step in','system','corner-review-deadlock',$8::jsonb),
         ($9,$2,$3,'@bee opened a corner Ship push policy','card','daemon-fact',$10::jsonb),
         ($11,$6,$7,'@owner may need to step in · checks still fail','system','corner-checks-blocked',$8::jsonb)`,
        [
          '1'.repeat(64),
          room,
          agent,
          JSON.stringify({ type: 'corner-complete', cornerId: corner, outcome: 'landed' }),
          '2'.repeat(64),
          corner,
          SYSTEM_IDENTITY_ID,
          JSON.stringify({ cornerId: corner }),
          '3'.repeat(64),
          JSON.stringify({ type: 'corner-open', cornerId: corner }),
          '4'.repeat(64),
        ],
      );

      await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
        VALUES($1,$2,$3,'Agent could not be reached','system','corner-agent-unreachable',$4::jsonb)`,
        ['5'.repeat(64), corner, SYSTEM_IDENTITY_ID, JSON.stringify({ recipientIds: [commissioner], status: 'open' })]);
      expect(await loop.runOnce()).toBe(1);
      expect(send.mock.calls.map(([token, message]) => [token, message.messageId]).sort()).toEqual([
        ['owner-device-token-12345678901234567890', '5'.repeat(64)],
      ]);
      expect(send).toHaveBeenCalledWith(
        'owner-device-token-12345678901234567890',
        expect.objectContaining({ text: 'Agent could not be reached', cornerId: corner }),
      );
    } finally {
      await db.close();
    }
  });

  it('sends nothing for activity in a closed corner, even a tag', async () => {
    const db = await migratedDatabase();
    try {
      const owner = 'a'.repeat(64),
        agent = 'c'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        open = '33333333-3333-4333-8333-333333333333',
        closed = '44444444-4444-4444-8444-444444444444';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle,push_level) VALUES
         ($1,'human','Owner','owner','full'),($2,'agent','Miso','miso','off')`,
        [owner, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name,parent_id,archived_at) VALUES
         ($1,$4,'Room',NULL,NULL),($2,$4,'Open',$1,NULL),($3,$4,'Closed',$1,now())`,
        [room, open, closed, workspace],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,$2,$3,'owner'),($1,$2,$4,'member')`,
        [workspace, room, owner, agent],
      );
      await db.query(`INSERT INTO corner_facts(corner_id) VALUES($1),($2)`, [open, closed]);
      await seedCornerOpening(db, { cornerId: open, agentId: agent, commissionedBy: owner });
      await seedCornerOpening(db, { cornerId: closed, agentId: agent, commissionedBy: owner });
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment)
         VALUES('owner-device-token-12345678901234567890',$1,'android','physical')`,
        [owner],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES
         ($1,$3,$5,'Still here after close','message'),
         ($2,$3,$5,'@owner one more thing','message'),
         ($4,$6,$5,'Open corner update','message')`,
        ['1'.repeat(64), '2'.repeat(64), closed, '3'.repeat(64), agent, open],
      );

      expect(await loop.runOnce()).toBe(1);
      expect(send.mock.calls.map(([, message]) => message.messageId)).toEqual(['3'.repeat(64)]);
      expect(await loop.runOnce()).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('requires Full for untagged finished messages in commissioned corners', async () => {
    const db = await migratedDatabase();
    try {
      const commissioner = 'a'.repeat(64),
        other = 'b'.repeat(64),
        agent = 'c'.repeat(64),
        helper = 'd'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        noCode = '33333333-3333-4333-8333-333333333333',
        code = '44444444-4444-4444-8444-444444444444',
        repoRoom = '55555555-5555-4555-8555-555555555555';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'human','Owner','owner'),($2,'human','Other','other'),
         ($3,'agent','Bee','bee'),($4,'agent','Helper','helper')`,
        [commissioner, other, agent, helper],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES
         ($1,$3,'Room',NULL),($2,$3,'Report',$1)`,
        [room, noCode, workspace],
      );
      // A corner has a pull request path exactly when its parent Room has a repository.
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name,parent_id,repository_key,repository_resolution) VALUES
         ($1,$3,'Widgets',NULL,'owner/widgets','repository'),($2,$3,'Code',$1,NULL,'none')`,
        [repoRoom, code, workspace],
      );

      for (const parent of [room,repoRoom]) await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member'),($1,$2,$6,'member')`,
        [workspace,parent,commissioner,other,agent,helper],
      );
      await db.query(`INSERT INTO corner_facts(corner_id) VALUES($1),($2)`, [noCode, code]);
      await seedCornerOpening(db, { cornerId: noCode, agentId: agent, commissionedBy: commissioner });
      await seedCornerOpening(db, { cornerId: code, agentId: agent, commissionedBy: commissioner });
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES
         ('owner-device-token-12345678901234567890',$1,'android','physical'),
         ('other-device-token-12345678901234567890',$2,'android','physical')`,
        [commissioner, other],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);
      const files = JSON.stringify([
        {
          url: 'https://example.test/report.pdf',
          name: 'report.pdf',
          mimeType: 'application/pdf',
          size: 10,
        },
      ]);
      const cases = {
        deliverable: '1'.repeat(64),
        codeLane: '2'.repeat(64),
        noFiles: '3'.repeat(64),
        notWorker: '4'.repeat(64),
      } as const;
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES
         ($1,$5,$7,'Here is the report',$9::jsonb),
         ($2,$6,$7,'Here is a file',$9::jsonb),
         ($3,$5,$7,'Still working','[]'::jsonb),
         ($4,$5,$8,'A side file',$9::jsonb)`,
        [
          cases.deliverable,
          cases.codeLane,
          cases.noFiles,
          cases.notWorker,
          noCode,
          code,
          agent,
          helper,
          files,
        ],
      );

      expect(await loop.runOnce()).toBe(0);
      await db.query(`UPDATE identities SET push_level='full' WHERE id=$1`, [commissioner]);
      expect(await loop.runOnce()).toBe(4);
      expect(send).toHaveBeenCalledWith(
        'owner-device-token-12345678901234567890',
        expect.objectContaining({
          messageId: cases.deliverable,
          text: 'Bee: Here is the report',
          cornerId: noCode,
        }),
      );
    } finally {
      await db.close();
    }
  });

  it('pushes an open question card to the one human it addresses', async () => {
    const db = await migratedDatabase();
    try {
      const owner = 'a'.repeat(64),
        other = 'b'.repeat(64),
        agent = 'c'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'human','Owner','owner'),($2,'human','Other','other'),($3,'agent','Bee','bee')`,
        [owner, other, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
        room,
        workspace,
      ]);
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,
        [workspace, room, owner, other, agent],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES
         ('owner-device-token-12345678901234567890',$1,'android','physical'),
         ('other-device-token-12345678901234567890',$2,'android','physical')`,
        [owner, other],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);
      const card = (fields: Record<string, unknown>) =>
        JSON.stringify({
          mode: 'question',
          status: 'open',
          requester: { pubkey: owner },
          ...fields,
        });
      const cases = {
        requester: '1'.repeat(64),
        tagged: '2'.repeat(64),
        several: '3'.repeat(64),
        poll: '4'.repeat(64),
        answered: '5'.repeat(64),
      } as const;
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES
         ($1,$6,$7,'Bee asked Which one','card','choice',$8::jsonb),
         ($2,$6,$7,'Bee asked @other which one','card','choice',$9::jsonb),
         ($3,$6,$7,'Bee asked @owner and @other','card','choice',$10::jsonb),
         ($4,$6,$7,'Bee asked everyone','card','choice',$11::jsonb),
         ($5,$6,$7,'Bee asked Already answered','card','choice',$12::jsonb)`,
        [
          cases.requester,
          cases.tagged,
          cases.several,
          cases.poll,
          cases.answered,
          room,
          agent,
          card({}),
          card({ mentionIds: [other] }),
          card({ mentionIds: [owner, other] }),
          JSON.stringify({ mode: 'poll', status: 'open', electorate: [owner, other] }),
          card({ status: 'answered' }),
        ],
      );

      expect(await loop.runOnce()).toBe(2);
      expect(send.mock.calls.map(([token, message]) => [token, message.messageId]).sort()).toEqual([
        ['other-device-token-12345678901234567890', cases.tagged],
        ['owner-device-token-12345678901234567890', cases.requester],
      ]);
    } finally {
      await db.close();
    }
  });

  it('sends one push per recipient per agent turn', async () => {
    const db = await migratedDatabase();
    try {
      const owner = 'a'.repeat(64),
        other = 'b'.repeat(64),
        agent = 'c'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'human','Owner','owner'),($2,'human','Other','other'),($3,'agent','Bee','bee')`,
        [owner, other, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
        room,
        workspace,
      ]);
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,
        [workspace, room, owner, other, agent],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES
         ('owner-device-token-12345678901234567890',$1,'android','physical'),
         ('other-device-token-12345678901234567890',$2,'android','physical')`,
        [owner, other],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);
      const turn = 'd'.repeat(64);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,request_id,created_at) VALUES
         ($1,$4,$5,'@owner first',$6,now()),
         ($2,$4,$5,'@owner second',$6,now()+interval '1 second'),
         ($3,$4,$5,'@owner @other third',$6,now()+interval '2 seconds')`,
        ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), room, agent, turn],
      );

      expect(await loop.runOnce()).toBe(2);
      expect(send.mock.calls.map(([token, message]) => [token, message.messageId]).sort()).toEqual([
        ['other-device-token-12345678901234567890', '3'.repeat(64)],
        ['owner-device-token-12345678901234567890', '3'.repeat(64)],
      ]);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,request_id) VALUES
         ($1,$2,$3,'@owner fourth',$4),($5,$2,$3,'@owner next turn',$6)`,
        ['4'.repeat(64), room, agent, turn, '5'.repeat(64), 'e'.repeat(64)],
      );
      expect(await loop.runOnce()).toBe(1);
      expect(send).toHaveBeenLastCalledWith(
        'owner-device-token-12345678901234567890',
        expect.objectContaining({ messageId: '5'.repeat(64) }),
      );
    } finally {
      await db.close();
    }
  });

  it.each([
    ['off', []],
    ['attention', ['dm', 'tag', 'reply']],
    ['full', ['dm', 'tag', 'reply', 'join', 'plain', 'request']],
  ] as const)('selects the push candidate matrix for %s', async (level, expected) => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        other = 'b'.repeat(64),
        agent = 'c'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        directRoom = '33333333-3333-4333-8333-333333333333';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle,push_level) VALUES
         ($1,'human','Owner','owner',$4),($2,'human','Other','other','attention'),
         ($3,'agent','Bee','bee','attention')`,
        [human, other, agent, level],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(
        `INSERT INTO rooms(id,workspace_id,name,parent_id,direct_participants) VALUES
         ($1,$3,'Room',NULL,NULL),($2,$3,'Direct',NULL,$4::jsonb)`,
        [room, directRoom, workspace, JSON.stringify([human, agent].sort())],
      );
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$3,'owner'),($1,NULL,$4,'member'),
         ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member'),
         ($1,$6,$3,'owner'),($1,$6,$5,'member')`,
        [workspace, room, human, other, agent, directRoom],
      );
      await db.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment)
         VALUES('owner-device-token-12345678901234567890',$1,'android','physical')`,
        [human],
      );
      const send = vi.fn().mockResolvedValue(undefined);
      const loop = new PushDeliveryLoop(db, { send });
      expect(await loop.runOnce()).toBe(0);

      const authored = '0'.repeat(64);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'My prior turn')`,
        [authored, room, human],
      );
      const cases = {
        tag: '1'.repeat(64),
        reply: '2'.repeat(64),
        request: '3'.repeat(64),
        card: '4'.repeat(64),
        plain: '5'.repeat(64),
        dm: '6'.repeat(64),
        join: 'join-1',
      } as const;
      await db.query(
        `INSERT INTO messages
           (id,room_id,author_id,text,presentation,reply_to_message_id,request_id,card_type,card)
         VALUES
           ($1,$7,$8,'@owner mention','message',NULL,NULL,NULL,NULL),
           ($2,$7,$8,'Reply to your turn','message',$9,NULL,NULL,NULL),
           ($3,$7,$8,'Answering your request','message',NULL,$9,NULL,NULL),
           ($4,$7,$8,'Bee asks Owner','card',NULL,NULL,'permission',$10::jsonb),
           ($5,$7,$8,'Plain agent message','message',NULL,NULL,NULL,NULL),
           ($6,$11,$8,'Direct message','message',NULL,NULL,NULL,NULL)`,
        [
          cases.tag,
          cases.reply,
          cases.request,
          cases.card,
          cases.plain,
          cases.dm,
          room,
          agent,
          authored,
          JSON.stringify({ status: 'pending', requester: { pubkey: human } }),
          directRoom,
        ],
      );
      await db.query(
        `INSERT INTO workspace_join_notifications(id,workspace_id,joining_identity_id,text)
         VALUES($1,$2,$3,'@other joined Hive')`,
        [cases.join, workspace, other],
      );
      await db.query(
        `INSERT INTO workspace_join_notification_devices(notification_id,device_token)
         VALUES($1,'owner-device-token-12345678901234567890')`,
        [cases.join],
      );

      await loop.runOnce();
      const byId = new Map(Object.entries(cases).map(([name, id]) => [id, name]));
      expect(send.mock.calls.map(([, message]) => byId.get(message.messageId)).sort()).toEqual(
        [...expected].sort(),
      );
    } finally {
      await db.close();
    }
  });

  it('sweeps expired access tokens while retaining device sessions, including rows from a rolled-back server', async () => {
    const db = await migratedDatabase();
    try {
      let now = new Date('2026-09-01T00:00:00Z');
      const auth = new TokenAuth(db, async () => ({ subject: 'maintenance-owner', login: 'owner', name: 'Owner' }), () => now);
      const tokens = await auth.exchangeGitHubOidc('proof');
      await db.query('UPDATE phone_sessions SET expires_at=$1', [new Date('2026-09-30T00:00:00Z')]);
      await runMaintenance(db);
      expect((await db.query('SELECT 1 FROM phone_access_tokens')).rowCount).toBe(0);
      expect((await db.query('SELECT 1 FROM phone_sessions')).rowCount).toBe(1);
      now = new Date();
      const renewed = await auth.refresh(tokens.refreshToken);
      expect(await auth.authenticatePhone(renewed!.accessToken)).toBe(tokens.identityId);
    } finally { await db.close(); }
  });


  it('ASSIGNMENT-RETAINED: keeps a corner\'s assignment commands past the 30-day command sweep', async () => {
    const db = await migratedDatabase();
    try {
      const agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222',
        corner = '33333333-3333-4333-8333-333333333333';
      await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Bee','bee')`, [agent]);
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room, workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id) VALUES($1,$2,'Corner',$3)`, [corner, workspace, room]);
      for (const [id, roomId, reason] of [['open', corner, 'corner_objective'], ['tag', corner, 'human_tag'],
        ['check', corner, 'corner_check'], ['room-tag', room, 'human_tag']])
        await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,root_command_id,
            root_source_message_id,agent_depth,state,completed_at)
          VALUES($1,$2,$3,$1,'input',$4,$1,$1,0,'complete',now()-interval '40 days')`, [id, roomId, agent, reason]);
      await runMaintenance(db);
      expect((await db.query(`SELECT id FROM agent_commands ORDER BY id`)).rows).toEqual([{ id: 'open' }, { id: 'tag' }]);
    } finally { await db.close(); }
  });


  it('retains imported historical presence while expiring ordinary live output', async () => {
    const db = await migratedDatabase();
    try {
      const human = 'a'.repeat(64),
        agent = 'b'.repeat(64),
        workspace = '11111111-1111-4111-8111-111111111111',
        room = '22222222-2222-4222-8222-222222222222';
      await db.query(
        `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
        [human, agent],
      );
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [
        room,
        workspace,
      ]);
      await db.query(
        `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
         VALUES($1,$2,'legacy','presence','{"status":"online","observedAt":1}',to_timestamp(1)),
               ($1,$2,'expired-turn','draft','{}',to_timestamp(1))`,
        [room, agent],
      );
      await runMaintenance(db);
      expect(
        (await db.query<{ turn_id: string }>(`SELECT turn_id FROM live_outputs`)).rows,
      ).toEqual([{ turn_id: 'legacy' }]);
    } finally {
      await db.close();
    }
  });
});
