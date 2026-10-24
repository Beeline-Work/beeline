import pg from 'pg';
import { localDatabase, messages, viewer, workspace, rooms, agents } from './fixture.mjs';

const database = new pg.Client({ connectionString: localDatabase(process.env.LATENCY_RIG_DATABASE_URL) });
await database.connect();
try {
  await database.query('BEGIN');
  await database.query(`INSERT INTO identities(id,kind,name,handle,welcome_cards_due)
    VALUES($1,'human','Transcript Reader','transcript-reader',false) ON CONFLICT(id) DO UPDATE SET welcome_cards_due=false`, [viewer]);
  await database.query(`INSERT INTO workspaces(id,name,visibility) VALUES($1,'Transcript speed fixture','invite-only') ON CONFLICT DO NOTHING`, [workspace]);
  for (const [index, agent] of agents.entries()) {
    await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent',$2,$3) ON CONFLICT DO NOTHING`, [agent, `Fixture Agent ${index}`, `transcript-agent-${index}`]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [agent, viewer]);
  }
  for (const identity of [viewer, ...agents]) {
    await database.query(`INSERT INTO memberships(workspace_id,identity_id,role)
      SELECT $1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2 AND removed_at IS NULL)`, [workspace, identity, identity === viewer ? 'owner' : 'member']);
  }
  for (const [index, room] of rooms.entries()) {
    await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [room, workspace, viewer, `Transcript ${index ? 'B' : 'A'}`]);
    for (const identity of [viewer, ...agents]) {
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        SELECT $1,$2,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM memberships WHERE room_id=$2 AND identity_id=$3 AND removed_at IS NULL)`, [workspace, room, identity, identity === viewer ? 'owner' : 'member']);
    }
    for (const message of messages(room, process.env.TRANSCRIPT_IMAGE_ORIGIN ?? 'http://127.0.0.1:19882')) {
      await database.query(`INSERT INTO messages(id,room_id,author_id,text,attachments,reactions,reply_to_message_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET
          author_id=EXCLUDED.author_id, text=EXCLUDED.text,
          attachments=EXCLUDED.attachments, reactions=EXCLUDED.reactions,
          reply_to_message_id=EXCLUDED.reply_to_message_id, created_at=EXCLUDED.created_at`,
      [message.id, room, message.author, message.text, JSON.stringify(message.attachments), JSON.stringify(message.reactions), message.reply, message.createdAt]);
    }
  }
  await database.query('COMMIT');
  console.log(JSON.stringify({ workspace, rooms, agents, messagesPerRoom: 1000 }));
} catch (error) {
  await database.query('ROLLBACK');
  throw error;
} finally { await database.end(); }
