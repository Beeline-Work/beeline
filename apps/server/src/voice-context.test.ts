import { expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { readVoiceContext } from './voice-context.js';

it('VOICE-CONTEXT-1: includes every speaker, new room posts, attachment and card references in a bounded window', async () => {
  const db = new PgliteDatabase();
  const room = '375ebf52-b493-4982-bd6d-f3b8fe814a62';
  try {
    await migrate(db);
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','human','Alex','alex'),('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','agent','Ruby','ruby'),('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','agent','Goosey','goose')`);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [room]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$1,'Proof')`, [room]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('first',$1,'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','Goosey saw the whole call'),('source',$1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','Read that item')`, [room]);
    const first = await readVoiceContext(db, room, 'source', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(first).toEqual([{ role: 'user', content: expect.stringContaining('Goosey (@goose)') }]);
    expect(first[0]!.content).toContain('Goosey saw the whole call');
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments,presentation,card_type,card) VALUES('new',$1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',$2,$3,'card','document',$4)`,
      [room, 'x'.repeat(3000), JSON.stringify([{ name: 'notes.txt', url: '/v1/media/notes' }]), JSON.stringify({ title: 'Call plan', url: 'https://example.com/plan' })]);
    const next = await readVoiceContext(db, room, 'source', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(next).toHaveLength(2);
    const posted = next.find(item => item.content.includes('Alex (@alex)'))!;
    expect(posted.content).toContain('notes.txt: /v1/media/notes');
    expect(posted.content).toContain('Call plan: https://example.com/plan');
    expect(posted.content.length).toBeLessThanOrEqual(1600);
    expect(posted.content).not.toContain('x'.repeat(801));
  } finally { await db.close(); }
}, 30_000);
