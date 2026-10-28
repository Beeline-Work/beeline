import { expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { cleanupUnfinishedAppSignIns } from './unfinished-app-sign-ins.js';
it('CONNECTORS-1 backfill preserves successful legacy accounts and previously connected cards', async () => {
  const db=new PgliteDatabase(), owner='a'.repeat(64), workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
  try {
    await migrate(db);
    await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'human','Fixture')",[owner]);
    await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Fixture')",[workspace]);
    await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Fixture')",[room,workspace]);
    const ids=['33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555'];
    for(const [index,id] of ids.entries()) await db.query(`INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route,composio_account_id,composio_link_expires_at)
      VALUES($1,$2,$3,$4,$4,'composio','composio','account',CASE WHEN $5 THEN NULL ELSE now()-interval '1 day' END)`,[id,workspace,owner,'app-'+index,index===0]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,card_type,card) VALUES($1,$2,$3,'','app-sign-in',$4::jsonb)`,['b'.repeat(64),room,owner,JSON.stringify({appId:ids[1],status:'connected'})]);
    await migrate(db);
    expect(await cleanupUnfinishedAppSignIns(db)).toBe(1);
    expect((await db.query('SELECT id FROM workspace_apps')).rows).toHaveLength(3);
    expect(await cleanupUnfinishedAppSignIns(db,true)).toBe(1);
    expect((await db.query<{id:string}>('SELECT id FROM workspace_apps ORDER BY id')).rows.map(row=>row.id)).toEqual(ids.slice(0,2));
  }finally{await db.close();}
},60000);
