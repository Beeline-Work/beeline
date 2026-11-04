import {BackgroundOwnership,BACKGROUND_OWNERSHIP_SCHEMA} from './background-ownership.js';
import {TRAY_CLOCK_OWNER_SCHEMA} from './tray-clock-owner.js';
import {TrayClockHealth} from './tray-clock-health.js';
import {installBackgroundOwnerTestProof,backgroundOwnerTestLock} from './test-fixtures/background-owner-test-support.js';
import {TrayClockReadiness} from './tray-clock-readiness.js';
import {PhoneService} from './phone-service.js';
import {RouterBuildCoordinator,readRouterBuildTicket} from './router-build-coordinator.js';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
import {countNeedsYouProjection,needsYouItems} from './needs-you.js';
import {TRAY_CLOCK_SOURCE_SCHEMA,consumeTrayClockInTransaction,type TrayClockClaim} from './tray-clock-source.js';
import type {RoomViewIdentity} from '@beeline/api-contract/phone';
const viewer='a'.repeat(64),author='b'.repeat(64),workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
const identity=(row:{id:string;kind:'human'|'agent';name:string}):RoomViewIdentity=>({pubkey:row.id,kind:row.kind,name:row.name});
describe('committed Tray display clocks in pure cells and count',()=>{
  let db:PgliteDatabase;let releaseHealth=()=>{};
  beforeEach(async()=>{
    db=await migratedDatabase();releaseHealth=()=>{};
    await db.query(BACKGROUND_OWNERSHIP_SCHEMA);await db.query(TRAY_CLOCK_OWNER_SCHEMA);
    await db.query(`CREATE TABLE tray_reader_clock(now_at timestamptz);INSERT INTO tray_reader_clock VALUES('2000-01-08');
      CREATE FUNCTION tray_reader_test_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT now_at FROM tray_reader_clock $$;`);
    await db.query(TRAY_CLOCK_SOURCE_SCHEMA.replaceAll('clock_timestamp()','tray_reader_test_now()'));
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader','reader'),($2,'human','Author','author')`,[viewer,author]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic clocks')`,[workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Synthetic Room')`,[room,workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')`,[workspace,room,viewer]);
  });
  afterEach(async()=>{releaseHealth();await db.close();});
  const question=()=>db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES('ask',$1,$2,'@reader please review?','2000-01-07')`,[room,author]);
  const read=()=>db.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return {count:await countNeedsYouProjection(tx,workspace,viewer,'committed'),
      needs:await needsYouItems(tx,workspace,viewer,identity,false,'committed')};
  });
  const expire=()=>db.transaction(async tx=>{
    const claims=(await tx.query<TrayClockClaim>(`SELECT id,incarnation,revision::text,kind,due_at::text "dueAt"
      FROM tray_clock_deadlines WHERE state='pending' AND due_at<=tray_reader_test_now() ORDER BY due_at,id`)).rows;
    for(const claim of claims)await consumeTrayClockInTransaction(tx,claim);
  });
  it('keeps a question until committed expiry and never starts a seen clock during either read',async()=>{
    await question();expect((await read()).count).toBe(1);
    await db.query(`UPDATE tray_reader_clock SET now_at='2000-01-14'`);
    const before=await db.query('SELECT id,sequence::text FROM live_streams ORDER BY id');
    const pending=await read();expect(pending.count).toBe(1);expect(pending.needs.items).toHaveLength(1);
    expect((await db.query('SELECT * FROM needs_you_marks')).rows).toEqual([]);
    expect((await db.query('SELECT id,sequence::text FROM live_streams ORDER BY id')).rows).toEqual(before.rows);
    await expire();expect(await read()).toEqual({count:0,needs:{items:[]}});
  });
  it('binds snapshots and shared builders to actual ready committed clock identity without repairing it',async()=>{
    await db.query(TRAY_CLOCK_SOURCE_SCHEMA);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES('ask',$1,$2,'@reader please review?',clock_timestamp()-interval '1 day')`,[room,author]);
    const phone=new PhoneService(db,'https://example.test');
    const input={family:'needs-you-count',workspaceId:workspace} as const,options={trayClock:true} as const;
    await expect(phone.readRouterSnapshot(input,viewer,options)).rejects.toMatchObject({reason:'dependency'});
    expect((await db.query('SELECT ready FROM tray_clock_state')).rows).toEqual([{ready:false}]);
    // A naked ready bit is insufficient, even for the scalar one-statement path.
    await db.query('UPDATE tray_clock_state SET ready=true');
    await expect(phone.readRouterSnapshot(input,viewer,options)).rejects.toMatchObject({reason:'dependency'});
    const readiness=new TrayClockReadiness(db);await readiness.initialize();await readiness.seed();
    for(let step=0;step<20;step++){if(!await readiness.step())break;if(step===19)throw new Error('Readiness did not finish');}
    await expect(phone.readRouterSnapshot(input,viewer,options)).rejects.toMatchObject({reason:'dependency'});
    await installBackgroundOwnerTestProof(db);const lock=await backgroundOwnerTestLock(db);
    await db.query(`INSERT INTO live_server_instances(instance_id) VALUES('tray-reader')`);
    const owner=new BackgroundOwnership(db,'tray-reader'),epoch=await owner.claim(lock);
    releaseHealth=()=>owner.revoke(epoch);await new TrayClockHealth(owner).publish(epoch);
    let statements=0;
    const observed:typeof db={...db,query:(sql,args)=>{statements++;return db.query(sql,args);},transaction:()=>{throw new Error('Scalar snapshot must be one SELECT');},close:()=>db.close()};
    const snapshot=await new PhoneService(observed,'https://example.test').readRouterSnapshot(input,viewer,options);
    expect(statements).toBe(1);expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(1024);
    expect(snapshot).toMatchObject({value:{count:1},clockVersion:expect.stringMatching(/^tray-clock-v1:[a-f0-9]{32}:[0-9]+$/)});
    const coordinator=new RouterBuildCoordinator(),basis={schema:1 as const,databaseScope:'fixture',version:'1',publicOrigin:'https://example.test',clockVersion:'wall'};
    const shared=()=>db.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const ticket=await readRouterBuildTicket(tx,input,viewer,basis,options);
      return coordinator.build(ticket,(read,args,reader)=>phone.buildRouterValue(read,args,reader,options));
    });
    expect(await shared()).toEqual(snapshot);
    await db.query(`UPDATE tray_reader_clock SET now_at='2000-01-14'`);
    expect(await shared()).toEqual(snapshot);
    await db.query(`UPDATE messages SET created_at=clock_timestamp()-interval '8 days' WHERE id='ask'`);
    const after=await shared();expect(after.value).toEqual({count:0});expect(after.cut.through).toBeGreaterThan(snapshot.cut.through);
  });
  it('uses the committed seen deadline separately from message age and rejects read-side writes',async()=>{
    await question();await db.query(`INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,first_seen_at)
      VALUES($1,'ask',$2,'2000-01-08')`,[viewer,workspace]);
    await db.query(`UPDATE tray_reader_clock SET now_at='2000-01-09'`);
    expect((await read()).count).toBe(1);await expire();expect((await read()).count).toBe(0);
    await expect(needsYouItems(db,workspace,viewer,identity,true,'committed')).rejects.toThrow('must be read-only');
  });
  it('expires sign-in and Squire cells/count only with committed clock transitions',async()=>{
    const cards=[['sign-in','agent-sign-in',{ownerId:viewer,harness:'claude',status:'pending',expiresAt:Date.UTC(2000,0,9)}],
      ['squire','squire-approval',{approvalId:'approval',sourceRoomId:room,status:'pending',title:'Synthetic',action:'approve',expiresAt:Date.UTC(2000,0,9)}]] as const;
    for(const[id,type,card]of cards)await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
      VALUES($1,$2,$3,'Synthetic','card',$4,$5::jsonb)`,[id,room,author,type,JSON.stringify(card)]);
    expect((await read()).count).toBe(2);await db.query(`UPDATE tray_reader_clock SET now_at='2000-01-10'`);
    expect((await read()).needs.items).toHaveLength(2);await expire();expect(await read()).toEqual({count:0,needs:{items:[]}});
  });
  it('fails closed on missing evidence instead of treating an untracked question as empty',async()=>{
    await question();await db.query(`DELETE FROM tray_clock_deadlines WHERE source_id='ask'`);
    await expect(read()).rejects.toThrow('Tray clock source incomplete');
  });
  it('captures late owner/source-Room fields and does not evaluate unqualified card clocks',async()=>{
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES
      ('sign-in',$1,$2,'Synthetic','card','agent-sign-in',$3::jsonb),('done',$1,$2,'Synthetic','card','agent-sign-in',$4::jsonb),
      ('squire',$1,$2,'Synthetic','card','squire-approval',$5::jsonb)`,[room,author,
      JSON.stringify({harness:'claude',status:'pending',expiresAt:Date.UTC(2000,0,9)}),
      JSON.stringify({harness:'claude',ownerId:viewer,status:'done',expiresAt:Date.UTC(2000,0,9)}),
      JSON.stringify({approvalId:'approval',title:'Synthetic',action:'approve',expiresAt:Date.UTC(2000,0,9)})]);
    expect((await read()).count).toBe(0);
    await db.query(`UPDATE messages SET card=card||jsonb_build_object('ownerId',$1::text) WHERE id='sign-in'`,[viewer]);
    await db.query(`UPDATE messages SET card=card||jsonb_build_object('sourceRoomId',$1::text) WHERE id='squire'`,[room]);
    expect((await read()).count).toBe(2);
  });
});
