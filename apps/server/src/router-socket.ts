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
}
export function routerSocketProtocol(database: SqlDatabase, viewer: string,
  send: (frame: string) => unknown, policy?: RouterProjectionPolicy,
  sources?: { live: LiveHub; phone: PhoneService; rooms: () => readonly string[] }) {
  const releases: Array<() => void> = [];
  let stopped = false;
  let negotiated: readonly RouterFamily[] = [];
  return {
    supports(family:RouterFamily):boolean {return negotiated.includes(family);},
    close(): void { stopped = true; for (const release of releases.splice(0)) release(); },
    async handle(message: Record<string, unknown>): Promise<boolean> {
      if (message.type !== 'router-negotiate') return false;
      const requested = message.protocol === 1 && Array.isArray(message.families)
        ? message.families.filter((family): family is RouterFamily =>
          typeof family === 'string' && (ROUTER_FAMILIES as readonly string[]).includes(family)) : [];
      for (const release of releases.splice(0)) release();
      negotiated = sources && policy?.listenerReady() ? ROUTER_FAMILIES.filter(f => requested.includes(f) && policy.families.includes(f)) : [];
      let releaseReady!: () => void;
      const ready = new Promise<void>(resolve => { releaseReady = resolve; });
      try {
      if (negotiated.length && sources) {
        const workspaces = await database.query<{workspace_id:string}>(
          `SELECT workspace_id FROM memberships WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL`, [viewer]);
        for (const {workspace_id:workspace} of workspaces.rows) {
          const release = await new RouterProjectionDrain(database,sources.live).subscribe(workspace,async (db,from,to,causes) => {
            if (stopped) return;
            const plan = routerSourcePlan(causes,viewer);
            const facts: RouterFact[] = [];
            for (const family of negotiated) {
              if (!plan.families.has(family)) continue;
              const transportRooms = family === 'room-head' ? (await db.query<{id:string}>(
                `SELECT id FROM rooms WHERE workspace_id=$1 AND id=ANY($2::uuid[])`,[workspace,[...sources.rooms()]] )).rows.map(r=>r.id) : [];
              const scopes = family === 'room-head' ? [...new Set([...transportRooms.filter(room => plan.allRooms || plan.rooms.has(room)),...plan.removedRooms])] : [workspace];
              for (const scope of scopes) {
                const input = (family==='room-head' ? {family,workspaceId:workspace,roomId:scope} : {family,workspaceId:workspace}) satisfies RouterSnapshotInput;
                let authority;
                try { authority = await readRouterAuthority(db,input,viewer); }
                catch (error) {
                  if (!(error instanceof RouterProjectionUnavailable) || error.reason !== 'authority') throw error;
                  const denied=await deniedRouterAuthorityScope(db,input,viewer);
                  facts.push({atomicGroup:routerAtomicGroup(input,viewer),authority:await readRouterCertificate(db,input,viewer),
                    payload:{kind:'authority',...denied,allowed:false}});
                  continue;
                }
                const value = await sources.phone.buildRouterValue(db,input,viewer);
                if (!value) throw new RouterProjectionUnavailable('authority');
                facts.push({atomicGroup:routerAtomicGroup(input,viewer),authority,
                  payload:{kind:'scope-replace',family,scope,value}} as RouterFact);
              }
            }
            const frames = encodeRouterBatch(from,to,facts);
            return async () => {
              await ready;
              if (stopped) return;
              await fenceRouterBatch(database,workspace,viewer,facts,() => {
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
        for (const release of releases.splice(0)) release();
        send(JSON.stringify({kind:'router-unavailable',stream:'',families:affected,reason:'listener'}));
      }
      const capabilities: RouterCapabilities = { protocol: 1, families: negotiated,
        commandDedupV1: policy?.commandDedupV1 === true };
      send(JSON.stringify({ type: 'router-capabilities', ...capabilities }));
      releaseReady();
      return true;
    },
    requireSnapshot(args: Record<string, unknown>): void {
      if (!policy?.listenerReady() || !negotiated.includes(args.family as RouterFamily))
        throw new PhoneOperationError(409, { error: 'router_family_unavailable' });
    },
    async fenceReply(operation: string, args: Record<string, unknown>, result: unknown, enqueue: (safeResult?: unknown) => undefined): Promise<void> {
      if (operation !== 'readRouterSnapshot') { await fenceCommandReceiptEnqueue(database,viewer,result,enqueue); return; }
      this.requireSnapshot(args);
      const snapshot = result as RouterSnapshot;
      if (snapshot?.kind !== 'snapshot' || snapshot.family !== args.family)
        throw new PhoneOperationError(503, { error: 'router_projection_unavailable' });
      await fenceRouterEnqueue(database, args as RouterSnapshotInput, viewer, snapshot.authority, enqueue);
    },
  };
}
