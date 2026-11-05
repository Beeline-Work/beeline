import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {migratedDatabase,type PgliteDatabase} from "../../../tests/helpers/server.js";
import {SCHEDULED_WORK_AUTHORITY_SCHEMA,scheduledRoomDomain,currentScheduledWorkFence} from './scheduled-work-authority.js';
import {scheduledWorkAudience} from './scheduled-work-audience.js';
import {routerSourcePlan} from './router-source-plan.js';
import {requireScheduledWorkManager} from './subscription-webhooks.js';
const OWNER='a'.repeat(64),TARGET_OWNER='b'.repeat(64),PERSON='c'.repeat(64),FORMER='d'.repeat(64),READER='e'.repeat(64),HIDDEN='f'.repeat(64),AGENT='0'.repeat(64);
const PEOPLE=[OWNER,TARGET_OWNER,PERSON,FORMER,READER,HIDDEN,AGENT];
const WS='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',ROOM='33333333-3333-4333-8333-333333333333';
describe('Scheduled Work Room-policy hint audience equals actual OLD/NEW manager permissions',()=>{
  let db:PgliteDatabase;
  beforeEach(async()=>{
    db=await migratedDatabase();await db.query(SCHEDULED_WORK_AUTHORITY_SCHEMA);
    await db.query(`INSERT INTO identities(id,kind,name,hidden_from_roster) VALUES
      ($1,'human','Owner',false),($2,'human','Target owner',false),($3,'human','Own DM participant',false),
      ($4,'human','Removed admin',false),($5,'human','Transcript member',false),($6,'human','Hidden admin',true),($7,'agent','Agent admin',false)`,PEOPLE);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Old Workspace'),($2,'New Workspace')`,[WS,OTHER]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role,removed_at) VALUES
      ($1,NULL,$3,'owner',NULL),($2,NULL,$4,'owner',NULL),($1,NULL,$5,'admin',now()),
      ($1,NULL,$6,'member',NULL),($1,NULL,$7,'admin',NULL),($1,NULL,$8,'admin',NULL)`,[WS,OTHER,OWNER,TARGET_OWNER,FORMER,READER,HIDDEN,AGENT]);
  });
  afterEach(async()=>{await db.close();});
  async function allowed(){
    const result:string[]=[];
    for(const person of PEOPLE){
      try{await requireScheduledWorkManager(db,ROOM,person);result.push(person);}
      catch(error){
        if(!(error instanceof Error)||!['room not found','room is archived','room lifecycle cannot target a corner','workspace admins only'].includes(error.message))throw error;
      }
    }
    return result;
  }
  /** Independent differential oracle: the actual legacy/pure builder manager
   * predicate, before and after a direct SQL policy write. No remembered source
   * registry list or client-held inventory selects expected recipients. */
  async function transition(work:()=>Promise<unknown>){
    const before=await allowed();
    const heads=new Map((await db.query<{id:string;sequence:string}>(`SELECT id,sequence::text FROM live_streams WHERE id LIKE 'authority:%'`)).rows.map(row=>[row.id,Number(row.sequence)]));
    await work();const after=await allowed();
    const rows=(await db.query<{stream_id:string;sequence:string}>(`SELECT stream_id,sequence::text FROM live_journal WHERE event->>'authorityScope'=$1`,[scheduledRoomDomain(ROOM)])).rows;
    const recipients=[...new Set(rows.filter(row=>Number(row.sequence)>(heads.get(row.stream_id)??0)).map(row=>row.stream_id.slice('authority:'.length)))].sort();
    expect(recipients).toEqual([...new Set([...before,...after])].sort());
    return {before,after,recipients};
  }
  const create=(participants?:readonly string[])=>db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,direct_participants)
    VALUES($1,$2,$3,'Synthetic policy scope',$4::jsonb)`,[ROOM,WS,OWNER,participants?JSON.stringify(participants):null]);
  const member=(person:string,removed=false)=>db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role,removed_at)
    VALUES($1,$2,$3,'member',CASE WHEN $4::boolean THEN now() ELSE NULL END)`,[WS,ROOM,person,removed]);
  it('does not disclose a newly created public Room to a removed admin, hidden/nonhuman admin or mere transcript reader',async()=>{
    expect((await transition(()=>create())).recipients).toEqual([OWNER]);
    await member(READER);
    const archived=await transition(()=>db.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`,[ROOM]));
    expect(archived.before).toEqual([OWNER]);expect(archived.after).toEqual([]);expect(archived.recipients).not.toContain(READER);
  });
  it('does not disclose somebody else\'s DM policy to either Workspace owner; its own active participants need no Workspace membership',async()=>{
    expect((await transition(()=>create([PERSON,READER]))).recipients).toEqual([]);
    await member(PERSON);await member(READER);
    const moved=await transition(()=>db.query(`UPDATE rooms SET workspace_id=$1 WHERE id=$2`,[OTHER,ROOM]));
    expect(moved.recipients).toEqual([PERSON,READER]);expect(moved.after).toEqual([PERSON,READER]);
    expect((await db.query(`SELECT 1 FROM memberships WHERE identity_id=$1 AND room_id IS NULL`,[PERSON])).rowCount).toBe(0);
  });
  it('participant names and removed DM memberships alone do not create a Room-policy audience',async()=>{
    await transition(()=>create([PERSON]));
    expect((await transition(()=>db.query(`UPDATE rooms SET direct_participants=$1::jsonb WHERE id=$2`,[JSON.stringify([PERSON,READER]),ROOM]))).recipients).toEqual([]);
    await member(PERSON,true);
    expect((await transition(()=>db.query(`UPDATE rooms SET workspace_id=$1 WHERE id=$2`,[OTHER,ROOM]))).recipients).toEqual([]);
  });
  it('a public-to-private Workspace move selects real OLD managers and NEW own-DM readers, excluding the target Workspace administrator',async()=>{
    await transition(()=>create());await member(PERSON);
    const moved=await transition(()=>db.query(`UPDATE rooms SET workspace_id=$1,direct_participants=$2::jsonb WHERE id=$3`,[OTHER,JSON.stringify([PERSON]),ROOM]));
    expect(moved.before).toEqual([OWNER]);expect(moved.after).toEqual([PERSON]);expect(moved.recipients).toEqual([OWNER,PERSON]);
    expect(await currentScheduledWorkFence(db,OWNER,ROOM,scheduledRoomDomain(ROOM))).toMatchObject({mode:'deny'});
  });
  it('participant revocation retains the real OLD recipient for an exact policy denial without denying unchanged membership',async()=>{
    await transition(()=>create([PERSON,READER]));await member(PERSON);await member(READER);
    const revoked=await transition(()=>db.query(`UPDATE rooms SET direct_participants=$1::jsonb WHERE id=$2`,[JSON.stringify([READER]),ROOM]));
    expect(revoked.before).toEqual([PERSON,READER]);expect(revoked.after).toEqual([READER]);expect(revoked.recipients).toContain(PERSON);
    expect(await currentScheduledWorkFence(db,PERSON,ROOM,scheduledRoomDomain(ROOM))).toMatchObject({mode:'deny'});
    expect((await db.query(`SELECT 1 FROM memberships WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`,[ROOM,PERSON])).rowCount).toBe(1);
  });
  it('deletion captures the real private OLD audience before membership cascade erases it',async()=>{
    await transition(()=>create([PERSON,READER]));await member(PERSON);await member(READER);
    const deleted=await transition(()=>db.query(`DELETE FROM rooms WHERE id=$1`,[ROOM]));
    expect(deleted.before).toEqual([PERSON,READER]);expect(deleted.after).toEqual([]);expect(deleted.recipients).toEqual([PERSON,READER]);
    const plan=routerSourcePlan([],PERSON,WS);
    plan.scheduledWorkCauses.push({roomId:ROOM,readers:[PERSON,READER]});
    const query=vi.spyOn(db,'query');
    try{
      const audience=await scheduledWorkAudience(db,WS,PERSON,plan,true);
      expect(audience).toHaveLength(1);
      expect(audience[0]).toMatchObject({roomId:ROOM,state:undefined,changed:true,
        authority:{scopes:[{authorityScope:`scheduled-work-principal:${PERSON}`,epoch:expect.any(String)}]}});
      // Candidate selection plus one authority statement, even when no Room
      // row survives. No independent certificate read in the audience layer.
      expect(query).toHaveBeenCalledTimes(2);
    }finally{query.mockRestore();}
    await db.query(`DELETE FROM router_authority WHERE scope=$1`,[`scheduled-work-principal:${PERSON}`]);
    await expect(scheduledWorkAudience(db,WS,PERSON,plan,true)).rejects.toThrow();
  });
  it('preserves SQL-null public policy separately from JSON-null private policy in both OLD and NEW records',async()=>{
    await transition(()=>create([PERSON]));await member(PERSON);
    const toJsonNull=await transition(()=>db.query(`UPDATE rooms SET direct_participants='null'::jsonb WHERE id=$1`,[ROOM]));
    expect(toJsonNull.before).toEqual([PERSON]);expect(toJsonNull.after).toEqual([]);expect(toJsonNull.recipients).toEqual([PERSON]);
    const toPublic=await transition(()=>db.query(`UPDATE rooms SET direct_participants=NULL WHERE id=$1`,[ROOM]));
    expect(toPublic.before).toEqual([]);expect(toPublic.after).toEqual([OWNER]);expect(toPublic.recipients).toEqual([OWNER]);
    const toJsonNullAgain=await transition(()=>db.query(`UPDATE rooms SET direct_participants='null'::jsonb WHERE id=$1`,[ROOM]));
    expect(toJsonNullAgain.before).toEqual([OWNER]);expect(toJsonNullAgain.after).toEqual([]);expect(toJsonNullAgain.recipients).toEqual([OWNER]);
  });
  it('matches the stored JSONB membership predicate rather than assuming an unguarded array constraint',async()=>{
    await transition(()=>create([PERSON]));await member(PERSON);await member(READER);
    const objectPolicy=await transition(()=>db.query(`UPDATE rooms SET direct_participants=$1::jsonb WHERE id=$2`,[JSON.stringify({[READER]:true}),ROOM]));
    expect(objectPolicy.before).toEqual([PERSON]);expect(objectPolicy.after).toEqual([READER]);expect(objectPolicy.recipients).toEqual([PERSON,READER]);
    const scalarPolicy=await transition(()=>db.query(`UPDATE rooms SET direct_participants=$1::jsonb WHERE id=$2`,[JSON.stringify(PERSON),ROOM]));
    expect(scalarPolicy.before).toEqual([READER]);expect(scalarPolicy.after).toEqual([PERSON]);expect(scalarPolicy.recipients).toEqual([PERSON,READER]);
  });
});
