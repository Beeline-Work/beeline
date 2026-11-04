import {BackgroundOwnership,type BackgroundEpoch} from './background-ownership.js';
import type {SqlDatabase} from './database.js';

export const TRAY_CLOCK_HEALTH_OWNER_TRIGGER=`CREATE TRIGGER beeline_tray_clock_health_owner AFTER INSERT OR UPDATE OR DELETE ON background_leader_owners FOR EACH ROW EXECUTE FUNCTION beeline_tray_clock_health_change();`;

/** One current aggregate-owner receipt, never a client inventory or a lease. */
export const TRAY_CLOCK_HEALTH_SCHEMA=`
CREATE TABLE IF NOT EXISTS tray_clock_health(
 id integer PRIMARY KEY CHECK(id=1),instance_id text NOT NULL,generation bigint NOT NULL,
 claim_nonce uuid NOT NULL,lock_backend_pid integer NOT NULL,lock_backend_start timestamptz NOT NULL,
 source_epoch text NOT NULL,source_through bigint NOT NULL,
 readiness_epoch text NOT NULL,readiness_through bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS tray_clock_workspace_due_idx ON tray_clock_deadlines(workspace_id,due_at,id) WHERE state='pending';
CREATE OR REPLACE FUNCTION beeline_tray_clock_health_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invalidated boolean;
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NEW;END IF;
 invalidated:=TG_TABLE_NAME='background_leader_owners' OR TG_OP='DELETE';
 PERFORM beeline_journal('jobs:tray-clock-health',jsonb_build_object('sourceTable','tray-clock-health','version',1,'invalidated',invalidated));
 PERFORM beeline_notify_live_control(jsonb_build_object('table','router_source','operation','UPDATE','roomId','',
   'journalStreams',jsonb_build_array('jobs:tray-clock-health'))::text);
 RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS beeline_tray_clock_health_receipt ON tray_clock_health;
CREATE TRIGGER beeline_tray_clock_health_receipt AFTER INSERT OR UPDATE OR DELETE ON tray_clock_health FOR EACH ROW EXECUTE FUNCTION beeline_tray_clock_health_change();
DO $$ BEGIN
 IF to_regclass('background_leader_owners') IS NOT NULL THEN
  EXECUTE 'DROP TRIGGER IF EXISTS beeline_tray_clock_health_owner ON background_leader_owners';
  EXECUTE '${TRAY_CLOCK_HEALTH_OWNER_TRIGGER}';
 END IF;
END $$;
INSERT INTO live_streams(id) VALUES('jobs:tray-clock-health') ON CONFLICT DO NOTHING;
`;

/** Persisted owner evidence for shared background availability. Tray reads
 * check each item's deadline independently of this owner's health. */
export const TRAY_CLOCK_OWNER_HEALTH_PREDICATE_SQL=`EXISTS(
 SELECT 1 FROM tray_clock_health health
 JOIN background_leader_owners owner ON owner.name='background'
   AND owner.instance_id=health.instance_id AND owner.generation=health.generation
   AND owner.claim_nonce=health.claim_nonce AND owner.lock_backend_pid=health.lock_backend_pid
   AND owner.lock_backend_start=health.lock_backend_start AND owner.released_at IS NULL
 JOIN live_server_instances server ON server.instance_id=owner.instance_id
 JOIN live_streams source ON source.id='jobs:tray-clock' AND source.epoch=health.source_epoch AND source.sequence>=health.source_through
 JOIN live_streams readiness ON readiness.id='jobs:tray-clock-readiness' AND readiness.epoch=health.readiness_epoch AND readiness.sequence>=health.readiness_through
 WHERE health.id=1 AND server.renewed_at>clock_timestamp()-interval '90 seconds'
   AND beeline_background_backend_holds(owner.lock_backend_pid,owner.lock_backend_start)
)`;
const TRAY_CLOCK_HEALTH_PREDICATE_SQL=`${TRAY_CLOCK_OWNER_HEALTH_PREDICATE_SQL} AND NOT EXISTS(SELECT 1 FROM tray_clock_deadlines overdue
 WHERE overdue.workspace_id=clock.workspace_id AND overdue.state='pending' AND overdue.due_at<=statement_timestamp())`;

export class TrayClockHealthUnavailable extends Error{
 constructor(){super('Tray clock initial drain or owner evidence unavailable');}
}
/** Invoked once after both initial domain drains and readiness complete. The
 * existing actual-COMMIT owner guard rolls back a lost-backend publication. */
export class TrayClockHealth{
 constructor(private readonly ownership:BackgroundOwnership){}
 async publish(epoch:BackgroundEpoch):Promise<void>{
  await this.ownership.withTransaction(epoch,'tray.readiness',async db=>{
   const result=await db.query(`INSERT INTO tray_clock_health
    (id,instance_id,generation,claim_nonce,lock_backend_pid,lock_backend_start,source_epoch,source_through,readiness_epoch,readiness_through)
    SELECT 1,owner.instance_id,owner.generation,owner.claim_nonce,owner.lock_backend_pid,owner.lock_backend_start,
      source.epoch,source.sequence,readiness.epoch,readiness.sequence
    FROM background_leader_owners owner
    JOIN live_streams source ON source.id='jobs:tray-clock'
    JOIN live_streams readiness ON readiness.id='jobs:tray-clock-readiness'
    WHERE owner.name='background' AND owner.instance_id=$1 AND owner.generation=$2::bigint
      AND EXISTS(SELECT 1 FROM tray_clock_readiness_floor WHERE id=1 AND seeding_done)
      AND NOT EXISTS(SELECT 1 FROM tray_clock_readiness WHERE phase<>'done')
      AND NOT EXISTS(SELECT 1 FROM(SELECT due_at FROM tray_clock_deadlines
        WHERE state='pending' AND kind<>'choice-close' ORDER BY due_at,id LIMIT 1) pending WHERE due_at<=clock_timestamp())
      AND NOT EXISTS(SELECT 1 FROM(SELECT due_at FROM tray_clock_deadlines
        WHERE state='pending' AND kind='choice-close' ORDER BY due_at,id LIMIT 1) pending WHERE due_at<=clock_timestamp())
    ON CONFLICT(id) DO UPDATE SET instance_id=EXCLUDED.instance_id,generation=EXCLUDED.generation,
      claim_nonce=EXCLUDED.claim_nonce,lock_backend_pid=EXCLUDED.lock_backend_pid,lock_backend_start=EXCLUDED.lock_backend_start,
      source_epoch=EXCLUDED.source_epoch,source_through=EXCLUDED.source_through,
      readiness_epoch=EXCLUDED.readiness_epoch,readiness_through=EXCLUDED.readiness_through
    RETURNING id`,[epoch.instanceId,epoch.generation]);
   if(result.rowCount!==1)throw new TrayClockHealthUnavailable();
  });
 }
}

/** Pure proof/accessor seam; production producers compose the expression. */
export async function readTrayClockHealth(db:SqlDatabase,workspaceId:string):Promise<boolean>{
 const row=(await db.query<{healthy:boolean}>(`SELECT (${TRAY_CLOCK_HEALTH_PREDICATE_SQL}) healthy
   FROM tray_clock_state clock WHERE clock.workspace_id=$1`,[workspaceId])).rows[0];
 return row?.healthy===true;
}
