import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { localDatabase, rooms, agents, corner } from './fixture.mjs';
export async function fixtureStimulus() {
  const db = new pg.Client({ connectionString: localDatabase(process.env.LATENCY_RIG_DATABASE_URL) });
  await db.connect();
  return {
    async incoming(room = rooms[0]) {
      if (![...rooms, corner].includes(room)) throw new Error('Not a fixture Room');
      const id = randomBytes(32).toString('hex');
      const text = `Incoming fixture ${id.slice(0, 16)}`;
      await db.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)', [id, room, agents[0], text]);
      return { id, text };
    },
    async stream() {
      const request = `transcript-${randomBytes(8).toString('hex')}`;
      try {
        for (const agent of agents) await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status)
          VALUES($1,$2,$3,'working')`, [corner, request, agent]);
        for (let chunk = 1; chunk <= 30; chunk++) {
          for (const [index, agent] of agents.entries()) {
            await db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
              VALUES($1,$2,$3,'draft',$4) ON CONFLICT(room_id,agent_id,turn_id,kind)
              DO UPDATE SET body=EXCLUDED.body,updated_at=now()`,
            [corner, agent, request, JSON.stringify({ text: `Stream ${index}: ${'repeatable chunk '.repeat(chunk)}`, latestChunk: 'repeatable chunk ' })]);
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } finally {
        await db.query('DELETE FROM live_outputs WHERE room_id=$1 AND turn_id=$2', [corner, request]);
        await db.query("UPDATE agent_turns SET status='complete' WHERE room_id=$1 AND request_id=$2", [corner, request]);
      }
    },
    async settled(text) {
      return (await db.query('SELECT id FROM messages WHERE room_id=ANY($1::uuid[]) AND text=$2', [[...rooms, corner], text])).rowCount > 0;
    },
    close() { return db.end(); },
  };
}
