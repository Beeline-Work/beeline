import { SERVER_LEASE_EVIDENCE_TABLE } from './postgres-live-notifications.js';
import { liveControlNotificationSchema } from './postgres-live.js';
import type { SqlDatabase } from './database.js';

/** Committed lease evidence is infrastructure control, never a user-state
 * invalidation. The existing PostgreSQL LISTEN session carries this hint. */
export { SERVER_LEASE_EVIDENCE_TABLE } from './postgres-live-notifications.js';
export const SERVER_LEASE_DEADLINE_SCHEMA = `
${liveControlNotificationSchema()}
CREATE OR REPLACE FUNCTION beeline_notify_server_lease() RETURNS trigger AS $$
BEGIN
  PERFORM beeline_notify_live_control(jsonb_build_object(
    'table','${SERVER_LEASE_EVIDENCE_TABLE}','operation',TG_OP,'roomId','',
    'instanceId',COALESCE(NEW.instance_id,OLD.instance_id),
    'renewedAt',floor(extract(epoch FROM COALESCE(NEW.renewed_at,OLD.renewed_at))*1000)::bigint,
    'removed',TG_OP='DELETE')::text);
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_notify_server_lease ON live_server_instances;
CREATE TRIGGER beeline_notify_server_lease AFTER INSERT OR UPDATE OR DELETE ON live_server_instances
FOR EACH ROW EXECUTE FUNCTION beeline_notify_server_lease();
`;

/** One timer for the earliest actual known lease expiry. Renewals update local
 * evidence directly; they never cause a SELECT or scan. A failed transition
 * parks until a real new lease event/recovery, rather than arming a retry. */
export class ServerLeaseDeadlines {
  private readonly deadlines=new Map<string,number>();
  private readonly newestEvidence=new Map<string,number>();
  private timer?:ReturnType<typeof setTimeout>;
  private running?:Promise<void>;
  private stopped=false;
  constructor(private readonly database:SqlDatabase,private readonly expiryMs:number,
    private readonly expire:()=>Promise<void>,private readonly report:(error:unknown)=>void,
    private readonly now=Date.now){}

  /** One initialization read per process/feed acquisition. */
  async recover():Promise<void>{
    if(this.stopped)return;
    clearTimeout(this.timer);this.timer=undefined;
    this.deadlines.clear();this.newestEvidence.clear();
    const rows=await this.database.query<{instance_id:string;renewed_at:Date}>(
      'SELECT instance_id,renewed_at FROM live_server_instances');
    if(this.stopped)return;
    for(const row of rows.rows)this.observe(row.instance_id,row.renewed_at.getTime());
  }
  observe(instance:string,renewedAt:number,removed=false):void{
    if(this.stopped||!instance||!Number.isSafeInteger(renewedAt))return;
    const previous=this.newestEvidence.get(instance);
    if(previous!==undefined && (renewedAt<previous || (!removed && renewedAt===previous)))return;
    this.newestEvidence.set(instance,renewedAt);
    if(removed)this.deadlines.delete(instance);
    else this.deadlines.set(instance,renewedAt+this.expiryMs);
    this.arm();
  }
  private arm():void{
    clearTimeout(this.timer);this.timer=undefined;
    if(this.stopped||this.running||!this.deadlines.size)return;
    const due=Math.min(...this.deadlines.values());
    this.timer=setTimeout(()=>{this.timer=undefined;this.runExpiry();},Math.max(0,due-this.now()));
    this.timer.unref?.();
  }
  private runExpiry():void{
    if(this.stopped||this.running)return;
    const at=this.now();let expired=false;
    for(const [instance,due]of this.deadlines)if(due<=at){this.deadlines.delete(instance);expired=true;}
    if(!expired){this.arm();return;}
    this.running=this.expire().catch(this.report).finally(()=>{this.running=undefined;this.arm();});
  }
  async stop():Promise<void>{
    this.stopped=true;clearTimeout(this.timer);this.timer=undefined;this.deadlines.clear();this.newestEvidence.clear();
    await this.running;
  }
}
