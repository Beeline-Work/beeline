import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {countNeedsYouItems,countNeedsYouProjection,needsYouItems} from './needs-you.js';
import {readRouterCut} from './router-projections.js';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
import {PhoneService} from './phone-service.js';
const VIEWER='a'.repeat(64),PEER='b'.repeat(64),AGENT='c'.repeat(64);
const WORKSPACE='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222';
const CHILD='33333333-3333-4333-8333-333333333333',HIDDEN='44444444-4444-4444-8444-444444444444';
const CHOICE='55555555-5555-4555-8555-555555555555',GRANT='66666666-6666-4666-8666-666666666666';
describe('pure count-only Needs-you projection at one database cut',()=>{
  let db:PgliteDatabase;
  beforeEach(async()=>{
    db=await migratedDatabase();
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader','reader'),($2,'human','Peer','peer'),($3,'agent','Helper','helper')`,[VIEWER,PEER,AGENT]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[AGENT,VIEWER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`,[WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room'),($3,$2,'Hidden')`,[ROOM,WORKSPACE,HIDDEN]);
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Child')`,[CHILD,WORKSPACE,ROOM]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member'),($1,$6,$3,'member')`,[WORKSPACE,VIEWER,PEER,AGENT,ROOM,HIDDEN]);
  });
  afterEach(async()=>{await db.close();});
  const message=async(id:string,text:string,room=ROOM,card:Record<string,unknown>|null=null)=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,card,created_at) VALUES($1,$2,$3,$4,$5::jsonb,now()-interval '1 hour')`,[id,room,PEER,text,JSON.stringify(card)]);
  };
  const card=async(id:string,kind:string,body:Record<string,unknown>)=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES($1,$2,$3,'Card','card',$4,$5::jsonb)`,[id,ROOM,AGENT,kind,JSON.stringify(body)]);
  };
  const differential=async(expected:number)=>db.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const before=await readRouterCut(tx,WORKSPACE),count=await countNeedsYouProjection(tx,WORKSPACE,VIEWER);
    const {items}=await needsYouItems(tx,WORKSPACE,VIEWER,row=>({id:row.id,kind:row.kind,name:row.name}),false);
    expect(count).toBe(expected);expect(items).toHaveLength(count);expect(await readRouterCut(tx,WORKSPACE)).toEqual(before);
    return items;
  });
  it('matches addressed asks and commander blockers, excludes hidden Rooms, and observes a real reply',async()=>{
    await message('ask','@reader please review');await message('child-ask','@reader can you decide?',CHILD);
    await message('owed','blocked: need your decision',CHILD,{reportToId:VIEWER});
    await message('near-miss','@reader I approved it');await message('hidden','@reader please review',HIDDEN);
    await differential(3);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('reply',$1,$2,'Answered')`,[CHILD,VIEWER]);
    await differential(1);
    await db.query(`INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,cleared_at) VALUES($1,'ask',$2,now())`,[VIEWER,WORKSPACE]);
    await differential(0);
  });
  it('matches live choices and pending grants through dismissal and decision',async()=>{
    await card('choice','choice',{choiceId:CHOICE,prompt:'Choose a path?',mentionIds:[VIEWER],options:[{optionId:'A',label:'A'}]});
    await db.query(`INSERT INTO room_choices(id,room_id,workspace_id,agent_id,message_id,mode,prompt,options,electorate,status)
      VALUES($1,$2,$3,$4,'choice','question','Choose a path?','[]',ARRAY[$5],'open')`,[CHOICE,ROOM,WORKSPACE,AGENT,VIEWER]);
    await db.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status)
      VALUES($1,$2,$3,'command','npm test','Run tests',$4,$5,'pending')`,[GRANT,AGENT,WORKSPACE,VIEWER,ROOM]);
    await card('grant','grant-request',{agent:{pubkey:AGENT,name:'Helper'},grants:[{grantId:GRANT,kind:'command',target:'npm test'}]});
    await differential(2);
    await db.query(`INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,cleared_at) VALUES($1,'choice',$2,now())`,[VIEWER,WORKSPACE]);
    await differential(1);await db.query(`UPDATE agent_grants SET status='denied' WHERE id=$1`,[GRANT]);await differential(0);
  });
  it('matches first-seen expiry, lookback expiry, and expiring Squire approvals without starting clocks',async()=>{
    await message('current','@reader please review');await message('seen-expired','@reader please review');await message('old','@reader please review');
    await db.query(`UPDATE messages SET created_at=now()-interval '8 days' WHERE id='old'`);
    await db.query(`INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,first_seen_at) VALUES($1,'seen-expired',$2,now()-interval '25 hours')`,[VIEWER,WORKSPACE]);
    await card('squire','squire-approval',{title:'Approval',action:'reveal a key',approvalId:'approval',sourceRoomId:CHILD,expiresAt:Date.now()+600000});
    await differential(2);
    expect((await db.query(`SELECT 1 FROM needs_you_marks WHERE message_id='current'`)).rowCount).toBe(0);
    await db.query(`UPDATE messages SET card=jsonb_set(card,'{expiresAt}',to_jsonb(1::bigint)) WHERE id='squire'`);await differential(1);
  });
  it('follows inherited Room membership and rejects removed Workspace authority even with stale Room rows',async()=>{
    await message('ask','@reader please review',CHILD);await differential(1);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,[ROOM,VIEWER]);await differential(0);
    await db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`,[ROOM,VIEWER]);await differential(1);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id IS NULL AND workspace_id=$1 AND identity_id=$2`,[WORKSPACE,VIEWER]);
    await expect(countNeedsYouProjection(db,WORKSPACE,VIEWER)).rejects.toThrow('workspace membership required');
  });
  it('returns only one scalar result and never transfers full cell rows or starts seen marks',async()=>{
    await message('large','@reader please review '+'x'.repeat(100*1024));
    await db.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');let rows=0;const columns:string[][]=[];
      const proxy:typeof tx={transaction:work=>tx.transaction(work),query:async(sql,args)=>{const result=await tx.query(sql,args);rows+=result.rows.length;
        for(const row of result.rows)columns.push(Object.keys(row).sort());return result;}};
      const phone=new PhoneService(db,'https://example.test');
      expect(await phone.buildRouterValue(proxy,{family:'needs-you-count',workspaceId:WORKSPACE},VIEWER)).toEqual({count:1});expect(rows).toBe(1);
      expect(columns).toEqual([['authorized','count','questions']]);
    });
    expect((await db.query(`SELECT 1 FROM needs_you_marks`)).rowCount).toBe(0);
  });
  it('uses the same Unicode word boundaries as displayed asks',async()=>{
    for(const [id,text]of [
      ['greek','@reader αpleaseβ'],['han','@reader 请approve看'],['underscore','@reader feedback_thing'],
      ['emoji','@reader feedback🌼'],['separate','@reader α please β'],
    ])await message(id!,text!);
    await differential(2);
  });
  it('accepts the complete500-question bound and refuses501 instead of claiming the legacy capped count',async()=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
      SELECT 'ask-'||n,$1,$2,'@reader please review',now()-interval '1 hour' FROM generate_series(1,500)n`,[ROOM,PEER]);
    await differential(500);await message('overflow','@reader please review');
    await expect(countNeedsYouProjection(db,WORKSPACE,VIEWER)).rejects.toMatchObject({reason:'budget'});
    expect(await countNeedsYouItems(db,WORKSPACE,VIEWER)).toBe(500);
  });
  it('applies eligibility before the cap so expired asks and near misses cannot manufacture overflow',async()=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
      SELECT 'near-'||n,$1,$2,'@reader I approved it',now() FROM generate_series(1,501)n`,[ROOM,PEER]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
      SELECT 'old-'||n,$1,$2,'@reader please review',now()-interval '8 days' FROM generate_series(1,501)n`,[ROOM,PEER]);
    await message('real','@reader please review');await differential(1);
  });
});
