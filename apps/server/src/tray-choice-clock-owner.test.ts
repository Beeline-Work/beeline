import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundOwnership, BACKGROUND_OWNERSHIP_SCHEMA, BackgroundOwnershipLost, type BackgroundEpoch } from './background-ownership.js';
import {installBackgroundOwnerTestProof,backgroundOwnerTestLock} from './test-fixtures/background-owner-test-support.js';
import type { SqlDatabase } from './database.js';
import { postRoomChoice } from './room-choice.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { TrayChoiceClockOwner } from './tray-choice-clock-owner.js';
import { TRAY_CLOCK_OWNER_SCHEMA } from './tray-clock-owner.js';
import { TRAY_CLOCK_SOURCE_SCHEMA } from './tray-clock-source.js';

const human='a'.repeat(64),room='11111111-1111-4111-8111-111111111111',workspace='22222222-2222-4222-8222-222222222222';
describe('unselected owned choice deadline domain adapter',()=>{
  let db:PgliteDatabase;
  const scopes:Array<{owner:BackgroundOwnership;epoch:BackgroundEpoch}>=[];
  beforeEach(async()=>{
    db=await migratedDatabase();await db.query(BACKGROUND_OWNERSHIP_SCHEMA);
    await db.query(TRAY_CLOCK_SOURCE_SCHEMA);await db.query(TRAY_CLOCK_OWNER_SCHEMA);
    await installBackgroundOwnerTestProof(db);
    await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('synthetic-choice-owner');
      INSERT INTO identities(id,kind,name) VALUES('${human}','human','Synthetic owner');
      INSERT INTO workspaces(id,name) VALUES('${workspace}','Synthetic choices');
      INSERT INTO rooms(id,workspace_id,name) VALUES('${room}','${workspace}','Synthetic Room');
      INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES('${workspace}','${room}','${human}','owner'),('${workspace}',NULL,'${human}','owner')`);
  });
  afterEach(async()=>{for(const{owner,epoch}of scopes.splice(0))owner.revoke(epoch);await db.close();});
  const owned=async(database:SqlDatabase=db)=>{
    const owner=new BackgroundOwnership(database,'synthetic-choice-owner'),epoch=await owner.claim(await backgroundOwnerTestLock(db));
    scopes.push({owner,epoch});return{owner,epoch,adapter:new TrayChoiceClockOwner(owner)};
  };
  const create=(mode:'question'|'poll'='question')=>db.transaction(tx=>postRoomChoice(tx,{roomId:room,agentId:human,mode,
    prompt:'Synthetic choice?',options:[{label:'One',consequence:'Use one'},{label:'Two',consequence:'Use two'}],ttlSeconds:300}));
  const due=(id:string)=>db.query(`UPDATE room_choices SET closes_at=clock_timestamp()-interval '2 seconds' WHERE id=$1`,[id]);

  it.each(['question','poll'] as const)('settles actual %s once and atomically retires its source, card and clock',async(mode)=>{
    if(mode==='poll'){
      const other='b'.repeat(64);await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Other voter')`,[other]);
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,$2,$3,'member'),($1,NULL,$3,'member')`,[workspace,room,other]);
    }
    const choice=await create(mode);await due(choice.choiceId);const{adapter,epoch}=await owned();
    expect(await adapter.drain(epoch)).toEqual({consumed:true,next:null,continuation:false});
    expect((await db.query(`SELECT status FROM room_choices WHERE id=$1`,[choice.choiceId])).rows)
      .toEqual([{status:mode==='question'?'skipped':'closed'}]);
    expect((await db.query(`SELECT state FROM tray_clock_deadlines WHERE source_id=$1`,[choice.choiceId])).rows)
      .toEqual([{state:'cancelled'}]);
    const before=await db.query(`SELECT count(*)::int count FROM messages`);
    expect(await adapter.drain(epoch)).toEqual({consumed:false,next:null,continuation:false});
    expect((await db.query(`SELECT count(*)::int count FROM messages`)).rows).toEqual(before.rows);
    expect((await db.query(`SELECT revision::text FROM tray_clock_state WHERE workspace_id=$1`,[workspace])).rows).toEqual([{revision:'1'}]);
    expect((await db.query('SELECT * FROM tray_clock_owner_fences')).rows).toEqual([]);
  });

  it('returns only the actual future deadline and performs no terminal transition early',async()=>{
    const{adapter,epoch}=await owned();expect(await adapter.drain(epoch)).toEqual({consumed:false,next:null,continuation:false});
    const choice=await create();const result=await adapter.drain(epoch);
    expect(result).toMatchObject({consumed:false,continuation:false,next:{kind:'choice-close'}});
    expect(result.next!.remainingMs).toBeGreaterThan(0);
    expect((await db.query(`SELECT status FROM room_choices WHERE id=$1`,[choice.choiceId])).rows).toEqual([{status:'open'}]);
  });

  it('rejects captured revision ABA and returns the new exact due version without settling the old one',async()=>{
    const choice=await create();await due(choice.choiceId);let change=true;
    const wrap=(tx:SqlDatabase):SqlDatabase=>({query:async(sql,args)=>{
      const result=await tx.query(sql,args);
      if(change&&sql.includes('AS "choiceId"')){
        change=false;await tx.query(`UPDATE room_choices SET closes_at=closes_at+interval '1 microsecond' WHERE id=$1`,[choice.choiceId]);
        await tx.query(`UPDATE room_choices SET closes_at=closes_at-interval '1 microsecond' WHERE id=$1`,[choice.choiceId]);
      }return result;
    },transaction:work=>tx.transaction(inner=>work(wrap(inner)))});
    const{adapter,epoch}=await owned(wrap(db));
    expect(await adapter.drain(epoch)).toMatchObject({consumed:false,continuation:true,next:{revision:'4'}});
    expect((await db.query(`SELECT status FROM room_choices WHERE id=$1`,[choice.choiceId])).rows).toEqual([{status:'open'}]);
    expect((await adapter.drain(epoch)).consumed).toBe(true);
  });

  it('rolls domain effects, source retirement and clock back when the actual outer transaction fails',async()=>{
    const choice=await create();await due(choice.choiceId);let fail=false;
    const observed:SqlDatabase={query:(sql,args)=>db.query(sql,args),transaction:work=>db.transaction(async tx=>{
      const value=await work(tx);if(fail)throw new Error('synthetic commit failure');return value;
    })};
    const{adapter,epoch}=await owned(observed);const before=await db.query('SELECT count(*)::int count FROM messages');fail=true;
    await expect(adapter.drain(epoch)).rejects.toThrow('synthetic commit failure');
    expect((await db.query(`SELECT status FROM room_choices WHERE id=$1`,[choice.choiceId])).rows).toEqual([{status:'open'}]);
    expect((await db.query(`SELECT state FROM tray_clock_deadlines WHERE source_id=$1`,[choice.choiceId])).rows).toEqual([{state:'pending'}]);
    expect((await db.query('SELECT count(*)::int count FROM messages')).rows).toEqual(before.rows);
    expect((await db.query(`SELECT revision::text FROM tray_clock_state WHERE workspace_id=$1`,[workspace])).rows).toEqual([{revision:'0'}]);
  });

  it('rejects a revoked owner before deadline discovery or domain effects',async()=>{
    const choice=await create();await due(choice.choiceId);
    const query=vi.fn(db.query.bind(db)),observed:SqlDatabase={query,transaction:work=>db.transaction(work)};
    const{adapter,epoch,owner}=await owned(observed);owner.revoke(epoch);query.mockClear();
    await expect(adapter.drain(epoch)).rejects.toBeInstanceOf(BackgroundOwnershipLost);expect(query).not.toHaveBeenCalled();
    expect((await db.query(`SELECT status FROM room_choices WHERE id=$1`,[choice.choiceId])).rows).toEqual([{status:'open'}]);
  });

  it('refuses an orphan due record instead of returning an endlessly repeatable immediate deadline',async()=>{
    const choice=await create();await due(choice.choiceId);
    await db.query('DELETE FROM room_choices WHERE id=$1',[choice.choiceId]);
    // Deliberately model inconsistent migration/source evidence in this
    // disposable fixture; ordinary deletion correctly cancels this record.
    await db.query(`UPDATE tray_clock_deadlines SET state='pending' WHERE source_id=$1`,[choice.choiceId]);
    const{adapter,epoch}=await owned();await expect(adapter.drain(epoch)).rejects.toThrow('Tray choice source unavailable');
    expect((await db.query(`SELECT revision::text FROM tray_clock_state WHERE workspace_id=$1`,[workspace])).rows).toEqual([{revision:'0'}]);
  });
});
