import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ROOMS_MCP_SCHEMA } from './rooms-mcp-schema.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { TokenAuth } from './auth.js';
import { RoomsMcp } from './rooms-mcp.js';
import { RoomsMcpOAuth, type McpPrincipal } from './rooms-mcp-oauth.js';
import { recordMcpMention, recordMcpMemberWebhook, deliverMcpMemberWebhooks } from './rooms-mcp-members.js';
import { routeHumanMessage } from './agent-command.js';
import { retryOwedMentions, owedMentions, clearOwedMention } from './owed-mentions.js';
import { MCP_STARTER_ROUTINE } from '@beeline/api-contract/phone';

const owner = '1'.repeat(64), member = '2'.repeat(64), other = '3'.repeat(64), helper = '4'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
const id = () => randomBytes(32).toString('hex');

describe('owed Room tags', () => {
  let db: PgliteDatabase, phone: PhoneService, mcp: RoomsMcp, daemon: DaemonService;
  const principal = (memberId = member): McpPrincipal => ({ hash: '', client_id: 'test', identity_id: owner, member_id: memberId, scope: 'rooms:read rooms:write' });
  const call = (name: string, args: Record<string, unknown> = {}, memberId = member) =>
    (mcp as unknown as { call(p: McpPrincipal, n: string, a: Record<string, unknown>): Promise<any> }).call(principal(memberId), name, args);
  async function tag(target = member, text = 'please answer') {
    const message = id();
    await db.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)', [message, room, owner, text]);
    await recordMcpMention(db, target, room, message);
    return message;
  }
  beforeAll(async () => {
    db = new PgliteDatabase(); await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Muse','muse'),($3,'agent','Pidoong','pidoong'),($4,'agent','Helper','helper')`, [owner, member, other, helper]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)', [member, other, helper, owner]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Local')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Local Room')`, [room, workspace]);
    for (const who of [owner, member, other, helper]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')`, [workspace, room, who]);
    await db.query(`INSERT INTO rooms_mcp_clients(id,name,redirects,callback_url) VALUES('test','Test','[]','https://example.com/wake'),('other','Other','[]',NULL)`);
    await db.query(`INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label,profile_set) VALUES('test',$1,$2,'Muse',true),('other',$1,$3,'Pidoong',true)`, [owner, member, other]);
    const live = new LiveHub(); phone = new PhoneService(db, 'http://localhost', undefined, undefined, live);
    daemon = new DaemonService(db, live);
    mcp = new RoomsMcp(new RoomsMcpOAuth(db, 'http://localhost', new TokenAuth(db, async () => { throw new Error('unused'); })), phone, live, daemon);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  it('C1 connector instructions answer where the message came from', () => {
    expect(MCP_STARTER_ROUTINE).toContain('Answer where the message came from');
    expect(MCP_STARTER_ROUTINE).toContain('typed in your own app');
    expect(MCP_STARTER_ROUTINE).toContain('replyTo');
  });
  it('C2 webhook and list_mentions routing fields survive instruction truncation', async () => {
    const message = await tag(member, 'x'.repeat(20000));
    await recordMcpMemberWebhook(db, member, 'https://example.com/wake', room, message, 'x'.repeat(20000));
    const payloads: any[] = [];
    await deliverMcpMemberWebhooks(db, async (_url, init) => { payloads.push(JSON.parse(init.body)); return new Response('', { status: 200 }); });
    const payload = payloads.find(p => p.messageId === message);
    const expected = { roomId: room, messageId: message, memberId: member, replyRule: `answer in this Room with replyTo ${message}` };
    expect(payload).toMatchObject(expected);
    const cut = { ...payload, instruction: payload.instruction.slice(0, 200) };
    expect(cut).toMatchObject(expected);
    expect(cut.instruction).toContain(message);
    const page = await call('list_mentions');
    expect(page.mentions.find((m: any) => m.id === message)).toMatchObject(expected);
  });
  it('C4 private member/message record survives a handle rename and includes helper agents', async () => {
    const message = await tag();
    await db.query(`UPDATE identities SET handle='renamed_muse' WHERE id=$1`, [member]);
    expect((await owedMentions(db, member)).some(m => m.messageId === message)).toBe(true);
    const source = id();
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@helper please answer')`, [source, room, owner]);
    await routeHumanMessage(db, source);
    expect((await owedMentions(db, helper)).some(m => m.messageId === source)).toBe(true);
    expect((await db.query(`SELECT 1 FROM messages WHERE reply_to_message_id=$1`, [source])).rowCount).toBe(0);
  });
  it('C5 failed send leaves tag owed; successful reply or explicit message silence clears only that tag', async () => {
    const message = await tag(), keep = await tag();
    const send = vi.spyOn(phone, 'execute').mockRejectedValueOnce(new Error('send failed'));
    await expect(call('send_message', { room, text: 'answer', replyTo: message })).rejects.toThrow('send failed');
    send.mockRestore();
    expect((await owedMentions(db, member)).some(m => m.messageId === message)).toBe(true);
    // Failed claims must be immediately retryable, without a minute of lost work.
    await call('send_message', { room, text: 'answer', replyTo: message });
    expect((await owedMentions(db, member)).some(m => m.messageId === message)).toBe(false);
    await call('no_reply_needed', { address: room, messageId: keep });
    expect((await owedMentions(db, member)).some(m => m.messageId === keep)).toBe(false);
  });
  it('C6 owed-only list and legacy cursor paging', async () => {
    const a = await tag(), b = await tag();
    const seq = (await db.query<{seq: string}>('SELECT seq::text seq FROM rooms_mcp_mentions WHERE member_id=$1 AND message_id=$2', [member, a])).rows[0]!.seq;
    await call('send_message', { room, text: 'done', replyTo: a });
    const page = await call('list_mentions', { cursor: seq, limit: 1 });
    expect(page.mentions.map((m: any) => m.id)).toEqual([b]);
    expect((await call('list_mentions')).mentions.map((m: any) => m.id)).not.toContain(a);
    expect(BigInt(page.nextCursor)).toBeGreaterThan(BigInt(seq));
  });
  it('C7 every tool result includes the caller’s remaining owed tags, including failures', async () => {
    const message = await tag();
    const tool = (mcp as unknown as { toolResult(p: McpPrincipal,n: string,a: Record<string, unknown>): Promise<any> }).toolResult.bind(mcp);
    for (const [name, args] of [['list_rooms', {}], ['send_message', { room, text: '' }]] as const) {
      const result = await tool(principal(), name, args);
      expect(JSON.parse(result.content.at(-1).text).owedMentions.some((m: any) => m.messageId === message)).toBe(true);
    }
  });
  it('C7 helper tool context returns only its authenticated member’s owed tags', async () => {
    const message = await tag(helper);
    const result = await daemon.execute('getOwedMentions', {}, helper);
    expect(result.owedMentions.some(m => m.messageId === message)).toBe(true);
    expect((await daemon.execute('getOwedMentions', {}, member)).owedMentions.some(m => m.messageId === message)).toBe(false);
  });
  it('C8 server key deduplicates initial sends and retries independently for each tagged member', async () => {
    const message = await tag(); await recordMcpMention(db, other, room, message);
    for (const who of [member, other]) {
      const first = await call('send_message', { room, text: 'first', replyTo: message, idempotencyKey: 'custom-key' }, who);
      const retry = await call('send_message', { room, text: 'retry', replyTo: message, idempotencyKey: 'different-key' }, who);
      expect(retry.messageId).toBe(first.messageId);
      expect((await db.query('SELECT 1 FROM rooms_mcp_idempotency WHERE member_id=$1 AND idempotency_key=$2', [who, `mention:${who}:${message}`])).rowCount).toBe(1);
    }
    expect((await db.query('SELECT 1 FROM messages WHERE reply_to_message_id=$1', [message])).rowCount).toBe(2);
  });
  it('C5 helper silence requires an explicit tag message ID and clears only that tag', async () => {
    await db.query("UPDATE agent_commands SET state='complete' WHERE agent_id=$1 AND state='pending'", [helper]);
    const source = id(), keep = await tag(helper);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@helper decline this')`, [source, room, owner]);
    await routeHumanMessage(db, source);
    const command = (await daemon.execute('getAgentCommands', { roomId: room }, helper)).commands.find(c => c.sourceMessageId === source)!;
    await daemon.execute('claimAgentCommand', { roomId: room, commandId: command.id, generationId: 'decline' }, helper);
    const context = { roomId: room, requestId: command.turnRequestId, generationId: 'decline' };
    await expect(daemon.execute('markAgentTurnSilent', context, helper)).rejects.toThrow('nonhuman wake');
    expect((await owedMentions(db, helper)).some(m => m.messageId === source)).toBe(true);
    await daemon.execute('markAgentTurnSilent', { ...context, messageId: source }, helper);
    const remaining = (await owedMentions(db, helper)).map(m => m.messageId);
    expect(remaining).not.toContain(source);
    expect(remaining).toContain(keep);
    await db.query("UPDATE agent_commands SET state='complete' WHERE id=$1", [command.id]);
  });
  it('C8 helper post and automatic final reply share the server mention key across turns', async () => {
    await db.query("UPDATE agent_commands SET state='complete' WHERE agent_id=$1 AND state='pending'", [helper]);
    const source = id();
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@helper answer once')`, [source, room, owner]);
    await routeHumanMessage(db, source);
    const command = (await daemon.execute('getAgentCommands', { roomId: room }, helper)).commands.find(c => c.sourceMessageId === source)!;
    await daemon.execute('claimAgentCommand', { roomId: room, commandId: command.id, generationId: 'first' }, helper);
    const first = await daemon.execute('postCornerMessage', { roomId: room, cornerId: room, requestId: command.turnRequestId, generationId: 'first', text: 'first answer', replyTo: source }, helper);
    await db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,lease_expires_at=NULL,turn_request_id=$2 WHERE id=$1`, [command.id, id()]);
    const retry = (await daemon.execute('getAgentCommands', { roomId: room }, helper)).commands.find(c => c.id === command.id)!;
    await daemon.execute('claimAgentCommand', { roomId: room, commandId: command.id, generationId: 'retry' }, helper);
    await daemon.execute('postRoomMessage', { roomId: room, requestId: retry.turnRequestId, generationId: 'retry', text: 'retry answer', replyToMessageId: source }, helper);
    expect((await db.query('SELECT id FROM messages WHERE author_id=$1 AND reply_to_message_id=$2', [helper, source])).rows).toEqual([{ id: first.id }]);
    expect((await owedMentions(db, helper)).some(m => m.messageId === source)).toBe(false);
  });
  it('C9 fake-clock re-wakes at 5/15/45 minutes then stops silently, skipping an in-flight turn', async () => {
    await db.query('UPDATE rooms_mcp_mentions SET cleared_at=now()');
    await db.query(`INSERT INTO rooms_mcp_connections(client_id,identity_id,scope) VALUES('test',$1,'rooms:read rooms:write') ON CONFLICT DO NOTHING`, [owner]);
    await db.query(`INSERT INTO rooms_mcp_event_subscriptions(id,client_id,owner_id,member_id,url,secret,verified_at,expires_at)
      VALUES('local-rewake','test',$1,$2,'https://example.com/events','local-fixture',now(),now()+interval '1 day')`, [owner, member]);
    const message = await tag();
    const start = new Date('2030-01-01T00:00:00Z');
    await db.query('UPDATE rooms_mcp_mentions SET created_at=$1 WHERE message_id=$2', [start, message]);
    const count = (await db.query('SELECT 1 FROM messages')).rowCount;
    let legacyCursor = (await call('list_mentions')).nextCursor;
    for (const minute of [4, 5, 14, 15, 44, 45, 60]) {
      const wakes = await retryOwedMentions(db, new Date(start.getTime() + minute * 60_000));
      expect(wakes).toBe([5,15,45].includes(minute) ? 1 : 0);
      if (wakes) {
        const page = await call('list_mentions', { cursor: legacyCursor });
        expect(page.mentions.map((m: any) => m.id)).toContain(message);
        legacyCursor = page.nextCursor;
        const event = (await db.query<{ body: string }>('SELECT body FROM rooms_mcp_event_deliveries WHERE message_id=$1', [message])).rows[0]!;
        expect(event.body.indexOf('replyRule')).toBeLessThan(event.body.indexOf('text'));
        expect(JSON.parse(event.body).data).toMatchObject({ roomId: room, messageId: message, memberId: member, replyRule: `answer in this Room with replyTo ${message}` });
        expect((await db.query('SELECT 1 FROM rooms_mcp_webhook_outbox WHERE message_id=$1 AND delivered_at IS NULL', [message])).rowCount).toBe(1);
      }
    }
    expect((await db.query('SELECT 1 FROM messages')).rowCount).toBe(count);
    const source = id();
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@helper slow job')`, [source, room, owner]);
    await routeHumanMessage(db, source);
    await db.query(`UPDATE agent_commands SET state='claimed',lease_expires_at=now()+interval '1 hour' WHERE source_message_id=$1`, [source]);
    await db.query('UPDATE rooms_mcp_mentions SET created_at=$1 WHERE message_id=$2', [start, source]);
    expect(await retryOwedMentions(db, new Date(start.getTime()+5*60_000))).toBe(0);
    await db.query(`UPDATE agent_commands SET state='complete',lease_expires_at=NULL WHERE source_message_id=$1`, [source]);
    expect(await retryOwedMentions(db, new Date(start.getTime()+15*60_000))).toBe(1);
    expect((await db.query('SELECT state FROM agent_commands WHERE source_message_id=$1', [source])).rows).toEqual([{ state: 'pending' }]);
  });
  it('C5 migration preserves successful historical replies and remains idempotent', async () => {
    const answered = await tag(), unanswered = await tag();
    await call('send_message', { room, text: 'historical answer', replyTo: answered });
    await db.query('ALTER TABLE rooms_mcp_mentions DROP COLUMN cleared_at CASCADE');
    await db.query(ROOMS_MCP_SCHEMA);
    expect((await owedMentions(db, member)).map(m => m.messageId)).not.toContain(answered);
    expect((await owedMentions(db, member)).map(m => m.messageId)).toContain(unanswered);
    await clearOwedMention(db, member, room, unanswered);
    await db.query(ROOMS_MCP_SCHEMA);
    expect((await owedMentions(db, member)).map(m => m.messageId)).not.toContain(unanswered);
  });

});
