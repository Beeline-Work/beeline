import { postRoomChoice } from './room-choice.js';
import { fenceCommandReceiptEnqueue } from './router-command-coverage.js';
import type { RouterCommandReceipt } from '@beeline/api-contract/router-command';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { createPhoneOperationDispatcher } from './phone-operations.js';
import { LiveHub } from './live.js';
import type { ServerOptions } from './server.js';

const VIEWER = 'a'.repeat(64), WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222', MESSAGE = 'c'.repeat(64);
describe('P7 dispatcher durable command adapter', () => {
  let db: PgliteDatabase;
  beforeEach(async () => {
    db = await migratedDatabase();
    await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'human','Viewer')", [VIEWER]);
    await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Commands')", [WORKSPACE]);
    await db.query("INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Room',$3)", [ROOM, WORKSPACE, VIEWER]);
    await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')", [WORKSPACE, ROOM, VIEWER]);
    await db.query("INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'A message')", [MESSAGE, ROOM, VIEWER]);
  });
  afterEach(async () => { await db.close(); });
  function server() {
    const live = new LiveHub(), phone = new PhoneService(db, 'https://test.invalid');
    const options = { database: db, phone, live } as ServerOptions;
    return { dispatch: createPhoneOperationDispatcher(options,  phone.execute), live };
  }
  it('selects outcome-only Tray decisions through the real dispatcher and never invokes the legacy override or coverage builder',async()=>{
    const agent='d'.repeat(64);
    await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Helper')",[agent]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[agent,VIEWER]);
    await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')",[WORKSPACE,ROOM,agent]);
    const choice=await db.transaction(tx=>postRoomChoice(tx,{roomId:ROOM,agentId:agent,mode:'question',prompt:'Synthetic?',
      options:[{label:'One',consequence:'Use one'},{label:'Two',consequence:'Use two'}],ttlSeconds:300}));
    const first=server(),second=server(),legacy=vi.fn(async()=>{throw new Error('Legacy bypass');});
    const input={choiceId:choice.choiceId},identity={v:1 as const,id:'tray-dispatch-skip'};
    const receipt=await first.dispatch('skipChoice',input,VIEWER,undefined,legacy,undefined,identity);
    expect(receipt).toMatchObject({state:'committed',operation:'skipChoice',result:null});expect(receipt).not.toHaveProperty('coverage');
    const publish=vi.spyOn(second.live,'publish');
    expect(await second.dispatch('skipChoice',input,VIEWER,undefined,legacy,undefined,identity)).toEqual(receipt);
    expect(publish).not.toHaveBeenCalled();expect(legacy).not.toHaveBeenCalled();
    expect((await db.query('SELECT status FROM room_choices WHERE id=$1',[choice.choiceId])).rows).toEqual([{status:'skipped'}]);
  });
  it('retry on a second dispatcher preserves a toggled reaction and does not announce twice', async () => {
    const first = server(), second = server();
    const publish = vi.spyOn(second.live, 'publish');
    const args = { roomId: ROOM, messageId: MESSAGE, emoji: '👍' };
    const identity = { v: 1 as const, id: 'reaction-once' };
    const receipt = await first.dispatch('reactToMessage', args, VIEWER, undefined, undefined, undefined, identity);
    const replay = await second.dispatch('reactToMessage', args, VIEWER, undefined, undefined, undefined, identity);
    expect(replay).toEqual(receipt);
    expect((await db.query('SELECT reactions FROM messages WHERE id=$1', [MESSAGE])).rows[0]?.reactions).toEqual({ '👍': [VIEWER] });
    expect(publish).not.toHaveBeenCalled();
    await expect(second.dispatch('reactToMessage', { ...args, emoji: '❤️' }, VIEWER, undefined, undefined, undefined, identity))
      .rejects.toMatchObject({ status: 409, payload: { error: 'command_identity_conflict' } });
  });
  it('legacy requests keep their original response and toggle semantics without opting in', async () => {
    const { dispatch } = server(), args = { roomId: ROOM, messageId: MESSAGE, emoji: '👍' };
    const result = await dispatch('reactToMessage', args, VIEWER);
    expect(result).toMatchObject({ id: MESSAGE });
    expect(result).not.toHaveProperty('commandId');
    await dispatch('reactToMessage', args, VIEWER);
    expect((await db.query('SELECT reactions FROM messages WHERE id=$1', [MESSAGE])).rows[0]?.reactions).toEqual({});
    expect((await db.query('SELECT * FROM router_commands')).rows).toEqual([]);
  });
  it('unsupported provider operations reject metadata before invoking the legacy effect', async () => {
    const { dispatch } = server(), effect = vi.fn(async () => ({ paid: true }));
    await expect(dispatch('voiceJoin', { roomId: ROOM }, VIEWER, undefined, effect, undefined, { v: 1, id: 'provider' }))
      .rejects.toMatchObject({ status: 400, payload: { error: 'command_operation_not_supported' } });
    expect(effect).not.toHaveBeenCalled();
    expect((await db.query('SELECT * FROM router_commands')).rows).toEqual([]);
  });
  it('keeps the original effect cut and fences private convenience data after revoke/regrant', async () => {
    const { dispatch } = server();
    const args = { roomId: ROOM, messageId: MESSAGE, emoji: '👍' };
    const identity = { v: 1 as const, id: 'authority-race' };
    const original = await dispatch('reactToMessage', args, VIEWER, undefined, undefined, undefined, identity) as RouterCommandReceipt;
    expect(original).not.toHaveProperty('coverage');
    expect(original.result).toMatchObject({ id: MESSAGE });
    const accepted = vi.fn(() => undefined);
    await fenceCommandReceiptEnqueue(db, VIEWER, original, accepted);
    expect(accepted).toHaveBeenCalledWith({ v: 1, operation: 'reactToMessage', commandId: identity.id, state: 'committed' });
    await db.query('UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2', [VIEWER, ROOM]);
    const replay = await dispatch('reactToMessage', args, VIEWER, undefined, undefined, undefined, identity) as RouterCommandReceipt;
    const revoked = vi.fn(() => undefined);
    await fenceCommandReceiptEnqueue(db, VIEWER, replay, revoked);
    expect(revoked).toHaveBeenCalledWith({ v: 1, operation: 'reactToMessage', commandId: identity.id, state: 'committed' });
    await db.query('UPDATE memberships SET removed_at=NULL WHERE identity_id=$1 AND room_id=$2', [VIEWER, ROOM]);
    const regranted = vi.fn(() => undefined);
    await fenceCommandReceiptEnqueue(db, VIEWER, replay, regranted);
    expect(regranted).toHaveBeenCalledWith({ v: 1, operation: 'reactToMessage', commandId: identity.id, state: 'committed' });
    expect(replay).not.toHaveProperty('coverage');
  });
  it('cancel before dispatch creates no durable intent or effect', async () => {
    const { dispatch } = server(), controller = new AbortController();
    controller.abort(new Error('cancel before send'));
    await expect(dispatch('reactToMessage', { roomId: ROOM, messageId: MESSAGE, emoji: '👍' }, VIEWER,
      controller.signal, undefined, undefined, { v: 1, id: 'cancelled' })).rejects.toThrow('cancel before send');
    expect((await db.query('SELECT * FROM router_commands')).rows).toEqual([]);
    expect((await db.query('SELECT reactions FROM messages WHERE id=$1', [MESSAGE])).rows[0]?.reactions).toEqual({});
  });
  it('does not claim command completion when a DB-only operation is refused', async () => {
    const { dispatch } = server();
    await expect(dispatch('deleteRoomMessage', { roomId: ROOM, messageId: 'd'.repeat(64) }, VIEWER,
      undefined, undefined, undefined, { v: 1, id: 'missing' })).rejects.toThrow();
    expect((await db.query('SELECT * FROM router_commands')).rows).toEqual([]);
  });
});
