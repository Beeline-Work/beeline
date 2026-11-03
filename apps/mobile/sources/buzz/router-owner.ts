import {ROUTER_TRAY_CLOCK_STREAM} from '@beeline/api-contract/router-protocol';
import type { AgentUsageCell } from '@beeline/api-contract/helper-usage';
import { installUsageCellConnection, suspendUsageCellConnection, receiveUsageCell, setUsageCellProfile } from './agent-usage-cell';
import { AdmissionOwner, ReadLanes, RouterBatchAssembly, ScheduledWorkAuthority, NavigationOwner, MediaDemandOwner, UsageDemandOwner,validateScheduledWorkProjection,validateTrayProjection,validateSavedWindow,
  type MediaAction, type LaneFamily, type LaneRequest, type LaneSnapshot, type LaneView, type NavigationState, type AdmittedCommand } from '@beeline/net/owner';
import { readChatListView, readRoomView } from '@beeline/api-contract/phone';
import type { MediaMetadata, MediaLink, PhoneOperationMap } from '@beeline/api-contract/phone';
import type { RouterValues, RouterSnapshotInput, RouterSnapshot, RouterCapabilities, ScheduledWorkAuthorityPosition } from '@beeline/api-contract/router-protocol';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';
import { AppState } from 'react-native';
import { routerLaneStorage, routerAuthorityStorageReady,routerCommandStorageReady } from './surface-storage';
import { installMediaCacheConnection, installLegacyMediaCacheConnection, suspendMediaCacheConnection, receiveMediaAuthorityRemoval, invalidateMediaCacheDemand, activeMediaObjectIds } from './media-cache-connection';

export type RouterFamilyMode = 'pending' | 'legacy' | 'router';
type Negotiation = { generation: number; families: readonly LaneFamily[];
  usageCellV1?: boolean; executeUsageCell?: (agentId: string) => Promise<AgentUsageCell>;
  authorityFencesV1?: boolean; roomHeadContinuityV1?: boolean; scheduledWorkCoverageV1?: RouterCapabilities['scheduledWorkCoverageV1']; mediaMetadataV1?: boolean; executeMetadata?: (objectId: string) => Promise<MediaMetadata>;
  executeLink?: (objectId: string) => Promise<MediaLink>; executePlayback?: (objectId: string) => Promise<MediaLink>;
  executeTools?: (input:PhoneOperationMap['readRoomTools']['input'])=>Promise<PhoneOperationMap['readRoomTools']['output']>;
  execute: (input: RouterSnapshotInput) => Promise<RouterSnapshot> };
type Slot = { request: LaneRequest; consumers: Map<() => void, () => boolean>; listeners: Set<() => void>;
  generation?: number; expectedWorkspace?: string; token?: object; release?: () => void; stop?: () => void };
const navigation = new NavigationOwner();
const listeners = new Set<() => void>();
const slots = new Set<Slot>();
const slotsByKey = new Map<string, Slot>();
let admission: AdmissionOwner | undefined;
let mediaDemand: MediaDemandOwner | undefined;
let usageDemand: UsageDemandOwner | undefined;
let readerOrigin: string | undefined;
let committedUsageProfile: string | null = null;
let usageProfilePending = false;
let stopFences: (() => void) | undefined;
let stopFloors: (() => void) | undefined;
let lanes: ReadLanes | undefined;
let negotiation: Negotiation | undefined;
let initialized: Promise<void> | undefined;
let listPanelVisible = false;
let modeKnown = false;
let principal: string | undefined;
let authorityUnavailable = false;
let scheduledAuthority: ScheduledWorkAuthority | undefined;
let instance = 0;
const slotNames = new WeakMap<Slot, string>();
let nextSlotName = 0;
const notify = () => { for (const listener of listeners) listener(); };
const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
function advanceMediaAuthority(scope: string, epoch: string): void {
  // Media's existing fence is inclusive; a floor retires only lower epochs.
  if (BigInt(epoch) > 0n) receiveMediaAuthorityRemoval(scope, (BigInt(epoch) - 1n).toString());
}
const empty: LaneView = Object.freeze({ state: 'ABSENT', value: null, cut: null, error: null });
const roomScoped=(family:LaneFamily)=>family==='room-head'||family==='room-scheduled-work';

