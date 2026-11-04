import { noteBlockedCornerChecks, reconcileConfiguredCornerReviewers } from './agent-command.js';
import { reclaimExpiredCommandLeases } from './turn-silence-notice.js';
import { runInstitutionalCuratorCycle } from './institutional-curator.js';
import type { SqlDatabase } from './database.js';
import { BackgroundWork, retryRolledBackWork } from './background-work.js';
import { BACKGROUND_SOURCES, RETENTION_RULES, backgroundDueKey } from './background-due-source.js';
import { subscribeCommandCompletion, subscribeCommandCompletionFamily } from './command-completion.js';
import { cleanupUnfinishedAppSignIns } from './unfinished-app-sign-ins.js';
import { retryOwedMentions } from './owed-mentions.js';
import { retryMcpMemberRoutes } from './rooms-mcp-members.js';
import type { LiveHub } from './live.js';
import { backgroundDatabaseCut, backgroundDatabaseNow, backgroundNextDelay } from './background-deadline-clock.js';

/** Time comes from the persisted obligation's database clock. Past eligibility
 * remains parked after an uncertain effect. Read-only observations and
 * atomic retention statements may retry proven rollbacks independently. */

type DueCallback = () => Promise<number | void>;
export interface BackgroundDeadlineFamily {
  name: string;
  run: DueCallback;
  /** Read-only deadline observation, separate from the business callback. */
  next?: (admittedAt?:string) => Promise<number | undefined>;
}

/** Shared by the real entrypoint and P12. One startup/recovery admission,
 * committed family input, or stored due record. No recurring interval. */
export function registerBackgroundDeadlineFamilies(work: BackgroundWork,
  families: readonly BackgroundDeadlineFamily[],
  execute: (name: string, run: DueCallback) => Promise<{ ok: boolean; value?: number | void }>,
  db:SqlDatabase,
): void {
  for (const family of families) work.addDeadline(family.name, async () => {
    const outcome = await execute(family.name, async()=>{
      const cut=await retryRolledBackWork(()=>backgroundDatabaseCut(db));
      await family.run();return family.next ? retryRolledBackWork(()=>family.next!(cut)) : undefined;
    });
    if (outcome.ok) return outcome.value;
  });
}

export function subscribeBackgroundFamilies(db: SqlDatabase, live: LiveHub,
  names: readonly string[], wake: (name: string) => void): () => void {
  const stops = names.map(name => subscribeCommandCompletion(backgroundDueKey(name), () => wake(name)));
  const recover = () => { for (const name of names) wake(name); };
  const stopDatabase = db.onRecovery?.(recover), stopLive = live.subscribeResync(recover);
  return () => { for (const stop of stops) stop(); stopDatabase?.(); stopLive(); };
}

/** Each retention table is independently armed from its own durable minimum.
 * Batch continuation is permitted only after actually deleting a full batch. */
export function retentionDeadlineFamilies(db: SqlDatabase): BackgroundDeadlineFamily[] {
  return RETENTION_RULES.map(([table, due, predicate]) => {
    let full = false;
    return {
      name: `retention:${table}`,
      run: async () => {
        const result = await retryRolledBackWork(()=>db.query(`DELETE FROM ${table} WHERE ctid IN (
          SELECT ctid FROM ${table} WHERE (${predicate}) AND (${due})<=clock_timestamp()
          LIMIT 1000 FOR UPDATE SKIP LOCKED)`));
        full = result.rowCount === 1000;
      },
      next: async cut => full ? 0 : backgroundNextDelay(db, `SELECT (${due}) due_at FROM ${table} WHERE ${predicate}`,cut),
    };
  });
}

export function maintenanceDeadlineFamilies(db: SqlDatabase): BackgroundDeadlineFamily[] {
  return [
    ...retentionDeadlineFamilies(db),
    { name: 'unfinished-app-sign-ins', run: async () => { await cleanupUnfinishedAppSignIns(db, true); }, next: cut => backgroundNextDelay(db,
      `SELECT LEAST(composio_link_expires_at,CASE WHEN composio_account_id IS NULL THEN created_at+interval '10 minutes' END) due_at
       FROM workspace_apps WHERE transport='composio' AND authorised_at IS NULL AND sign_in_error IS NULL`,cut) },
    { name: 'owed-mentions', run: async () => { await retryOwedMentions(db); }, next: cut => backgroundNextDelay(db,
      `SELECT created_at+(CASE rewakes WHEN 0 THEN 5 WHEN 1 THEN 15 ELSE 45 END)*interval '1 minute' due_at
       FROM rooms_mcp_mentions WHERE cleared_at IS NULL AND rewakes<3`,cut) },
    // Routing failure does not manufacture another thirty-second deadline.
    { name: 'mcp-member-routes', run: async () => { await retryMcpMemberRoutes(db); }, next:cut=>backgroundNextDelay(db,
      `SELECT created_at+interval '30 seconds' due_at FROM rooms_mcp_pending_routes WHERE attempts=0`,cut) },
  ];
}

