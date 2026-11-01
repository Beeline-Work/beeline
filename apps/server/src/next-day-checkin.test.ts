import sharp from 'sharp';
import { createBeelineServer } from './server.js';
import { TokenAuth } from './auth.js';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgliteDatabase } from './test-support.js';
import { migrate } from './database.js';
import { NextDayCheckin, checkinDueAt, renderCheckinEmail, type CheckinEmail } from './next-day-checkin.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { claimAgentCommand, readAgentCommands } from './agent-command.js';
import { ExpectedRefusalError } from './command-refusal.js';

const W='11111111-1111-4111-8111-111111111111', R='22222222-2222-4222-8222-222222222222';
const U='a'.repeat(64), A='b'.repeat(64), M='c'.repeat(64);
let db: PgliteDatabase, phone: PhoneService, clock: Date;
let emails: CheckinEmail[];
const sender = async (mail: CheckinEmail) => { emails.push(mail); return 'sent'; };
const runner = () => new NextDayCheckin(db,'https://web.usebeeline.app',sender,()=>clock);
async function first() {
  await phone.execute('sendRoomMessage',{roomId:R,messageId:M,text:'Help me plan a pottery class'},U);
  // Move the committed first message into yesterday; only the clock is advanced for the worker.
  await db.query(`UPDATE messages SET created_at=$2 WHERE id=$1`,[M,new Date('2026-10-26T20:00:00Z')]);
  await db.query(`UPDATE next_day_checkin_candidates SET first_at=$2,due_at=$3 WHERE identity_id=$1`,
    [U,new Date('2026-10-26T20:00:00Z'),checkinDueAt(new Date('2026-10-26T20:00:00Z'))]);
}
async function reply() {
  const command=(await db.query<{id:string;turn_request_id:string}>(`SELECT id,turn_request_id FROM agent_commands WHERE reason='free_agent_checkin'`)).rows[0]!;
  expect(command).toBeTruthy();
  await claimAgentCommand(db,R,A,command.id,'checkin-proof');
  await new DaemonService(db,new LiveHub()).execute('postRoomMessage',{
    roomId:R,requestId:command.turn_request_id,generationId:'checkin-proof',
    text:'@outside We were planning your pottery class. Shall we pick the first project?',
  },A);
  return command;
}
async function record() { return (await db.query(`SELECT * FROM next_day_checkins WHERE identity_id=$1`,[U])).rows[0]; }