function validValue(request: LaneRequest, value: unknown): boolean {
  if(request.family==='needs-you-saved-page')return validateSavedWindow(value,request.workspaceId);
  if(request.family==='needs-you-tray')return validateTrayProjection(value,request.workspaceId);
  if(request.family==='room-scheduled-work'){
    if(!validateScheduledWorkProjection(value))return false;
    const work=value as {schedules:unknown[];subscriptions:{recentCalls?:unknown[]}[];agentNames:unknown[]};
    return work.schedules.length+work.subscriptions.length<=50&&work.agentNames.length<=100&&
      work.subscriptions.reduce((count,subscription)=>count+(subscription.recentCalls?.length??0),0)<=50;
  }
  if (request.family === 'room-list') return readChatListView(value) !== null;
  if (request.family === 'room-head') return readRoomView(value) !== null &&
    (value as { messages: unknown[] }).messages.length <= 30;
  if (!value || typeof value !== 'object') return false;
  const count = (value as { count?: unknown }).count;
  return request.family === 'needs-you-count' && Number.isSafeInteger(count) && Number(count) >= 0 &&
    utf8ToBytes(JSON.stringify(value)).length <= 1024;
}
function validCertificate(snapshot: LaneSnapshot): boolean {
  const scopes = snapshot.authority.scopes;
  return scopes.length > 0 && scopes.length <= 8 && scopes.every((scope, index) =>
    /^\d+$/.test(scope.epoch) && (index === 0 || scopes[index - 1]!.authorityScope < scope.authorityScope)) &&
    hash(scopes) === snapshot.authority.digest;
}
async function initialize(): Promise<void> {
  if (initialized) return initialized;
  const epoch = clientResetGeneration();
  return initialized = Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]).then(([identity, origin]) => {
    if (epoch !== clientResetGeneration() || !identity) return;
    const reader = { origin: new URL(origin).origin, principal: identity.publicKey, sessionEpoch: epoch };
    principal = reader.principal; readerOrigin = reader.origin;
    admission = new AdmissionOwner(reader);
    usageDemand = new UsageDemandOwner(admission, () => navigation.current() ?? null, setUsageCellProfile);
    mediaDemand = new MediaDemandOwner(admission, () => navigation.current() ?? null, invalidateMediaCacheDemand, activeMediaObjectIds);
    const storage = routerLaneStorage(reader.origin, reader.principal);
    lanes = new ReadLanes(reader, validValue, { ...storage, floor: async (scope, epoch) => {
      advanceMediaAuthority(scope, epoch);
      await storage.floor(scope, epoch);
    }, fence: async (scope, epoch) => {
      // ReadLanes calls this only after committed-batch and permission-domain validation.
      receiveMediaAuthorityRemoval(scope, epoch);
      await storage.fence(scope, epoch);
    } });
    scheduledAuthority = new ScheduledWorkAuthority(reader.principal, {digest:hash,
      persist: async fence => {
        const epoch=fence.authority.scopes.find(scope=>scope.authorityScope===fence.authorityScope)!.epoch;
        if(fence.mode==='advance')await lanes!.advance(fence.authorityScope,epoch);
        else await lanes!.revoke(fence.authorityScope,epoch);
      },
      park: () => lanes?.hideFamily('room-scheduled-work','Access could not be verified; Retry.'),
    });
    stopFences = storage.subscribeFences((scope, epoch) => {
      receiveMediaAuthorityRemoval(scope, epoch);
      void lanes?.revoke(scope, epoch, false);
    });
    stopFloors = storage.subscribeFloors((scope, epoch) => { advanceMediaAuthority(scope, epoch); void lanes?.advance(scope, epoch, false); });
    if (AppState.currentState === 'background' || AppState.currentState === 'inactive') admission.background();
  });
}
const assembly = new RouterBatchAssembly(hash, batch => {
  const facts = batch.facts.filter(fact => {
    if (validCertificate({ authority: fact.authority } as LaneSnapshot)) return true;
    void lanes?.unavailableGroup(batch.to.stream, fact.atomicGroup);
    return false;
  });
  const marker=batch.scheduledWorkClassification;
  if(!marker){
    if(negotiation?.scheduledWorkCoverageV1&&facts.some(fact=>fact.payload.kind==='scope-replace'&&fact.payload.family==='room-scheduled-work')){
      lanes?.hideFamily('room-scheduled-work','Missing authority barrier; Retry.');
      void lanes?.accept({...batch,facts:facts.filter(fact=>!fact.atomicGroup.startsWith('room-scheduled-work:'))});
    }else void lanes?.accept({...batch,facts});
    return;
  }
  if(!negotiation?.scheduledWorkCoverageV1||!scheduledAuthority){lanes?.hideFamily('room-scheduled-work','Unnegotiated coverage; Retry.');return;}
  const scheduled=facts.filter(fact=>fact.atomicGroup.startsWith('room-scheduled-work:'));
  const independent=facts.filter(fact=>!fact.atomicGroup.startsWith('room-scheduled-work:'));
  if(independent.length)void lanes?.accept({...batch,facts:independent});
  const deferred={...batch,facts:scheduled};
  scheduledAuthority.defer(negotiation.generation,{id:hash(deferred),kind:'batch',barrier:marker.authorityBarrier,
    bytes:utf8ToBytes(JSON.stringify(deferred)).length,apply:()=>{void lanes?.accept(deferred);},
    discard:()=>lanes?.unavailable(batch.to.stream,'room-scheduled-work','Projection unavailable; Retry.')});
}, stream => {
  for (const family of negotiation?.families ?? []) lanes?.unavailable(stream, family);
});
function eligible(slot: Slot): boolean {
  const focused = navigation.current();
  if (!focused || ![...slot.consumers.values()].some(visible => visible()) || AppState.currentState === 'background' || AppState.currentState === 'inactive') return false;
  if (!roomScoped(slot.request.family) && focused.workspaceId && slot.request.workspaceId !== focused.workspaceId) return false;
  if(slot.request.family==='needs-you-saved-page')return focused.screen==='Tray'&&slot.generation===focused.generation;
  if(slot.request.family==='needs-you-tray')return focused.screen==='Tray';
  if(slot.request.family==='room-scheduled-work')return focused.screen==='ScheduledWork'&&focused.roomId===slot.request.roomId;
  if (slot.request.family === 'room-head') return focused.screen === 'Room' && focused.roomId === slot.request.roomId;
  if (slot.request.family === 'room-list') return focused.screen === 'AppShell' || listPanelVisible;
  return slot.request.family === 'needs-you-count';
}
function release(slot: Slot): void {
  slot.release?.(); slot.release = undefined;
  slot.stop?.(); slot.stop = undefined;
  admission?.releaseOwner(slotNames.get(slot)!);
}
function focus(slot: Slot): void {
  if (lanes && roomScoped(slot.request.family) && slot.expectedWorkspace)
    lanes.constrain({ ...slot.request, workspaceId: slot.expectedWorkspace });
  const residency = navigation.current();
  if (!admission || !lanes || !residency || !eligible(slot) || !lanes.supports(slot.request.family)) {
    release(slot); return;
  }
  if(slot.request.family==='needs-you-saved-page')return; // only its actual continuation gesture or connection recovery admits demand
  if (slot.generation === residency.generation) {
    if (!slot.release && slot.token) {
      const permit = admission.resumeObservation(slotNames.get(slot)!, residency.generation);
      slot.release = lanes.demand(slot.request, slot.token, permit);
      slot.stop = lanes.subscribe(slot.request, () => { for (const listener of slot.listeners) listener(); });
      for (const listener of slot.listeners) listener();
    }
    return;
  }
  release(slot);
  slot.generation = residency.generation;
  const request = { route: 'phone.readRouterSnapshot' as const, input: slot.request };
  const screen = slot.request.family === 'room-head' ? 'Room' :slot.request.family==='room-scheduled-work'?'ScheduledWork':slot.request.family==='needs-you-tray'?'Tray': 'AppShell';
  const pass = admission.focusOwner(slotNames.get(slot)!, residency.generation, screen, [request])[0]!;
  const permit = admission.spend(request, pass);
  slot.token = pass;
  slot.release = lanes.demand(slot.request, pass, permit);
  slot.stop = lanes.subscribe(slot.request, () => { for (const listener of slot.listeners) listener(); });
  for (const listener of slot.listeners) listener();
}
function reconcile(): void {
  mediaDemand?.navigationChanged();
  usageDemand?.navigationChanged();
  flushUsageProfile();
  for (const slot of [...slots]) {
    if (!slot.consumers.size && slot.generation !== navigation.current()?.generation) {
      release(slot); slots.delete(slot);
      const request = slot.request;
      slotsByKey.delete(JSON.stringify([request.family, roomScoped(request.family) ? '' : request.workspaceId, request.roomId ?? '']));
      admission?.forgetOwner(slotNames.get(slot)!);
      continue;
    }
    focus(slot);
  }
  notify();
}
navigation.subscribe(reconcile);

