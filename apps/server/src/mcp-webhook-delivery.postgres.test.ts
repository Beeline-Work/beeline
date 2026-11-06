import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { groupBPostgresDatabase } from './test-fixtures/test-support-router-group-b-postgres.js';
import { deliverMcpMemberWebhooks, recordMcpMemberWebhook, recordMcpMention } from './rooms-mcp-members.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
it.skipIf(!url)('concurrent event consumers claim one webhook and never retry a failed delivery', async () => {
  const { database: db, close } = await groupBPostgresDatabase(url!);
  const owner = '1'.repeat(64), member = '2'.repeat(64), workspace = randomUUID(), room = randomUUID();
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { finish = resolve; });
  const transport = vi.fn(async () => { entered(); await held; return new Response('', { status: 500 }); });
  let first: Promise<number> | undefined;
  try {
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Member')`, [owner, member]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [member, owner]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Webhook events')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$4,'member')`,
      [workspace, room, owner, member]);
    await db.query(`INSERT INTO rooms_mcp_clients(id,name,redirects,callback_url)
      VALUES('synthetic','Synthetic','[]','https://callback.synthetic.invalid/wake')`);
    await db.query(`INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label)
      VALUES('synthetic',$1,$2,'Synthetic')`, [owner, member]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('question',$1,$2,'A question')`, [room, owner]);
    await recordMcpMention(db, member, room, 'question');
    await recordMcpMemberWebhook(db, member, 'https://callback.synthetic.invalid/wake', room, 'question', 'A question');
    first = deliverMcpMemberWebhooks(db, transport);
    await Promise.race([started, first]);
    expect(await deliverMcpMemberWebhooks(db, transport)).toBe(0);
    expect(transport).toHaveBeenCalledOnce();
    finish();
    expect(await first).toBe(0);
    // A later real event cannot admit a second attempt for the settled delivery.
    expect(await deliverMcpMemberWebhooks(db, transport)).toBe(0);
    expect(transport).toHaveBeenCalledOnce();
    expect((await db.query('SELECT delivered_at IS NOT NULL settled FROM rooms_mcp_webhook_outbox')).rows)
      .toEqual([{ settled: true }]);
  } finally { finish(); await first?.catch(() => {}); await close(); }
});
