import { BackgroundOwnership, type BackgroundEpoch } from './background-ownership.js';
import { consumeTrayClockInTransaction, type TrayClockClaim } from './tray-clock-source.js';
import {ROUTER_AUTHORITY_LOCK} from './router-authority-lock.js';

export type TrayDeadline = Readonly<Omit<TrayClockClaim, 'kind'> & {
  kind: Exclude<TrayClockClaim['kind'], 'choice-close'>; remainingMs: number;
}>;
export type TrayClockDrain = Readonly<{
  attempted: number; consumed: number; next: TrayDeadline | null;
  /** Only an actual still-due semantic row permits bounded continuation. */
  continuation: boolean;
}>;

/** Uninstalled. Reuses the existing aggregate owner/90s lease; this creates no
 * leader, evidence loop, retained receipt history or provider callback. The
 * ephemeral row queues an exact owner check at actual SQL COMMIT and deletes
 * itself there, matching the existing turn-owned effect fence pattern. */
export const TRAY_CLOCK_OWNER_SCHEMA = `
CREATE TABLE IF NOT EXISTS tray_clock_owner_fences(
 transaction_id bigint PRIMARY KEY,instance_id text NOT NULL,generation bigint NOT NULL,claim_nonce uuid NOT NULL
);
CREATE OR REPLACE FUNCTION beeline_register_tray_clock_owner(owner_instance text,owner_generation bigint,owner_nonce uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE previous tray_clock_owner_fences%ROWTYPE;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
   RAISE EXCEPTION 'Tray expiry requires read committed' USING ERRCODE='23514';
 END IF;
 SELECT * INTO previous FROM tray_clock_owner_fences WHERE transaction_id=txid_current();
 IF FOUND THEN
   IF previous.instance_id IS DISTINCT FROM owner_instance OR previous.generation IS DISTINCT FROM owner_generation
     OR previous.claim_nonce IS DISTINCT FROM owner_nonce THEN
     RAISE EXCEPTION 'Tray transaction crosses owner generations' USING ERRCODE='23514';
   END IF;
   RETURN;
 END IF;
 INSERT INTO tray_clock_owner_fences VALUES(txid_current(),owner_instance,owner_generation,owner_nonce);
END;
$$;
CREATE OR REPLACE FUNCTION beeline_commit_tray_clock_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM background_leader_owners owner JOIN live_server_instances server ON server.instance_id=owner.instance_id
 WHERE owner.name='background' AND owner.instance_id=NEW.instance_id AND owner.generation=NEW.generation
   AND owner.claim_nonce=NEW.claim_nonce AND owner.released_at IS NULL
   AND beeline_background_backend_holds(owner.lock_backend_pid,owner.lock_backend_start)
   AND server.renewed_at>clock_timestamp()-interval '90 seconds' FOR SHARE OF owner,server;
 IF NOT FOUND THEN RAISE EXCEPTION 'Tray expiry owner expired before commit' USING ERRCODE='23514'; END IF;
 DELETE FROM tray_clock_owner_fences WHERE transaction_id=NEW.transaction_id;
 RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS beeline_commit_tray_clock_owner ON tray_clock_owner_fences;
CREATE CONSTRAINT TRIGGER beeline_commit_tray_clock_owner AFTER INSERT ON tray_clock_owner_fences
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION beeline_commit_tray_clock_owner();
`;

/** A real source/init/exact-due wake may invoke one bounded transaction. The
 * existing scheduler must coalesce its own wakes; this adapter neither loops
 * nor retries. Exceptions return no next deadline or continuation permission.
 * Card expiry changes the committed projection clock, not the external approval
 * or sign-in operation. Choices require their real domain terminal adapter and
 * remain excluded; a due choice cannot pin this adapter's next wake at zero.
 */
export class TrayClockOwner {
  constructor(private readonly ownership: BackgroundOwnership) {}
  drain(epoch: BackgroundEpoch): Promise<TrayClockDrain> {
    return this.ownership.withTransaction(epoch, 'tray.expire', async db => {
      await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[ROUTER_AUTHORITY_LOCK]);
      const claims = (await db.query<TrayClockClaim&{workspace_id:string}>(`SELECT id,incarnation,revision::text,kind,workspace_id,
        to_char(due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "dueAt"
        FROM tray_clock_deadlines WHERE state='pending' AND kind<>'choice-close'
          AND due_at<=clock_timestamp() ORDER BY due_at,id LIMIT 100`)).rows;
      if(claims.length)await db.query('SELECT beeline_tray_clock_lock_workspaces($1::uuid[])',[[...new Set(claims.map(claim=>claim.workspace_id))]]);
      let consumed = 0;
      for (const claim of claims) if (await consumeTrayClockInTransaction(db, claim)) consumed++;
      const next = (await db.query<TrayDeadline>(`SELECT id,incarnation,revision::text,kind,
        to_char(due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "dueAt",
        EXTRACT(epoch FROM (due_at-clock_timestamp()))::double precision*1000 AS "remainingMs"
        FROM tray_clock_deadlines WHERE state='pending' AND kind<>'choice-close'
        ORDER BY due_at,id LIMIT 1`)).rows[0];
      return Object.freeze({ attempted: claims.length, consumed, next: next ? Object.freeze({ ...next }) : null,
        continuation: next !== undefined && next.remainingMs <= 0 });
    });
  }
}