/** Real committed navigator state. This does not run a request by itself. */
function flushUsageProfile(): void {
  if (!usageProfilePending || !usageDemand || !navigation.current()) return;
  usageProfilePending = false; usageDemand.profile(committedUsageProfile);
}
export function routerOwnerUsageProfile(agentId: string | null): void {
  committedUsageProfile = agentId; usageProfilePending = true; flushUsageProfile();
}
export function routerOwnerNavigation(state: NavigationState): void { navigation.observe(state); }
/** Existing transcript viewport and synchronous artifact controls are the only callers. */
export function routerOwnerArtifactViewport(roomId: string, objectIds: readonly string[]): void {
  mediaDemand?.viewport(roomId, objectIds);
}
export function routerOwnerArtifactAction(action: MediaAction, objectId: string): void {
  mediaDemand?.action(action, objectId);
}
/** Called by the desktop shell's actual layout owner, never by a data consumer. */
export function routerOwnerListPanel(visible: boolean): void {
  if (listPanelVisible === visible) return;
  listPanelVisible = visible; reconcile();
}

/** Advertise persistent authority support before the server selects families.
 * Unsupported storage keeps the legacy cohort, without suppressing its hints. */
export function routerOwnerCapabilities(): { families: readonly LaneFamily[]; authorityFencesV1: boolean; scheduledWorkCoverageV1: boolean } {
  const ready = routerAuthorityStorageReady();
  return { families: ready ? ['room-list', 'needs-you-count', 'room-head',...(routerCommandStorageReady()?['room-scheduled-work' as const]:[])] : [], authorityFencesV1: ready, scheduledWorkCoverageV1: ready&&routerCommandStorageReady() };
}

/** Sole transport owner calls this only after authentication and negotiation.
 * A server without the capability supplies an empty family set.
 */
