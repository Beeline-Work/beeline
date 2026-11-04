import type {SqlDatabase} from '../database.js';
import type {LeaderConnection} from '../background-leader.js';

/** PGlite has no real dedicated PostgreSQL backend/session lock. This explicit
 * fixture overrides only the real backend guard; real-PG suites must NEVER
 * import/install it. Production schema contains no bypass or fake-proof hook. */
export async function installBackgroundOwnerTestProof(db:SqlDatabase):Promise<void>{
  await db.query(`CREATE TABLE IF NOT EXISTS background_owner_test_backends(pid integer PRIMARY KEY,started_at timestamptz NOT NULL,held boolean NOT NULL);
    CREATE OR REPLACE FUNCTION beeline_background_backend_holds(owner_pid integer,owner_started timestamptz)
    RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT EXISTS(SELECT 1 FROM background_owner_test_backends
      WHERE pid=owner_pid AND started_at=owner_started AND held) $$;`);
}
let nextPid=1_000_000;
export async function backgroundOwnerTestLock(db:SqlDatabase,held=true):Promise<Pick<LeaderConnection,'query'>&{lose():Promise<void>}>{
  const pid=++nextPid;
  const row=(await db.query<{backend_pid:number;backend_start:string;held:boolean}>(`INSERT INTO background_owner_test_backends(pid,started_at,held)
    VALUES($1,clock_timestamp(),$2) RETURNING pid backend_pid,started_at::text backend_start,held`,[pid,held])).rows[0]!;
  return {query:async<Row>()=>({rows:[row as unknown as Row]}),lose:async()=>{row.held=false;await db.query(`UPDATE background_owner_test_backends SET held=false WHERE pid=$1`,[pid]);}};
}
