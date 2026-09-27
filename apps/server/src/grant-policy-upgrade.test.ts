import { createHash } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { withdrawSupersededGrantAsks } from './grant-policy-upgrade.js';
import { ensureSystemDirectMessageRoom } from './system-line.js';
import { PgliteDatabase } from './test-support.js';

const OWNER = 'a'.repeat(64);
const AGENT = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const COMMAND = '33333333-3333-4333-8333-333333333333';

describe('withdrawSupersededGrantAsks', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Bee','bee')`,
      [OWNER, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`,
      [WORKSPACE, OWNER],
    );
    // The owner's message started the turn that raised each ask.
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('ask-source',$1,$2,'review this')`,
      [ROOM, OWNER],
    );
    await database.query(
      `INSERT INTO agent_commands(
         id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
         root_command_id,root_source_message_id,agent_depth,state,generation_id,lease_expires_at
       ) VALUES($1,$2,$3,'ask-source',$4,'input','human_tag',$1,'ask-source',0,
         'claimed',$5,now()+interval '10 minutes')`,
      [COMMAND, ROOM, AGENT, 'e'.repeat(64), 'f'.repeat(64)],
    );
  });
  afterEach(() => database.close());

  async function pendingAsk(
    id: string,
    kind: string,
    target: string,
    script?: Record<string, unknown>,
  ) {
    await database.query(
      `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,script,command_id)
       VALUES($1,$2,$3,$4,$5,'needed',$6,$7,'pending',$8::jsonb,$9)`,
      [
        id,
        AGENT,
        WORKSPACE,
        kind,
        target,
        OWNER,
        ROOM,
        script ? JSON.stringify(script) : null,
        COMMAND,
      ],
    );
  }

  it('settles on boot the cards the current server would never raise, without waking their turns', async () => {
    const dm = await ensureSystemDirectMessageRoom(database, WORKSPACE, OWNER);
    const docs = '10000000-0000-4000-8000-000000000001';
    const tests = '10000000-0000-4000-8000-000000000002';
    const wallet = '10000000-0000-4000-8000-000000000003';
    const credential = '10000000-0000-4000-8000-000000000004';
    const script = '10000000-0000-4000-8000-000000000005';
    await pendingAsk(docs, 'mcp', 'openaiDeveloperDocs');
    await pendingAsk(tests, 'command', 'npm test');
    await pendingAsk(wallet, 'mcp', 'wallet');
    await pendingAsk(credential, 'command', 'cat .env');
    const contents = 'print(1)\n';
    await pendingAsk(script, 'command', 'python3 fix.py', {
      path: 'fix.py',
      sha256: createHash('sha256').update(contents).digest('hex'),
      bytes: Buffer.byteLength(contents),
      contents,
    });
    const card = (grants: Array<{ grantId: string; kind: string; target: string }>) =>
      JSON.stringify({
        agent: { pubkey: AGENT, name: 'bee' },
        grants: grants.map((grant) => ({ ...grant, status: 'pending' })),
      });
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES
       ($1,$3,$4,'Owner wants bee to use openaiDeveloperDocs','card','grant-request',$5::jsonb),
       ($2,$3,$4,'Owner wants bee to use npm test and cat .env','card','grant-request',$6::jsonb)`,
      [
        'd'.repeat(64),
        'e'.repeat(64),
        dm,
        AGENT,
        card([{ grantId: docs, kind: 'mcp', target: 'openaiDeveloperDocs' }]),
        card([
          { grantId: tests, kind: 'command', target: 'npm test' },
          { grantId: credential, kind: 'command', target: 'cat .env' },
        ]),
      ],
    );
    const messagesBefore = (await database.query(`SELECT id FROM messages`)).rowCount;

    // The release boot runs every migration again.
    await migrate(database);

    const grants = await database.query<{ id: string; status: string; decided_by: string | null }>(
      `SELECT id::text,status,decided_by FROM agent_grants ORDER BY id`,
    );
    expect(grants.rows).toEqual([
      { id: docs, status: 'revoked', decided_by: SYSTEM_IDENTITY_ID },
      { id: tests, status: 'revoked', decided_by: SYSTEM_IDENTITY_ID },
      { id: wallet, status: 'pending', decided_by: null },
      { id: credential, status: 'pending', decided_by: null },
      { id: script, status: 'pending', decided_by: null },
    ]);
    const cards = await database.query<{ id: string; statuses: string[] }>(
      `SELECT id,(SELECT jsonb_agg(e->>'status') FROM jsonb_array_elements(card->'grants') e) statuses
       FROM messages WHERE card_type='grant-request' ORDER BY id`,
    );
    expect(cards.rows).toEqual([
      { id: 'd'.repeat(64), statuses: ['revoked'] },
      { id: 'e'.repeat(64), statuses: ['revoked', 'pending'] },
    ]);
    // No decision line is posted, so nothing wakes the turn that asked.
    expect((await database.query(`SELECT id FROM messages`)).rowCount).toBe(messagesBefore);
    expect(await withdrawSupersededGrantAsks(database)).toBe(0);
  });
});