export async function routerOwnerNegotiated(offered: Omit<Negotiation,'families'> & {families:RouterCapabilities['families']}): Promise<void> {
  // Protocol additions cannot opt an unfinished local lane into service.
  if(offered.families.some(family=>!families.includes(family)))throw new Error('Unsupported router family.');
  let next:Negotiation={...offered,families:offered.families as readonly LaneFamily[]};
  const version = ++instance;
  await initialize();
  if (version !== instance) return;
  next={...next,families:next.families.filter(family=>!['room-scheduled-work','needs-you-tray','needs-you-saved-page'].includes(family)||routerCommandStorageReady()&&next.authorityFencesV1===true)};
  if(negotiation)scheduledAuthority?.disconnected(negotiation.generation);
  negotiation = next; modeKnown = true; authorityUnavailable = false;
  if(next.scheduledWorkCoverageV1){
    if(next.scheduledWorkCoverageV1.version!==1||!authorityPosition(next.scheduledWorkCoverageV1.authorityStart)||
      !next.families.includes('room-scheduled-work'))throw new Error('Invalid Scheduled Work coverage negotiation.');
    if(!scheduledAuthority?.connected(next.generation,next.scheduledWorkCoverageV1.authorityStart))throw new Error('Stale Scheduled Work coverage generation.');
  }
  flushUsageProfile();
  const usage = usageDemand;
  if (usage && principal && readerOrigin) {
    if (next.usageCellV1 && next.executeUsageCell) usage.connected(next.generation);
    else usage.disconnected();
    installUsageCellConnection({ generation: next.generation, usageCellV1: next.usageCellV1 === true && !!next.executeUsageCell,
      origin: readerOrigin, principal, joinedRead: agentId => usage.satisfy(agentId),
      executeRead: agentId => usage.dispatch(agentId, input => next.executeUsageCell!(input.agentId)) });
  }
  const media = mediaDemand;
  if (next.mediaMetadataV1 && next.authorityFencesV1 && next.executeMetadata && media) {
    media.connected(next.generation);
    installMediaCacheConnection({ generation: next.generation, mediaMetadataV1: true,
      joinedMetadata: objectId => media.satisfy('readMediaMetadata', objectId),
      executeMetadata: objectId => media.dispatch('readMediaMetadata', objectId, input => next.executeMetadata!(input.objectId)),
      ...(next.executeLink ? { executeLink: (objectId: string) => media.dispatch('readMediaLink', objectId, input => next.executeLink!(input.objectId)) } : {}),
      ...(next.executePlayback ? { executePlayback: (objectId: string) => media.dispatch('readMediaPlayback', objectId, input => next.executePlayback!(input.objectId)) } : {}),
    });
  } else {
    media?.disconnected();
    if (next.mediaMetadataV1) suspendMediaCacheConnection();
    else installLegacyMediaCacheConnection(next.generation);
  }
  if (!lanes || !admission) { notify(); return; }
  // Connection recovery authority replaces expired screen authority exactly once
  // per demanded key, independently of component effects.
  lanes.disconnected();
  const demanded = [...slots].filter(eligible);
  const unique = [...new Map(demanded.filter(slot => next.families.includes(slot.request.family))
    .map(slot => [lanes!.key(slot.request), slot.request])).values()];
  const requests = unique.map(input => ({ route: 'phone.readRouterSnapshot' as const, input }));
  const passes = admission.connected(next.generation, requests);
  const permits = new Map(unique.map((input, index) => [lanes!.key(input), {
    pass: passes[index]!, permit: admission!.spend(requests[index]!, passes[index]!),
  }]));
  for (const slot of demanded) {
    release(slot);
    const recovery = permits.get(lanes.key(slot.request));
    if (!recovery) continue;
    const residency = navigation.current()!;
    if(slot.request.family==='needs-you-saved-page'){ /* already gesture-admitted; connection pass owns recovery */ }
    else if (slot.generation === residency.generation && slot.token) admission.resumeObservation(slotNames.get(slot)!, residency.generation);
    else {
      const request = { route: 'phone.readRouterSnapshot' as const, input: slot.request };
      const pass = admission.focusOwner(slotNames.get(slot)!, residency.generation,
        slot.request.family === 'room-head' ? 'Room' :slot.request.family==='room-scheduled-work'?'ScheduledWork':slot.request.family==='needs-you-tray'?'Tray': 'AppShell', [request])[0]!;
      admission.spend(request, pass); // focused demand joins this recovery key
    }
    slot.generation = residency.generation;
    slot.token = Object.freeze({});
    slot.release = lanes.demand(slot.request, slot.token, recovery.permit);
    slot.stop = lanes.subscribe(slot.request, () => { for (const listener of slot.listeners) listener(); });
  }
  lanes.connected(next.generation, next.families, async request => {
    const result = await next.execute(request);
    if (result.family !== request.family || result.scope !== (roomScoped(request.family) ? request.roomId : request.workspaceId) ||
      !validCertificate(result) || utf8ToBytes(JSON.stringify(result)).length > 64 * 1024)
      throw new Error('Invalid projection snapshot.');
    if(request.family==='room-scheduled-work'&&next.scheduledWorkCoverageV1){
      if(result.family!=='room-scheduled-work'||!authorityPosition(result.authorityBarrier)||!scheduledAuthority)throw new Error('Invalid snapshot authority barrier.');
      const barrier=result.authorityBarrier;
      return new Promise<RouterSnapshot>((resolve,reject)=>scheduledAuthority!.defer(next.generation,{
        id:hash([request,result]),kind:'snapshot',barrier,bytes:utf8ToBytes(JSON.stringify(result)).length,
        apply:()=>resolve(result),discard:reason=>reject(new Error(reason)),
      }));
    }
    return result;
  }, { scheduledWorkCoverageV1:!!next.scheduledWorkCoverageV1, roomHeadContinuityV1: next.roomHeadContinuityV1 === true && next.authorityFencesV1 === true });
  reconcile();
}
export function routerOwnerDisconnected(): void {
  usageDemand?.disconnected(); suspendUsageCellConnection();
  mediaDemand?.disconnected(); suspendMediaCacheConnection();
  if(negotiation)scheduledAuthority?.disconnected(negotiation.generation);
  instance += 1; negotiation = undefined; modeKnown = false; assembly.reset(); lanes?.disconnected(); notify();
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const families: readonly string[] = ['room-list', 'needs-you', 'needs-you-tray', 'needs-you-count', 'room-head','room-scheduled-work','needs-you-saved-page'];
function cut(value: unknown): boolean {
  return record(value) && value.protocol === 1 && typeof value.stream === 'string' && value.stream.length <= 256 &&
    typeof value.epoch === 'string' && value.epoch.length <= 128 && Number.isSafeInteger(value.through) && Number(value.through) >= 0;
}
function authorityPosition(value:unknown):value is ScheduledWorkAuthorityPosition{
  return cut(value)&&record(value)&&value.stream===`authority:${principal}`&&typeof value.segment==='string'&&value.segment.length>0&&value.segment.length<=128;
}
function certificate(value: unknown): boolean {
  return record(value) && typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest) &&
    Array.isArray(value.scopes) && value.scopes.length > 0 && value.scopes.length <= 8 && value.scopes.every(scope =>
      record(scope) && typeof scope.authorityScope === 'string' && scope.authorityScope.length <= 256 &&
      typeof scope.epoch === 'string' && /^\d{1,30}$/.test(scope.epoch));
}
function fact(value: unknown): boolean {
  if(record(value)&&value.kind==='scheduled-work-classification')return value.version===1&&authorityPosition(value.authorityBarrier)&&Object.keys(value).length===3;
  if (!record(value) || typeof value.atomicGroup !== 'string' || value.atomicGroup.length > 512 || !certificate(value.authority) || !record(value.payload)) return false;
  const payload = value.payload;
  if (typeof payload.scope !== 'string' || payload.scope.length > 256) return false;
  if(payload.kind==='tray-classification')return payload.version===1&&typeof payload.clockVersion==='string'&&
    /^tray-clock-v1:[a-f0-9]{32}:(0|[1-9][0-9]*)$/.test(payload.clockVersion)&&Object.keys(payload).length===4;
  if(payload.kind==='tray-needs-replace')return record(payload.value)&&Array.isArray(payload.value.items)&&payload.value.items.length<=30;
  if(payload.kind==='saved-row-replace')return record(payload.row);
  if(payload.kind==='saved-row-remove')return typeof payload.bookmarkId==='string'&&typeof payload.messageId==='string';
  if (payload.kind === 'group-unavailable') return payload.reason === 'authority' || payload.reason === 'dependency';
  if (payload.kind === 'authority-fence') return typeof payload.authorityScope === 'string' && payload.authorityScope.length <= 256 &&
    (payload.mode === 'deny' || payload.mode === 'advance');
  return payload.kind === 'authority' ? payload.allowed === false : payload.kind === 'scope-replace' &&
    typeof payload.family === 'string' && families.includes(payload.family) && Object.hasOwn(payload, 'value');
}
/** Socket input is untrusted at runtime even when a transport callback has a
 * static protocol type. Malformed frames park locally, never throw or refetch.
 */
