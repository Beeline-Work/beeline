/** Remove only generated scenario traffic from the disposable fixture Rooms. */
import pg from 'pg';
import { localDatabase, rooms, corner, messages } from './fixture.mjs';
const db = new pg.Client({ connectionString: localDatabase(process.env.LATENCY_RIG_DATABASE_URL) });
await db.connect();
try {
  await db.query('BEGIN');
  for (const room of [...rooms, corner]) {
    const ids = messages(room, 'http://127.0.0.1:19882').map(message => message.id);
    await db.query('DELETE FROM live_outputs WHERE room_id=$1', [room]);
    await db.query('DELETE FROM agent_turns WHERE room_id=$1', [room]);
    await db.query('DELETE FROM messages WHERE room_id=$1 AND NOT(id=ANY($2::text[]))', [room, ids]);
  }
  await db.query('COMMIT');
  console.log('Reset scenario traffic; deterministic messages retained.');
} catch (error) { await db.query('ROLLBACK'); throw error; }
finally { await db.end(); }
