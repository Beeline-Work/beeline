import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { readMediaMetadata } from './phone-media.js';
import { migratedDatabase,type PgliteDatabase } from './test-support.js';
const VIEWER='a'.repeat(64),OWNER='b'.repeat(64),OUTSIDER='c'.repeat(64);
const WORKSPACE='11111111-1111-4111-8111-111111111111',ROOM='22222222-2222-4222-8222-222222222222';
const OBJECT='33333333-3333-4333-8333-333333333333',THUMB='44444444-4444-4444-8444-444444444444';
const SHA='d'.repeat(64);
describe('media metadata access and bounded previews',()=>{
  let db:PgliteDatabase;
  beforeEach(async()=>{
    db=await migratedDatabase();
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Reader'),($2,'human','Owner'),($3,'human','Other')`,[VIEWER,OWNER,OUTSIDER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`,[WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`,[ROOM,WORKSPACE,VIEWER]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`,[WORKSPACE,ROOM,VIEWER]);
    await db.query(`INSERT INTO objects(id,owner_id,kind,key,mime,size,sha256,state,expires_at)
      VALUES($1,$2,'artifact','artifact/fixture','application/pdf',2000,$3,'ready',now()+interval '1 day')`,[OBJECT,OWNER,SHA]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES('file',$1,$2,'File',$3::jsonb)`,
      [ROOM,OWNER,JSON.stringify([{url:`https://example.test/v1/media/${OBJECT}`,name:'file.pdf',mimeType:'application/pdf',size:2000}])]);
  });
  afterEach(async()=>{await db.close();});
  it('ignores malformed media-looking paths without rejecting a legacy attachment write',async()=>{
    const path='/v1/media/'+'-'.repeat(36);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES('legacy-path',$1,$2,'Legacy',$3::jsonb)`,
      [ROOM,OWNER,JSON.stringify([{url:path}])]);
    expect((await db.query(`SELECT id FROM messages WHERE id='legacy-path'`)).rowCount).toBe(1);
    expect((await db.query(`SELECT scope FROM router_authority WHERE scope=$1`,['object:'+'-'.repeat(36)])).rowCount).toBe(0);
  });
  it('returns immutable metadata only to its owner or a current Room member',async()=>{
    const shared=await readMediaMetadata(db,OBJECT,VIEWER),owned=await readMediaMetadata(db,OBJECT,OWNER);
    expect(shared).toMatchObject({objectId:OBJECT,sha256:SHA,size:2000,mimeType:'application/pdf'});
    expect(owned).toEqual(shared);
    await expect(readMediaMetadata(db,OBJECT,OUTSIDER)).rejects.toMatchObject({status:404});
  });
  it('denies a Room reader after membership is revoked',async()=>{
    await readMediaMetadata(db,OBJECT,VIEWER);
    await db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,[ROOM,VIEWER]);
    await expect(readMediaMetadata(db,OBJECT,VIEWER)).rejects.toMatchObject({status:404});
  });
  it('deleting a reference removes Room access while preserving owner access',async()=>{
    const owned=await readMediaMetadata(db,OBJECT,OWNER);
    await db.query(`UPDATE messages SET deleted_at=now() WHERE id='file'`);
    await expect(readMediaMetadata(db,OBJECT,VIEWER)).rejects.toMatchObject({status:404});
    expect(await readMediaMetadata(db,OBJECT,OWNER)).toEqual(owned);
  });
  it('denies expired objects to both the owner and Room readers',async()=>{
    await db.query(`INSERT INTO object_expirations(id) VALUES($1)`,[OBJECT]);
    await expect(readMediaMetadata(db,OBJECT,OWNER)).rejects.toMatchObject({status:404});
    await expect(readMediaMetadata(db,OBJECT,VIEWER)).rejects.toMatchObject({status:404});
  });
  it('returns only an existing raster thumbnail within16KiB and never truncates the full file',async()=>{
    await db.query(`INSERT INTO objects(id,owner_id,kind,key,mime,size,sha256,state,expires_at)
      VALUES($1,$2,'media','media/thumbnail','image/webp',1000,$3,'ready',now()+interval '1 day')`,[THUMB,OWNER,'e'.repeat(64)]);
    await db.query(`UPDATE messages SET attachments=$1::jsonb WHERE id='file'`,[JSON.stringify([{url:`/v1/media/${OBJECT}`,thumbnailUrl:`/v1/media/${THUMB}`}])]);
    expect((await readMediaMetadata(db,OBJECT,VIEWER)).thumbnail).toMatchObject({objectId:THUMB,size:1000,mimeType:'image/webp'});
    await db.query(`UPDATE objects SET size=20000 WHERE id=$1`,[THUMB]);
    expect((await readMediaMetadata(db,OBJECT,VIEWER)).thumbnail).toBeUndefined();
    expect((await readMediaMetadata(db,OBJECT,VIEWER)).size).toBe(2000);
  });
});