export function routerOwnerReceive(value: unknown): void {
  if (!negotiation || !record(value)) return;
  if (value.kind === 'usage-cell') { if (negotiation.usageCellV1) receiveUsageCell(value.cell); return; }
  if (value.kind === 'usage-unavailable') { usageDemand?.disconnected(); suspendUsageCellConnection(); return; }
  if(typeof value.kind==='string'&&value.kind.startsWith('scheduled-work-authority-')){
    if(negotiation.scheduledWorkCoverageV1)void scheduledAuthority?.accept(negotiation.generation,value);
    else lanes?.hideFamily('room-scheduled-work','Unnegotiated authority; Retry.');
    return;
  }
  const failAuthority = () => {
    scheduledAuthority?.sourceLost(negotiation!.generation);
    authorityUnavailable = true; assembly.reset(); lanes?.disconnected();
    mediaDemand?.disconnected(); suspendMediaCacheConnection(); notify();
  };
  if (value.kind === 'authority-fence') {
    if (!negotiation.authorityFencesV1 || authorityUnavailable) return;
    const domain = value.authorityScope;
    if (typeof value.scope !== 'string' || value.scope.length > 256 || typeof domain !== 'string' ||
        ![ `room:${value.scope}`, `object:${value.scope}`, `reader:${principal}:workspace:${value.scope}`, `reader:${principal}:workspace:${value.scope}:visibility`,
          `scheduled-work-manager:${principal}:workspace:${value.scope}`,`scheduled-work-member:${principal}:room:${value.scope}`,
          `scheduled-work-room:${value.scope}`,...(value.scope===principal?[`scheduled-work-principal:${principal}`]:[]) ].includes(domain) ||
        (value.mode !== undefined && value.mode !== 'deny' && value.mode !== 'advance') ||
        !certificate(value.authority) || !validCertificate({ authority: value.authority } as LaneSnapshot) ||
        utf8ToBytes(JSON.stringify(value)).length > 4096) { failAuthority(); return; }
    const epoch = (value.authority as LaneSnapshot['authority']).scopes.find(scope => scope.authorityScope === domain)?.epoch;
    if (!epoch) { failAuthority(); return; }
    // A content-free current-authority fence carries no data coverage/cursor.
    if (value.mode === 'advance') {
      advanceMediaAuthority(domain, epoch);
      void lanes?.advance(domain, epoch).catch(failAuthority);
    }
    else {
      receiveMediaAuthorityRemoval(domain, epoch);
      void lanes?.revoke(domain, epoch).catch(failAuthority);
    }
    return;
  }
  if(value.kind==='router-unavailable'&&value.stream===ROUTER_TRAY_CLOCK_STREAM){
    // A shared control loss parks only Tray state, across local held scopes.
    // It carries no client inventory and admits no read or socket replacement.
    for(const family of negotiation.families)if(family.startsWith('needs-you'))lanes?.hideFamily(family);
    return;
  }
  if (value.kind === 'router-unavailable' && value.stream === `authority:${principal}`) {
    if(negotiation.scheduledWorkCoverageV1&&Array.isArray(value.families)&&value.families.length===1&&value.families[0]==='room-scheduled-work')scheduledAuthority?.sourceLost(negotiation.generation);
    else failAuthority();
    return;
  }
  if (authorityUnavailable) return;
  const stream = typeof value.stream === 'string' ? value.stream : record(value.to) && typeof value.to.stream === 'string' ? value.to.stream : undefined;
  const fail = () => { if (stream) for (const family of negotiation?.families ?? []) lanes?.unavailable(stream, family); };
  if (value.kind === 'router-unavailable') {
    if (!stream || !Array.isArray(value.families) || !value.families.every(family => typeof family === 'string' && families.includes(family))) { fail(); return; }
    for (const family of value.families) lanes?.unavailable(stream, family as LaneFamily);
    return;
  }
  if ((value.kind !== 'push-part' && value.kind !== 'push-commit') || !cut(value.from) || !cut(value.to) ||
      typeof value.batchId !== 'string' || typeof value.contentDigest !== 'string' ||
      !Number.isInteger(value.partCount) || (value.kind === 'push-part' &&
        (!Number.isInteger(value.partIndex) || !Array.isArray(value.facts) || !value.facts.every(fact)))) { fail(); return; }
  // fact() accepts only this owner's implemented lane/fact vocabulary, which
  // may be narrower than additive server-side protocol contracts.
  try { assembly.accept(value as Parameters<RouterBatchAssembly['accept']>[0]); } catch { fail(); }
}

