import type { AgentUsageCell } from '@beeline/api-contract/helper-usage';
import { helperUsageEnabled, subscribeAgentUsageCells, fenceAgentUsageCellEnqueue } from './helper-usage.js';
import type { MediaMetadata } from '@beeline/api-contract/media-metadata';
import { fenceMediaMetadataEnqueue } from './phone-media.js';
import { subscribeAuthorityFences } from './router-authority-fences.js';
import {readRouterBuildTicket,type RouterBuilderBasis,type RouterBuildCoordinator,type RouterBuildTicket} from './router-build-coordinator.js';
import { fenceCommandReceiptEnqueue } from './router-command-coverage.js';
import type { RouterFamily, RouterSnapshot, RouterSnapshotInput, RouterFact, RouterCapabilities } from '@beeline/api-contract/router-protocol';
import { ROUTER_FAMILIES } from '@beeline/api-contract/router-protocol';
import type { LiveHub } from './live.js';
import type { PhoneService } from './phone-service.js';
import { routerSourcePlan } from './router-source-plan.js';
import type { SqlDatabase } from './database.js';
import { PhoneOperationError } from './phone-operations.js';
import { RouterProjectionDrain, RouterProjectionUnavailable, encodeRouterBatch, fenceRouterBatch, readRouterAuthority, readRouterCertificate, deniedRouterAuthorityScope, type ResolvedRouterSnapshotInput, routerAtomicGroup, fenceRouterEnqueue } from './router-projections.js';

/** An explicit rollout policy, independently gated on the committed LISTEN.
 * Defaults advertise no families until capture/fence/differential proofs pass. */