beforeEach(async()=>{
  vi.stubEnv('BEELINE_NEXT_DAY_CHECKIN','on');
  db=new PgliteDatabase(); await migrate(db);
  clock=new Date('2026-10-27T13:00:00Z'); emails=[];
  await db.query(`INSERT INTO push_delivery_floors(id,started_at) VALUES('message-delivery','2026-01-01')`);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Outside','outside'),($2,'agent','Beebee','beebee')`,[U,A]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[A,U]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Outside workspace')`,[W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`,[R,W]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
    ($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,$2,$3,'owner'),($1,$2,$4,'member')`,[W,R,U,A]);
  await db.query(`INSERT INTO free_agents(agent_id,owner_id,workspace_id,sealed_keys,starter_role) VALUES($1,$2,$3,'unused','beebee')`,[A,U,W]);
  phone=new PhoneService(db,'http://local.test',undefined,undefined,new LiveHub());
});
afterEach(async()=>{ await db.close(); vi.unstubAllEnvs(); });

describe('next morning check-in (not a defect report)',()=>{
  it('R-CHECKIN-ACTIVITY: accepts daemon activity without settling, then exposes exactly one plain reply',async()=>{
    await first(); await runner().runOnce();
    const command=(await db.query<{id:string;turn_request_id:string}>(`SELECT id,turn_request_id FROM agent_commands WHERE reason='free_agent_checkin'`)).rows[0]!;
    await claimAgentCommand(db,R,A,command.id,'checkin-proof');
    const daemon=new DaemonService(db,new LiveHub());
    const input={roomId:R,requestId:command.turn_request_id,generationId:'checkin-proof'};
    const activity={...input,activity:[{kind:'thinking' as const,title:'Planning the next step',status:'in_progress' as const}]};
    await expect(daemon.execute('postAgentActivity',activity,A)).resolves.toHaveProperty('id');
    expect((await record())?.sent_at).toBeNull();
    expect((await record())?.message_id).toBeNull();
    expect((await db.query(`SELECT state FROM agent_commands WHERE id=$1`,[command.id])).rows[0]?.state).toBe('claimed');
    await expect(daemon.execute('postAgentActivity',{...activity,generationId:'stale'},A)).rejects.toThrow();
    for (const output of [{text:'   '},{text:'A card',presentation:'card' as const}]) {
      await expect(daemon.execute('postRoomMessage',{...input,...output},A)).rejects.toBeInstanceOf(ExpectedRefusalError);
      expect((await record())?.sent_at).toBeNull();
      expect((await db.query(`SELECT state FROM agent_commands WHERE id=$1`,[command.id])).rows[0]?.state).toBe('claimed');
    }
    const text='We were planning your pottery class. Shall we pick the first project?';
    const result=await daemon.execute('postRoomMessage',{...input,text},A);
    expect((await record())?.message_id).toBe(result.id);
    expect(JSON.stringify(await phone.readRoom(R,U))).toContain(text);
    await expect(daemon.execute('postRoomMessage',{...input,text:'A second check-in'},A)).rejects.toThrow('Do not post another check-in message');
    await expect(daemon.execute('postRoomMessage',{...input,text},A)).rejects.toBeInstanceOf(ExpectedRefusalError);
    await expect(daemon.execute('postAgentActivity',activity,A)).rejects.toThrow();
    expect((await db.query(`SELECT 1 FROM messages WHERE request_id=$1 AND presentation='message'`,[command.turn_request_id])).rowCount).toBe(1);
    expect((await db.query(`SELECT 1 FROM messages WHERE request_id=$1 AND presentation='activity'`,[command.turn_request_id])).rowCount).toBe(1);
  });
  it('R-CHECKIN-ACTIVITY: the trigger preserves invalid-output rollback and settlement fences',async()=>{
    await first(); await runner().runOnce();
    const command=(await db.query<{id:string;turn_request_id:string}>(`SELECT id,turn_request_id FROM agent_commands WHERE reason='free_agent_checkin'`)).rows[0]!;
    for (const [presentation,text] of [['message',''],['card','A card'],['activity','Disguised reply']]) {
      await expect(db.query(`INSERT INTO messages(id,room_id,author_id,request_id,presentation,text) VALUES('invalid-checkin',$1,$2,$3,$4,$5)`,
        [R,A,command.turn_request_id,presentation,text])).rejects.toThrow('one plain Room message');
      expect((await record())?.sent_at).toBeNull();
      expect((await db.query(`SELECT 1 FROM messages WHERE id='invalid-checkin'`)).rowCount).toBe(0);
    }
    await db.query(`UPDATE next_day_checkins SET skip_reason='returned' WHERE identity_id=$1`,[U]);
    await expect(db.query(`INSERT INTO messages(id,room_id,author_id,request_id,presentation,text) VALUES('late-activity',$1,$2,$3,'activity','')`,
      [R,A,command.turn_request_id])).rejects.toThrow('already settled');
    expect((await db.query(`SELECT 1 FROM messages WHERE id='late-activity'`)).rowCount).toBe(0);
  });
  it('chooses the next morning with at least twelve hours, including DST and known zones',()=>{
    expect(checkinDueAt(new Date('2026-10-27T02:00:00Z')).toISOString()).toBe('2026-10-28T13:00:00.000Z');
    expect(checkinDueAt(new Date('2026-10-27T01:00:00Z')).toISOString()).toBe('2026-10-27T13:00:00.000Z');
    expect(checkinDueAt(new Date('2026-10-31T23:00:00Z')).toISOString()).toBe('2026-11-01T14:00:00.000Z');
    expect(checkinDueAt(new Date('2026-10-26T18:00:00Z'),'Asia/Tokyo').toISOString()).toBe('2026-10-28T00:00:00.000Z');
  });
  it('is not due eleven hours after the first message and becomes due the following morning',async()=>{
    await first();
    await db.query(`UPDATE next_day_checkin_candidates SET first_at=$2,due_at=$3 WHERE identity_id=$1`,
      [U,new Date('2026-10-27T02:00:00Z'),checkinDueAt(new Date('2026-10-27T02:00:00Z'))]);
    await runner().runOnce(); expect(await record()).toBeUndefined();
    clock=new Date('2026-10-28T13:00:00Z'); await runner().runOnce(); expect(await record()).toBeTruthy();
  });
  it('records the first real message only and preserves it across later messages',async()=>{
    await first();
    await phone.execute('sendRoomMessage',{roomId:R,messageId:'d'.repeat(64),text:'Make it a bowl'},U);
    expect((await db.query(`SELECT count(*)::int n FROM next_day_checkin_candidates`)).rows[0]?.n).toBe(1);
    expect(new Date((await db.query(`SELECT first_at FROM next_day_checkin_candidates`)).rows[0]!.first_at).toISOString()).toBe('2026-10-26T20:00:00.000Z');
  });
  it('queues a real agent command once across concurrent runners and restart, then exposes one Room message',async()=>{
    await first();
    const install='33333333-3333-4333-8333-333333333333';
    await db.query(`INSERT INTO signin_funnel_installs(install_id,account_hash) VALUES($1,$2)`,
      [install,createHash('sha256').update(`beeline-onboarding:${U}`).digest('hex')]);
    await db.query(`INSERT INTO signin_funnel_events(install_id,attempt_id,event,platform,version,source,occurred_at)
      VALUES($1,$1,'signed_in','web','1.0.0','server',now()),($1,$1,'signup','web','1.0.0','server',now())`,[install]);
    await Promise.all([runner().runOnce(),runner().runOnce()]);
    const c=(await db.query(`SELECT * FROM agent_commands WHERE reason='free_agent_checkin'`)).rows;
    expect(c).toHaveLength(1); expect(c[0]?.wake_context.checkinPrompt).toContain("only this Room's visible messages");
    const delivered=await readAgentCommands(db,R,A);
    const checkin=delivered.commands.find(c=>c.reason==='free_agent_checkin');
    expect(checkin?.private).toBeUndefined(); expect(checkin?.source.body).toContain('one concrete next step');
    await reply(); await runner().runOnce();
    const snapshot=await db.snapshot(); await db.close(); db=PgliteDatabase.fromSnapshot(snapshot);
    await runner().runOnce();
    expect((await db.query(`SELECT count(*)::int n FROM next_day_checkins`)).rows[0]?.n).toBe(1);
    expect((await db.query(`SELECT count(*)::int n FROM messages WHERE author_id=$1 AND request_id=$2`,[A,c[0]!.turn_request_id])).rows[0]?.n).toBe(1);
    phone=new PhoneService(db,'http://local.test',undefined,undefined,new LiveHub());
    expect(JSON.stringify(await phone.readRoom(R,U))).toContain('pick the first project');
    expect((await db.query(`SELECT 1 FROM signin_funnel_events WHERE event='next_day_checkin_sent'`)).rowCount).toBe(1);
  });
  it('skips a later Eastern day return at least six hours after first message',async()=>{
    await first(); await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,'Back again',$4)`,
      ['d'.repeat(64),R,U,new Date('2026-10-27T04:00:00Z')]);
    await runner().runOnce(); expect((await record())?.skip_reason).toBe('returned');
    expect((await db.query(`SELECT 1 FROM agent_commands WHERE reason='free_agent_checkin'`)).rowCount).toBe(0);
  });
  it('does not treat a later-day message less than six hours later as a return',async()=>{
    await first(); await db.query(`UPDATE next_day_checkin_candidates SET first_at=$2 WHERE identity_id=$1`,[U,new Date('2026-10-26T23:00:00Z')]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,'One more thought',$4)`,
      ['d'.repeat(64),R,U,new Date('2026-10-27T04:00:00Z')]);
    await runner().runOnce(); expect((await record())?.skip_reason).toBeNull();
  });
  it('writes no check-in when disabled and fences an already generated reply',async()=>{
    await first(); vi.stubEnv('BEELINE_NEXT_DAY_CHECKIN','off'); await runner().runOnce(); expect(await record()).toBeUndefined();
    vi.stubEnv('BEELINE_NEXT_DAY_CHECKIN','on'); await runner().runOnce();
    vi.stubEnv('BEELINE_NEXT_DAY_CHECKIN','off'); await expect(reply()).rejects.toThrow('no longer due');
    expect((await record())?.sent_at).toBeNull();
  });
  it.each(['person_left','starter_removed','internal_workspace','team_person'])('skips %s',async kind=>{
    await first();
    if(kind==='person_left') await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2`,[U,R]);
    if(kind==='starter_removed') await db.query(`UPDATE free_agents SET removed_at=now()`);
    if(kind==='internal_workspace') await db.query(`UPDATE workspaces SET internal=true`);
    if(kind==='team_person') await db.query(`UPDATE identities SET handle='lunchboxfortwo' WHERE id=$1`,[U]);
    await runner().runOnce(); expect((await record())?.skip_reason).toBe(kind==='person_left'?'left_room':kind==='starter_removed'?'starter_removed':'internal');
  });
  it.each([[false,false],[true,false],[false,true],[true,true]])('uses available channels: push %s, email %s',async(push,email)=>{
    if(push) await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment,registered_at) VALUES('test-device',$1,'ios','physical','2026-01-01')`,[U]);
    if(!email) await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login) VALUES('github','outside',$1,'github','app','not-an-email-source@example.test')`,[U]);
    if(email) await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login) VALUES('google','outside',$1,'google','app','outside@example.test')`,[U]);
    await first(); await runner().runOnce(); expect(emails).toHaveLength(0); await reply(); await runner().runOnce();
    expect(emails).toHaveLength(email?1:0);
    const row=await record(); expect(row?.push_outcomes).toHaveLength(push?1:0);
    if(push) {
      expect((await db.query(`SELECT 1 FROM push_outbox WHERE message_id=$1 AND device_token='test-device'`,[row!.message_id])).rowCount).toBe(1);
      await db.query(`INSERT INTO push_delivery_claims(message_id,device_token,status) VALUES($1,'test-device','delivered')`,[row!.message_id]);
      await runner().runOnce(); expect((await record())?.push_outcomes).toEqual([{platform:'ios',status:'delivered'}]);
    }
    if(email) expect(emails[0]?.html).toContain(`/beeline/chat/${R}?communityId=${W}`);
    await runner().runOnce(); expect(emails).toHaveLength(email?1:0);
  });
  it('skips missing email configuration without blocking the Room message',async()=>{
    vi.stubEnv('BEELINE_EMAIL_API_KEY',''); vi.stubEnv('BEELINE_EMAIL_FROM','');
    await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login) VALUES('google','outside',$1,'google','app','outside@example.test')`,[U]);
    await first(); await runner().runOnce(); await reply();
    await new NextDayCheckin(db,'https://web.usebeeline.app',undefined,()=>clock).runOnce();
    expect((await record())?.email_status).toBe('unconfigured'); expect((await record())?.sent_at).toBeTruthy();
  });
  it('never retries an uncertain email after restart or a second Room post',async()=>{
    await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login) VALUES('google','outside',$1,'google','app','outside@example.test')`,[U]);
    await first(); await runner().runOnce(); const command=await reply();
    const failing=vi.fn(async()=>{throw new Error('timeout');});
    await new NextDayCheckin(db,'https://web.usebeeline.app',failing,()=>clock).runOnce();
    await runner().runOnce(); expect(failing).toHaveBeenCalledTimes(1); expect(emails).toHaveLength(0);
    await expect(db.query(`INSERT INTO messages(id,room_id,author_id,request_id,text) VALUES($1,$2,$3,$4,'duplicate')`,
      ['f'.repeat(64),R,A,command.turn_request_id])).rejects.toThrow('already settled');
  });
  it('records a skip if the person returns while the agent is writing',async()=>{
    await first(); await runner().runOnce();
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,'I came back',$4)`,
      ['d'.repeat(64),R,U,new Date('2026-10-27T12:00:00Z')]);
    await expect(reply()).rejects.toThrow('no longer due');
    await runner().runOnce(); expect((await record())?.skip_reason).toBe('returned');
    expect((await record())?.sent_at).toBeNull(); expect(emails).toHaveLength(0);
  });
  it('retires an agent turn that completed without a message so it cannot clog future batches',async()=>{
    await first(); await runner().runOnce();
    await db.query(`UPDATE agent_commands SET state='complete' WHERE reason='free_agent_checkin'`);
    await runner().runOnce(); expect((await record())?.skip_reason).toBe('agent_no_message');
  });
  it('escapes Room text and links in minimal email HTML',()=>{
    const mail=renderCheckinEmail('Beebee','<script>"&hi</script>','https://web.usebeeline.app/?a="');
    expect(mail.html).not.toContain('<script>'); expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.text).toContain('<script>'); expect(mail.html).toContain('one-time note');
  });
  it.each([1,2])('renders mock A with %s owned starter stickers and the exact escaped message',async count=>{
    const second='c'.repeat(64);
    if (count===2) {
      await db.query(`INSERT INTO identities(id,kind,name,face_id) VALUES($1,'agent','Luna','hare')`,[second]);
      await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[second,U]);
      await db.query(`INSERT INTO free_agents(agent_id,owner_id,workspace_id,sealed_keys,starter_role) VALUES($1,$2,$3,'unused','luna')`,[second,U,W]);
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[W,R,second]);
    }
    await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login) VALUES('google','outside',$1,'google','app','outside@example.test')`,[U]);
    await first(); await runner().runOnce(); await reply(); await runner().runOnce();
    const html=emails[0]!.html;
    expect(html.match(/data-sticker=/g)).toHaveLength(count);
    expect(html).toContain(`/v1/email-faces/${A}.png`);
    if(count===2) expect(html).toContain(`/v1/email-faces/${second}.png`);
    expect(html.includes('are still in your Room.')).toBe(count===2);
    expect(html).toContain('/v1/email-logo.png');
    expect(html).toContain('Reply in Beeline');
    expect(html).toContain('@media(prefers-color-scheme:dark)');
    expect(html).not.toContain('<svg');

  });
  it('decorates with only this person’s starter agents who still belong to this Room',async()=>{
    const cases=[['c','Left',true,'luna',false],['d','Other owner',false,'luna',true],['e','Not starter',true,null,true],['f','Removed',true,'luna',true]] as const;
    const other='9'.repeat(64);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Other person')`,[other]);
    for(const [key,name,owned,role,member] of cases) {
      const agent=key.repeat(64), owner=owned?U:other;
      await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent',$2)`,[agent,name]);
      await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`,[agent,owner]);
      await db.query(`INSERT INTO free_agents(agent_id,owner_id,workspace_id,sealed_keys,starter_role,removed_at) VALUES($1,$2,$3,'unused',$4,$5)`,[agent,owner,W,role,key==='f'?new Date():null]);
      if(member) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[W,R,agent]);
    }
    await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login) VALUES('google','outside',$1,'google','app','outside@example.test')`,[U]);
    await first();await runner().runOnce();await reply();await runner().runOnce();
    expect(emails[0]!.html.match(/data-sticker=/g)).toHaveLength(1);
    for(const [key] of cases) expect(emails[0]!.html).not.toContain(`/email-faces/${key.repeat(64)}.png`);
  });
  it('preserves malicious text and line breaks as escaped bubble content, and leaves subject/plain text unchanged',()=>{
    const text='<script>alert("hi")</script>\n\n& next line';
    const mail=renderCheckinEmail('Bee<&',text,'https://example.test/?x="',[{id:A,name:'Bee<&'}]);
    expect(mail.html).toContain('&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt;\n\n&amp; next line');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('Bee&lt;&amp;');
    expect(mail.subject).toBe('Bee<& picked up where you left off');
    expect(mail.text).toBe(`${text}\n\nOpen in Beeline: https://example.test/?x="\n\nThis is a one-time note from your starter agent.`);
  });
  it('serves only bounded, cacheable PNG bytes without authentication, including custom uploaded portraits',async()=>{
    const live=new LiveHub();
    const server=createBeelineServer({database:db,auth:new TokenAuth(db,async()=>{throw Error('not used');}),phone,
      daemon:new DaemonService(db,live),live,mediaMaximumBytes:1024});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const imageUrl=`${origin}/v1/email-faces/${A}.png`;
    try {
      const response=await fetch(imageUrl+'?size=128&tilt=-6');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('cache-control')).toContain('public');
      const bytes=Buffer.from(await response.arrayBuffer());
      expect(await sharp(bytes).metadata()).toMatchObject({format:'png',hasAlpha:true});
      expect((await sharp(bytes).stats()).channels.some(c=>c.stdev>10)).toBe(true);
      const cached=await fetch(imageUrl+'?size=128&tilt=-6');
      expect(Buffer.from(await cached.arrayBuffer()).equals(bytes)).toBe(true);
      for (const params of ['size=999999','tilt=90','size=NaN','size=-1']) expect((await fetch(imageUrl+'?'+params)).status).toBe(400);
      expect((await fetch(origin+'/v1/email-faces/'+U+'.png')).status).toBe(404);
      for(const theme of ['light','dark']) {
        const logo=await fetch(origin+'/v1/email-logo.png?theme='+theme);
        expect(logo.status).toBe(200);
        expect(await sharp(Buffer.from(await logo.arrayBuffer())).metadata()).toMatchObject({format:'png'});
      }
      const uploaded=await sharp({create:{width:64,height:64,channels:3,background:'#ee0000'}}).webp().toBuffer();
      const id='44444444-4444-4444-8444-444444444444';
      await db.query(`INSERT INTO agent_avatars(id,agent_id,bytes,request_id,drawing) VALUES($1,$2,$3,'test','[]')`,[id,A,uploaded]);
      await db.query(`UPDATE identities SET avatar=$2 WHERE id=$1`,[A,'/v1/agent-avatars/'+id]);
      const custom=await fetch(imageUrl+'?size=64&tilt=0');
      const rgb=await sharp(Buffer.from(await custom.arrayBuffer())).removeAlpha().raw().toBuffer();
      expect(rgb[0]).toBeGreaterThan(220); expect(rgb[1]).toBeLessThan(15);
    } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
  });

});