export function routerFamilyMode(family: LaneFamily): RouterFamilyMode {
  return !modeKnown ? 'pending' : negotiation?.families.includes(family) ? 'router' : 'legacy';
}
export function subscribeRouterOwner(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function routerLaneSnapshot(request: LaneRequest): LaneView { return lanes?.peek(request) ?? empty; }

/** Consumer attachment observes a trusted navigation slot. Mount alone cannot
 * authorize a read; the committed navigator and actual panel visibility gate it.
 */
export function acquireRouterLane(request: LaneRequest, visible: () => boolean, listener: () => void) {
  request = Object.freeze({ ...request });
  const key = JSON.stringify([request.family, roomScoped(request.family) ? '' : request.workspaceId, request.family==='needs-you-saved-page'?request.before??'':request.roomId ?? '']);
  let slot = slotsByKey.get(key);
  if (!slot) {
    slot = { request, consumers: new Map(), listeners: new Set() };
    slotNames.set(slot, `slot-${++nextSlotName}`); slots.add(slot); slotsByKey.set(key, slot);
  }
  const held = slot;
  if (roomScoped(request.family) && request.workspaceId) {
    if (held.expectedWorkspace && held.expectedWorkspace !== request.workspaceId) throw new Error('Room Workspace mismatch');
    lanes?.constrain(request);
    held.expectedWorkspace = request.workspaceId;
  }
  held.consumers.set(listener, visible); held.listeners.add(listener);
  void initialize().then(() => focus(held));
  return {
    current: () => routerLaneSnapshot(request),
    refreshVisibility: () => focus(held),
    subscribe: (next: () => void) => { held.listeners.add(next); return () => { held.listeners.delete(next); }; },
    // The navigator owns the lane lifetime. Effect cleanup only detaches its
    // observer, so StrictMode setup/cleanup cannot mint or cancel a focus pass.
    release: () => {
      held.consumers.delete(listener);held.listeners.delete(listener);
      if(held.request.family==='needs-you-saved-page'&&!held.consumers.size){release(held);slots.delete(held);slotsByKey.delete(key);}
    },
  };
}

/** Existing Load More Saved button only. The cursor must be the current
 * continuation of a held canonical head/page in this focused Workspace. */
export function acquireRouterSavedContinuation(workspaceId:string,before:string,visible:()=>boolean,listener:()=>void){
  const {focused,value,owner}=heldTray(workspaceId);
  if(!lanes||routerFamilyMode('needs-you-saved-page')!=='router')throw new Error('Saved continuation is unavailable.');
  const held=[...slots].filter(slot=>slot.request.family==='needs-you-saved-page'&&slot.request.workspaceId===workspaceId&&
    slot.generation===focused.generation&&slot.release);
  if(value.saved.next!==before&&!held.some(slot=>(lanes!.peek(slot.request).value as RouterValues['needs-you-saved-page']|null)?.next===before))
    throw new Error('Saved continuation is not held.');
  const request={family:'needs-you-saved-page',workspaceId,before} as const;
  const key=JSON.stringify([request.family,workspaceId,before]);
  if(!slotsByKey.has(key)&&held.length>=16)throw new Error('Saved window capacity reached.');
  const handle=acquireRouterLane(request,visible,listener),slot=slotsByKey.get(key)!;
  if(slot.release&&slot.generation===focused.generation)return handle;
  try{
    owner.continueSaved(focused.generation,workspaceId,before,pass=>{
      const read={route:'phone.readRouterSnapshot' as const,input:request},permit=owner.spend(read,pass);
      slot.generation=focused.generation;slot.token=pass;
      slot.release=lanes!.demand(request,pass,permit);
      slot.stop=lanes!.subscribe(request,()=>{for(const notify of slot.listeners)notify();});
    });
    return handle;
  }catch(error){handle.release();throw error;}
}

/** Immutable prepared input is admitted on the actual composer's synchronous
 * gesture prefix. Command storage and delivery may finish after it returns.
 */
export function admitRouterPreparedMessage<K extends 'sendRoomMessage' | 'sendRoomReply'>(operation: K,
  input: PhoneOperationMap[K]['input']): AdmittedCommand {
  const focused = navigation.current();
  if (!admission || !focused || focused.screen !== 'Room' || focused.roomId !== input.roomId)
    throw new Error('Message action is not focused.');
  if (operation === 'sendRoomReply') {
    const request = { route: 'phone.sendRoomReply' as const, input: input as PhoneOperationMap['sendRoomReply']['input'] };
    return admission.tap('SendMessage', request, pass => admission!.spend(request, pass));
  }
  const request = { route: 'phone.sendRoomMessage' as const, input: input as PhoneOperationMap['sendRoomMessage']['input'] };
  return admission.tap('SendMessage', request, pass => admission!.spend(request, pass));
}
export function admitRouterScheduledStop(operation:'deleteRoomSchedule'|'deleteRoomSubscription',roomId:string,id:string):AdmittedCommand{
  const focused=navigation.current();
  if(!admission||!focused||focused.screen!=='ScheduledWork'||focused.roomId!==roomId||routerFamilyMode('room-scheduled-work')!=='router')
    throw new Error('Scheduled Work action is not focused.');
  if(operation==='deleteRoomSchedule'){
    const request={route:'phone.deleteRoomSchedule' as const,input:{roomId,scheduleId:id}};
    return admission.tap('StopScheduledWork',request,pass=>admission!.spend(request,pass));
  }
  const request={route:'phone.deleteRoomSubscription' as const,input:{roomId,subscriptionId:id}};
  return admission.tap('StopScheduledWork',request,pass=>admission!.spend(request,pass));
}

export type TrayCommand = { [K in 'clearNeedsYou'|'clearNeedsYouSection'|'clearMessageBookmarks'|'setMessageBookmark'|
  'decideAgentGrant'|'decideWritePermission'|'answerChoice'|'skipChoice']:{operation:K;input:PhoneOperationMap[K]['input']}
}['clearNeedsYou'|'clearNeedsYouSection'|'clearMessageBookmarks'|'setMessageBookmark'|'decideAgentGrant'|'decideWritePermission'|'answerChoice'|'skipChoice'];
let trayActions:{generation:number;workspaceId:string;bookmarkRemovals:Set<string>}|undefined;
function heldTray(workspaceId:string){
  const focused=navigation.current();
  if(!admission||!focused||focused.screen!=='Tray'||focused.workspaceId&&focused.workspaceId!==workspaceId||
    routerFamilyMode('needs-you-tray')!=='router'||AppState.currentState!=='active')throw new Error('Tray action is not focused.');
  const slot=slotsByKey.get(JSON.stringify(['needs-you-tray',workspaceId,'']));
  const value=routerLaneSnapshot({family:'needs-you-tray',workspaceId}).value as RouterValues['needs-you-tray']|null;
  if(!slot||!eligible(slot)||!value)throw new Error('Tray data is unavailable.');
  return {focused,value,owner:admission};
}
function exactTrayInput(input:object,expected:Record<string,string>):boolean{
  if(![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.getOwnPropertySymbols(input).length)return false;
  const fields=Object.getOwnPropertyDescriptors(input),keys=Object.keys(expected);
  return Object.keys(fields).length===keys.length&&keys.every(key=>fields[key]?.enumerable&&
    'value' in fields[key]!&&fields[key]!.value===expected[key]);
}
/** Only existing cells and the two current sections authorize these commands.
 * Unsupported decision adapters remain unavailable until their durable effect
 * proof is integrated; router selection never falls back to a legacy effect. */
export function admitRouterTrayCommand(workspaceId:string,command:TrayCommand):AdmittedCommand{
  const {focused,value,owner}=heldTray(workspaceId);
  if(trayActions?.generation!==focused.generation||trayActions.workspaceId!==workspaceId)
    trayActions={generation:focused.generation,workspaceId,bookmarkRemovals:new Set()};
  switch(command.operation){
    case 'clearNeedsYou':{
      if(command.input.workspaceId!==workspaceId||!value.needs.items.some(item=>item.workspaceId===workspaceId&&
        item.messageId===command.input.messageId&&(!item.approval||command.input.dismissReminder===true)))throw new Error('Tray item is unavailable.');
      const request={route:'phone.clearNeedsYou' as const,input:command.input};
      return owner.tap('EditTray',request,pass=>owner.spend(request,pass));
    }
    case 'clearNeedsYouSection':{
      if(command.input.workspaceId!==workspaceId)throw new Error('Wrong Tray section.');
      const request={route:'phone.clearNeedsYouSection' as const,input:command.input};
      return owner.tap('EditTray',request,pass=>owner.spend(request,pass));
    }
    case 'clearMessageBookmarks':{
      if(command.input.workspaceId!==workspaceId)throw new Error('Wrong Tray section.');
      const request={route:'phone.clearMessageBookmarks' as const,input:command.input};
      return owner.tap('EditTray',request,pass=>owner.spend(request,pass));
    }
    case 'setMessageBookmark':{
      const key=JSON.stringify([command.input.roomId,command.input.messageId]);
      const saved=[...value.saved.rows,...[...slots].filter(slot=>slot.request.family==='needs-you-saved-page'&&
        slot.request.workspaceId===workspaceId&&slot.generation===focused.generation&&slot.release).flatMap(slot=>
          (lanes?.peek(slot.request).value as RouterValues['needs-you-saved-page']|null)?.rows??[])];
      const visible=[...value.needs.items,...saved.map(row=>row.value)].some(item=>item.workspaceId===workspaceId&&
        item.roomId===command.input.roomId&&item.messageId===command.input.messageId);
      if(!visible&&!(command.input.bookmarked&&trayActions.bookmarkRemovals.has(key)))throw new Error('Saved item is unavailable.');
      if(!command.input.bookmarked&&!trayActions.bookmarkRemovals.has(key)&&trayActions.bookmarkRemovals.size>=100)
        throw new Error('Tray pending action capacity exceeded.');
      const request={route:'phone.setMessageBookmark' as const,input:command.input};
      const admitted=owner.tap('EditTray',request,pass=>owner.spend(request,pass));
      if(!command.input.bookmarked)trayActions.bookmarkRemovals.add(key);
      else trayActions.bookmarkRemovals.delete(key);
      return admitted;
    }
    case 'decideAgentGrant':{
      if(!value.needs.items.some(item=>item.workspaceId===workspaceId&&item.approval?.actions?.some(action=>
        action.kind==='grant'&&exactTrayInput(command.input,{grantId:action.grantId,decision:action.decision}))))throw new Error('Tray decision is unavailable.');
      const request={route:'phone.decideAgentGrant' as const,input:command.input};
      return owner.tap('EditTray',request,pass=>owner.spend(request,pass));
    }
    case 'decideWritePermission':{
      if(!value.needs.items.some(item=>item.workspaceId===workspaceId&&item.approval?.actions?.some(action=>
        action.kind==='write-access'&&exactTrayInput(command.input,{roomId:item.roomId,permissionId:action.permissionId,
          requestId:action.requestId,agentId:action.agentId,repository:action.repository,decision:action.decision}))))throw new Error('Tray decision is unavailable.');
      const request={route:'phone.decideWritePermission' as const,input:command.input};
      return owner.tap('EditTray',request,pass=>owner.spend(request,pass));
    }
    case 'skipChoice':{
      if(!value.needs.items.some(item=>item.workspaceId===workspaceId&&item.approval?.actions?.some(action=>
        action.kind==='skip-choice'&&exactTrayInput(command.input,{choiceId:action.choiceId}))))throw new Error('Tray decision is unavailable.');
      const request={route:'phone.skipChoice' as const,input:command.input};
      return owner.tap('EditTray',request,pass=>owner.spend(request,pass));
    }
    default:throw new Error('This Tray decision is unavailable on the selected protocol.');
  }
}
export function admitRouterTrayPaint(workspaceId:string,messageIds:readonly string[]):readonly AdmittedCommand[]{
  const {focused,value,owner}=heldTray(workspaceId);
  if(messageIds.length>30)throw new Error('Tray paint batch exceeds its bound.');
  const ids=[...new Set(messageIds)].filter(id=>value.needs.items.some(item=>item.workspaceId===workspaceId&&
    item.messageId===id&&!item.approval&&item.expiresAt===undefined));
  const admitted=owner.paintTray(focused.generation,workspaceId,ids);
  return admitted?[admitted]:[];
}

/** Called directly from the existing Retry/pull gesture synchronous handler. */
export function retryRouterLane(request: LaneRequest): void {
  if (!admission || !lanes) return;
  const key = JSON.stringify([request.family, roomScoped(request.family) ? '' : request.workspaceId, request.family==='needs-you-saved-page'?request.before??'':request.roomId ?? '']);
  const slot = slotsByKey.get(key);
  if (!slot || !eligible(slot)) return;
  const read = { route: 'phone.readRouterSnapshot' as const, input: slot.request };
  admission.retry(slotNames.get(slot)!, read, pass => lanes!.retry(slot.request, admission!.spend(read, pass)));
}

/** Background revokes screen authority immediately. Returning foreground does
 * not mint screen passes or ask for data; a real connection epoch may recover.
 */
AppState.addEventListener('change', state => {
  if (state === 'background' || state === 'inactive') {
    admission?.background(); navigation.background();
    for (const slot of slots) release(slot);
  } else if (state === 'active') { admission?.foregrounded(); navigation.foregrounded(); }
});
subscribeClientReset(() => {
  trayActions=undefined;
  if(negotiation)scheduledAuthority?.disconnected(negotiation.generation);
  scheduledAuthority=undefined;
  instance += 1; modeKnown = false; negotiation = undefined; principal = undefined; authorityUnavailable = false; assembly.reset();
  for (const slot of slots) { release(slot); slot.generation = undefined; }
  stopFences?.(); stopFences = undefined;
  stopFloors?.(); stopFloors = undefined;
  mediaDemand?.disconnected(); mediaDemand = undefined;
  usageDemand?.disconnected(); usageDemand = undefined; readerOrigin = undefined; committedUsageProfile = null; usageProfilePending = false;
  admission = undefined; lanes?.reset(); lanes = undefined; initialized = undefined; navigation.reset(); notify();
});

/** Existing tool disclosure/More/Open gestures only; no mount or timer reads. */
const toolFlights=new Map<string,Promise<PhoneOperationMap['readRoomTools']['output']>>();
export function readRouterToolPage(input:PhoneOperationMap['readRoomTools']['input']):Promise<PhoneOperationMap['readRoomTools']['output']>{
  try{
  const focus=navigation.current(),connection=negotiation,owner=admission;
  if(!owner||!focus||focus.screen!=='Room'||focus.roomId!==input.roomId||routerFamilyMode('room-head')!=='router'||!connection?.executeTools)
    return Promise.reject(new Error('Tool output is unavailable.'));
  const request={route:'phone.readRoomTools' as const,input};
  const permit=owner.toolTap(focus.generation,focus.roomId,request,pass=>owner.spend(request,pass));
  const key=JSON.stringify([instance,principal,readerOrigin,focus.generation,connection.generation,permit.wire.input]);
  const joined=toolFlights.get(key);if(joined)return joined;
  if(toolFlights.size>=16)throw new Error('Too many tool pages are opening.');
  const flight=connection.executeTools(JSON.parse(permit.wire.input)).then(result=>{
    if(!permit.isCurrent()||negotiation!==connection||authorityUnavailable)throw new Error('Tool output is no longer visible.');
    return result;
  });
  toolFlights.set(key,flight);void flight.finally(()=>{if(toolFlights.get(key)===flight)toolFlights.delete(key);}).catch(()=>{});
  return flight;
  }catch(error){return Promise.reject(error);}
}