export interface RouterProjectionPolicy {
  readonly families: readonly RouterFamily[];
  readonly listenerReady: () => boolean;
  readonly commandDedupV1?: boolean;
  /** One coordinator per server, never one per socket. A caller must certify
   * the complete immutable builder/clock basis before setting this option. */
  readonly sharedBuilds?:{readonly coordinator:RouterBuildCoordinator;readonly basis:RouterBuilderBasis};
}
export function routerSocketProtocol(database: SqlDatabase, viewer: string,
  send: (frame: string) => unknown, policy?: RouterProjectionPolicy,
  sources?: { live: LiveHub; phone: PhoneService; rooms: () => readonly string[]; mediaMetadataV1?:boolean }) {
  const releases: Array<() => void> = [];
  let stopped = false;
  let usageCellV1 = false;
  let negotiated: readonly RouterFamily[] = [];
  return {
    supportsUsage():boolean { return usageCellV1; },
    supports(family:RouterFamily):boolean {return negotiated.includes(family);},
    close(): void { stopped = true; usageCellV1 = false; for (const release of releases.splice(0)) release(); },
    async handle(message: Record<string, unknown>): Promise<boolean> {
      if (message.type !== 'router-negotiate') return false;
      const requested = message.protocol === 1 && Array.isArray(message.families)
        ? message.families.filter((family): family is RouterFamily =>
          typeof family === 'string' && (ROUTER_FAMILIES as readonly string[]).includes(family)) : [];
      for (const release of releases.splice(0)) release();
      negotiated = sources && policy?.listenerReady() ? ROUTER_FAMILIES.filter(f => requested.includes(f) && policy.families.includes(f)) : [];
      let releaseReady!: () => void;
      const ready = new Promise<void>(resolve => { releaseReady = resolve; });
      let authorityFencesV1=message.authorityFencesV1===true&&Boolean(sources)&&policy?.listenerReady()===true
        && (negotiated.length>0||sources?.mediaMetadataV1===true);
      usageCellV1 = message.protocol === 1 && message.usageCellV1 === true && helperUsageEnabled() && !!sources && policy?.listenerReady() === true;
      try {
      if (usageCellV1 && sources) {
        await new Promise<void>((resolve, reject) => {
          const unavailable = () => {
            usageCellV1 = false;
            if (!stopped) send(JSON.stringify({ kind: 'usage-unavailable' }));
            reject(new Error('Usage listener unavailable'));
          };
          const release = subscribeAgentUsageCells(database, viewer, cell => {
            if (!stopped && usageCellV1) send(JSON.stringify({ kind: 'usage-cell', cell }));
          }, unavailable, resolve);
          releases.push(release, sources.live.subscribeProjectionUnavailable(() => { release(); unavailable(); }));
        });
      }
      if(authorityFencesV1&&sources){
        const release=await subscribeAuthorityFences(database,sources.live,viewer,frame=>{
          if(!stopped)send(JSON.stringify(frame));return undefined;
        },reason=>{if(!stopped)send(JSON.stringify({kind:'router-unavailable',stream:`authority:${viewer}`,families:[],reason}));},ready);
        if(stopped)release();else releases.push(release);
      }
      if (negotiated.length && sources) {
        const workspaces = await database.query<{workspace_id:string}>(
          `SELECT workspace_id FROM memberships WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL`, [viewer]);
        for (const {workspace_id:workspace} of workspaces.rows) {
          const release = await new RouterProjectionDrain(database,sources.live).subscribe(workspace,async (db,from,to,causes) => {
            if (stopped) return;
            const plan = routerSourcePlan(causes,viewer);
            const facts: RouterFact[] = [];
            for (const family of negotiated) {
              const affected=plan.families.has(family);
              // Workspace group names follow DB audience and the closed
              // registry. This is not a report of what a phone caches.
              if(!affected&&family==='room-head')continue;
              const transportRooms = family === 'room-head' ? (await db.query<{id:string}>(
                `SELECT id FROM rooms WHERE workspace_id=$1 AND id=ANY($2::uuid[])`,[workspace,[...sources.rooms()]] )).rows.map(r=>r.id) : [];
              const scopes = family === 'room-head' ? [...new Set([...transportRooms.filter(room => plan.allRooms || plan.rooms.has(room)),...plan.removedRooms])] : [workspace];
              for (const scope of scopes) {
                const input = (family==='room-head' ? {family,workspaceId:workspace,roomId:scope} : {family,workspaceId:workspace}) satisfies RouterSnapshotInput;
                let authority,ticket:RouterBuildTicket|undefined;
                try {
                  if(affected&&policy?.sharedBuilds){
                    ticket=await readRouterBuildTicket(db,input,viewer,policy.sharedBuilds.basis);
                    if(ticket.cut.stream!==to.stream||ticket.cut.epoch!==to.epoch||ticket.cut.through!==to.through)
                      throw new RouterProjectionUnavailable('dependency');
                    authority=ticket.authority;
                  }else authority = await readRouterAuthority(db,input,viewer);
                }
                catch (error) {
                  if (!(error instanceof RouterProjectionUnavailable) || error.reason !== 'authority') throw error;
                  const denied=await deniedRouterAuthorityScope(db,input,viewer);
                  facts.push({atomicGroup:routerAtomicGroup(input,viewer),authority:await readRouterCertificate(db,input,viewer),
                    payload:{kind:'authority',...denied,allowed:false}});
                  continue;
                }
                if(!affected){
                  const group=routerAtomicGroup(input,viewer),domain=`reader:${viewer}:workspace:${workspace}:visibility`;
                  if(!facts.some(fact=>fact.atomicGroup===group&&fact.payload.kind==='authority-fence'))
                    facts.push({atomicGroup:group,authority,payload:{kind:'authority-fence',scope:workspace,authorityScope:domain,mode:'advance'}});
                  continue;
                }
                const value = ticket&&policy?.sharedBuilds
                  ?(await policy.sharedBuilds.coordinator.build(ticket,(tx,args,reader)=>sources.phone.buildRouterValue(tx,args,reader))).value
                  :await sources.phone.buildRouterValue(db,input,viewer);
                if (!value) throw new RouterProjectionUnavailable('authority');
                facts.push({atomicGroup:routerAtomicGroup(input,viewer),authority,
                  payload:{kind:'scope-replace',family,scope,value}} as RouterFact);
              }
            }
            return async () => {
              await ready;
              if (stopped) return;
              await fenceRouterBatch(database,workspace,viewer,facts,safeFacts => {
                const frames=encodeRouterBatch(from,to,safeFacts);
                if (!stopped) for (const frame of frames) send(JSON.stringify(frame));
                return undefined;
              });
            };
          }, reason => { if (!stopped) send(JSON.stringify({kind:'router-unavailable',stream:`workspace:${workspace}`,families:negotiated,reason})); });
          if (stopped) release(); else releases.push(release);
        }
      }
      } catch {
        const affected = negotiated;
        negotiated = [];
        authorityFencesV1=false; usageCellV1=false;
        for (const release of releases.splice(0)) release();
        send(JSON.stringify({kind:'router-unavailable',stream:'',families:affected,reason:'listener'}));
      }
      const capabilities: RouterCapabilities = { protocol: 1, families: negotiated,
        ...(usageCellV1 ? {usageCellV1:true} : {}), commandDedupV1: policy?.commandDedupV1 === true,mediaMetadataV1:sources?.mediaMetadataV1===true&&authorityFencesV1,authorityFencesV1 };
      send(JSON.stringify({ type: 'router-capabilities', ...capabilities }));
      releaseReady();
      return true;
    },
    requireUsage(): void {
      if (!usageCellV1 || !policy?.listenerReady()) throw new PhoneOperationError(409, { error: 'usage_cell_unavailable' });
    },
    requireSnapshot(args: Record<string, unknown>): void {
      if (!policy?.listenerReady() || !negotiated.includes(args.family as RouterFamily))
        throw new PhoneOperationError(409, { error: 'router_family_unavailable' });
    },
    async snapshot(input:RouterSnapshotInput):Promise<RouterSnapshot>{
      this.requireSnapshot({...input});
      if(!sources)throw new PhoneOperationError(409,{error:'router_family_unavailable'});
      const shared=policy?.sharedBuilds;
      if(!shared)return sources.phone.readRouterSnapshot(input,viewer);
      return database.transaction(async tx=>{
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const ticket=await readRouterBuildTicket(tx,input,viewer,shared.basis);
        return shared.coordinator.build(ticket,(db,args,reader)=>sources.phone.buildRouterValue(db,args,reader));
      });
    },
    async fenceReply(operation: string, args: Record<string, unknown>, result: unknown, enqueue: (safeResult?: unknown) => undefined): Promise<void> {
      if (operation === 'readAgentUsageCell') { this.requireUsage(); await fenceAgentUsageCellEnqueue(database, viewer, result as AgentUsageCell, cell => enqueue(cell)); return; }
      if(['readMediaMetadata','readMediaLink','readMediaPlayback'].includes(operation)){
        await fenceMediaMetadataEnqueue(database,String(args.objectId),viewer,
          operation==='readMediaMetadata'?(result as MediaMetadata).authority:undefined,()=>enqueue());return;
      }
      if (operation !== 'readRouterSnapshot') { await fenceCommandReceiptEnqueue(database,viewer,result,enqueue); return; }
      this.requireSnapshot(args);
      const snapshot = result as RouterSnapshot;
      if (snapshot?.kind !== 'snapshot' || snapshot.family !== args.family)
        throw new PhoneOperationError(503, { error: 'router_projection_unavailable' });
      await fenceRouterEnqueue(database, args as RouterSnapshotInput, viewer, snapshot.authority, enqueue);
    },
  };
}