/** Actual former repair composition, shared verbatim with the PostgreSQL proof. */
export function repairDeadlineFamilies(db:SqlDatabase,options:{
  live:LiveHub;
  phone:Pick<import('./phone-service.js').PhoneService,'flushPendingMentionNotices'>;
  mediaExpiry:Pick<import('./background.js').MediaExpiryLoop,'runDeadline'|'nextDelayMs'>;
  institutionalMemory:import('./institutional-memory-shadow.js').InstitutionalMemoryShadowConfig;
  institutionalAnchors?:import('./institutional-skill-anchors.js').InstitutionalSkillAnchorSource;
  voice?:{recover():Promise<void>};
  voiceDeadlines:BackgroundRecordDeadlines;
}):BackgroundDeadlineFamily[]{
  const {live,phone,mediaExpiry,institutionalMemory,institutionalAnchors,voice,voiceDeadlines}=options;
  return [
    ...maintenanceDeadlineFamilies(db),
    ...(voice?[{name:'voice-call-recovery',run:async()=>{
      voiceDeadlines.consume();await voice.recover();
      await voiceDeadlines.capture(async()=>(await db.query<{id:string;due:number|null}>(
        `SELECT id,(extract(epoch FROM runtime_until)*1000)::float8 due FROM voice_calls WHERE ended_at IS NULL`)).rows);
    },next:async()=>voiceDeadlines.next()}]:[]),
    {name:'corner-reviewers',run:async()=>{await reconcileConfiguredCornerReviewers(db);}},
    {name:'media-expiry',run:()=>mediaExpiry.runDeadline(),next:cut=>mediaExpiry.nextDelayMs(cut)},
    {name:'corner-checks-blocked',run:async()=>{await noteBlockedCornerChecks(db);},next:cut=>backgroundNextDelay(db,
      `SELECT created_at+interval '2 minutes' due_at FROM agent_commands WHERE state='pending' AND action='input'
       UNION ALL SELECT to_timestamp((lifecycle->'checksSummary'->>'updatedAt')::double precision)+interval '1 hour'
       FROM corner_github_cache WHERE lifecycle->>'checks'='failing' AND lifecycle->'checksSummary'->>'updatedAt' IS NOT NULL`,cut)},
    {name:'expired-command-leases',run:async()=>{await reclaimExpiredCommandLeases(db,live);},next:cut=>backgroundNextDelay(db,
      `SELECT lease_expires_at+interval '5 minutes' due_at FROM agent_commands WHERE state='claimed' AND turn_owner_connection_id IS NULL`,cut)},
    {name:'mention-notices',run:async()=>{await phone.flushPendingMentionNotices();},next:cut=>backgroundNextDelay(db,
      `SELECT due_at FROM pending_mention_notices WHERE notified_at IS NULL`,cut)},
    {name:'institutional-curator',run:async()=>{await runInstitutionalCuratorCycle(db,institutionalMemory,await backgroundDatabaseNow(db),{
      ...(institutionalAnchors?{anchors:institutionalAnchors}:{}),
    });}},
  ];
}

export const backgroundSourceFamilies = () => [...new Set([...BACKGROUND_SOURCES.map(([name]) => name), ...RETENTION_RULES.map(([table]) => `retention:${table}`)])];

/** Lease extensions move a local known expiry directly, without a recovery
 * SELECT on each renewal. The database remains the final effect fence. */
export class BackgroundRecordDeadlines {
  private readonly records=new Map<string,number>();
  private capturing?:Set<string>;
  constructor(private readonly family:string,private readonly work:BackgroundWork,private readonly wake:()=>void,
    private readonly now:()=>number=Date.now){}
  observe(id:string,due:number|null,removed=false):void{
    this.capturing?.add(id);
    if(removed||due===null)this.records.delete(id);else if(Number.isFinite(due))this.records.set(id,due);
    this.work.schedule(this.family,this.next());this.wake();
  }
  subscribe():()=>void{
    return subscribeCommandCompletionFamily('background-record',this.family,key=>{
      if(!key)return;
      try{
        const value:unknown=JSON.parse(key.commandId);
        if(!Array.isArray(value)||value.length!==3||typeof value[0]!=='string'||
          (value[1]!==null&&!Number.isSafeInteger(value[1]))||typeof value[2]!=='boolean')return;
        this.observe(value[0],value[1],value[2]);
      }catch{/* Malformed control evidence confers no work. */}
    });
  }
  async capture(read:()=>Promise<readonly {id:string;due:number|null}[]>):Promise<void>{
    const touched=new Set<string>();this.capturing=touched;const prior=new Set(this.records.keys());
    try{
      const rows=await read();
      for(const row of rows){prior.delete(row.id);if(!touched.has(row.id)){
        if(row.due===null)this.records.delete(row.id);else this.records.set(row.id,row.due);
      }}
      for(const id of prior)if(!touched.has(id))this.records.delete(id);
    }finally{this.capturing=undefined;}
  }
  consume():void{for(const[id,due]of this.records)if(due<=this.now())this.records.delete(id);}
  next():number|undefined{
    if(!this.records.size)return;
    return Math.max(0,Math.min(...this.records.values())-this.now());
  }
}
