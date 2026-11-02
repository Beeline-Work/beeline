import { AdmissionOwner, ReadLanes, RouterBatchAssembly, NavigationOwner,
  type LaneFamily, type LaneRequest, type LaneSnapshot, type LaneView, type NavigationState, type AdmittedCommand } from '@beeline/net/owner';
import { readChatListView, readRoomView } from '@beeline/api-contract/phone';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import type { RouterPushFrame, RouterSnapshotInput, RouterSnapshot } from '@beeline/api-contract/router-protocol';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';
import { AppState } from 'react-native';
import { routerLaneStorage } from './surface-storage';

export type RouterFamilyMode = 'pending' | 'legacy' | 'router';
type Negotiation = { generation: number; families: readonly LaneFamily[];
  execute: (input: RouterSnapshotInput) => Promise<RouterSnapshot> };
type Slot = { request: LaneRequest; consumers: Map<() => void, () => boolean>; listeners: Set<() => void>;
  generation?: number; expectedWorkspace?: string; token?: object; release?: () => void; stop?: () => void };
const navigation = new NavigationOwner();
const listeners = new Set<() => void>();
const slots = new Set<Slot>();
const slotsByKey = new Map<string, Slot>();
let admission: AdmissionOwner | undefined;
let stopFences: (() => void) | undefined;
let lanes: ReadLanes | undefined;
let negotiation: Negotiation | undefined;
let initialized: Promise<void> | undefined;
let listPanelVisible = false;
let modeKnown = false;
let instance = 0;
const slotNames = new WeakMap<Slot, string>();
let nextSlotName = 0;
const notify = () => { for (const listener of listeners) listener(); };
const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
const empty: LaneView = Object.freeze({ state: 'ABSENT', value: null, cut: null, error: null });

function validValue(request: LaneRequest, value: unknown): boolean {
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
    admission = new AdmissionOwner(reader);
    const storage = routerLaneStorage(reader.origin, reader.principal);
    lanes = new ReadLanes(reader, validValue, storage);
    stopFences = storage.subscribeFences((scope, epoch) => { void lanes?.revoke(scope, epoch, false); });
    if (AppState.currentState === 'background' || AppState.currentState === 'inactive') admission.background();
  });
}
const assembly = new RouterBatchAssembly(hash, batch => {
  const facts = batch.facts.filter(fact => {
    if (validCertificate({ authority: fact.authority } as LaneSnapshot)) return true;
    if (fact.payload.kind === 'scope-replace') lanes?.unavailable(batch.to.stream, fact.payload.family);
    return false;
  });
  void lanes?.accept({ ...batch, facts });
}, stream => {
  for (const family of negotiation?.families ?? []) lanes?.unavailable(stream, family);
});
function eligible(slot: Slot): boolean {
  const focused = navigation.current();
  if (!focused || ![...slot.consumers.values()].some(visible => visible()) || AppState.currentState === 'background' || AppState.currentState === 'inactive') return false;
  if (slot.request.family !== 'room-head' && focused.workspaceId && slot.request.workspaceId !== focused.workspaceId) return false;
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
  if (lanes && slot.request.family === 'room-head' && slot.expectedWorkspace)
    lanes.constrain({ ...slot.request, workspaceId: slot.expectedWorkspace });
  const residency = navigation.current();
  if (!admission || !lanes || !residency || !eligible(slot) || !lanes.supports(slot.request.family)) {
    release(slot); return;
  }
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
  const screen = slot.request.family === 'room-head' ? 'Room' : 'AppShell';
  const pass = admission.focusOwner(slotNames.get(slot)!, residency.generation, screen, [request])[0]!;
  const permit = admission.spend(request, pass);
  slot.token = pass;
  slot.release = lanes.demand(slot.request, pass, permit);
  slot.stop = lanes.subscribe(slot.request, () => { for (const listener of slot.listeners) listener(); });
  for (const listener of slot.listeners) listener();
}
function reconcile(): void {
  for (const slot of [...slots]) {
    if (!slot.consumers.size && slot.generation !== navigation.current()?.generation) {
      release(slot); slots.delete(slot);
      const request = slot.request;
      slotsByKey.delete(JSON.stringify([request.family, request.family === 'room-head' ? '' : request.workspaceId, request.roomId ?? '']));
      admission?.forgetOwner(slotNames.get(slot)!);
      continue;
    }
    focus(slot);
  }
  notify();
}
navigation.subscribe(reconcile);

/** Real committed navigator state. This does not run a request by itself. */
export function routerOwnerNavigation(state: NavigationState): void { navigation.observe(state); }
/** Called by the desktop shell's actual layout owner, never by a data consumer. */
export function routerOwnerListPanel(visible: boolean): void {
  if (listPanelVisible === visible) return;
  listPanelVisible = visible; reconcile();
}

/** Sole transport owner calls this only after authentication and negotiation.
 * A server without the capability supplies an empty family set.
 */
export async function routerOwnerNegotiated(next: Negotiation): Promise<void> {
  const version = ++instance;
  await initialize();
  if (version !== instance) return;
  negotiation = next; modeKnown = true;
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
    if (slot.generation === residency.generation && slot.token) admission.resumeObservation(slotNames.get(slot)!, residency.generation);
    else {
      const request = { route: 'phone.readRouterSnapshot' as const, input: slot.request };
      const pass = admission.focusOwner(slotNames.get(slot)!, residency.generation,
        slot.request.family === 'room-head' ? 'Room' : 'AppShell', [request])[0]!;
      admission.spend(request, pass); // focused demand joins this recovery key
    }
    slot.generation = residency.generation;
    slot.token = Object.freeze({});
    slot.release = lanes.demand(slot.request, slot.token, recovery.permit);
    slot.stop = lanes.subscribe(slot.request, () => { for (const listener of slot.listeners) listener(); });
  }
  lanes.connected(next.generation, next.families, async request => {
    const result = await next.execute(request);
    if (result.family !== request.family || result.scope !== (request.family === 'room-head' ? request.roomId : request.workspaceId) ||
      !validCertificate(result) || utf8ToBytes(JSON.stringify(result)).length > 64 * 1024)
      throw new Error('Invalid projection snapshot.');
    return result;
  });
  reconcile();
}
export function routerOwnerDisconnected(): void {
  instance += 1; negotiation = undefined; modeKnown = false; assembly.reset(); lanes?.disconnected(); notify();
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const families: readonly string[] = ['room-list', 'needs-you', 'needs-you-count', 'room-head'];
function cut(value: unknown): boolean {
  return record(value) && value.protocol === 1 && typeof value.stream === 'string' && value.stream.length <= 256 &&
    typeof value.epoch === 'string' && value.epoch.length <= 128 && Number.isSafeInteger(value.through) && Number(value.through) >= 0;
}
function certificate(value: unknown): boolean {
  return record(value) && typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest) &&
    Array.isArray(value.scopes) && value.scopes.length > 0 && value.scopes.length <= 8 && value.scopes.every(scope =>
      record(scope) && typeof scope.authorityScope === 'string' && scope.authorityScope.length <= 256 &&
      typeof scope.epoch === 'string' && /^\d{1,30}$/.test(scope.epoch));
}
function fact(value: unknown): boolean {
  if (!record(value) || typeof value.atomicGroup !== 'string' || value.atomicGroup.length > 512 || !certificate(value.authority) || !record(value.payload)) return false;
  const payload = value.payload;
  if (typeof payload.scope !== 'string' || payload.scope.length > 256) return false;
  return payload.kind === 'authority' ? payload.allowed === false : payload.kind === 'scope-replace' &&
    typeof payload.family === 'string' && families.includes(payload.family) && Object.hasOwn(payload, 'value');
}
/** Socket input is untrusted at runtime even when a transport callback has a
 * static protocol type. Malformed frames park locally, never throw or refetch.
 */
export function routerOwnerReceive(value: unknown): void {
  if (!negotiation || !record(value)) return;
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
  try { assembly.accept(value as RouterPushFrame); } catch { fail(); }
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
  const key = JSON.stringify([request.family, request.family === 'room-head' ? '' : request.workspaceId, request.roomId ?? '']);
  let slot = slotsByKey.get(key);
  if (!slot) {
    slot = { request, consumers: new Map(), listeners: new Set() };
    slotNames.set(slot, `slot-${++nextSlotName}`); slots.add(slot); slotsByKey.set(key, slot);
  }
  const held = slot;
  if (request.family === 'room-head' && request.workspaceId) {
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
    release: () => { held.consumers.delete(listener); held.listeners.delete(listener); },
  };
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

/** Called directly from the existing Retry/pull gesture synchronous handler. */
export function retryRouterLane(request: LaneRequest): void {
  if (!admission || !lanes) return;
  const key = JSON.stringify([request.family, request.family === 'room-head' ? '' : request.workspaceId, request.roomId ?? '']);
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
  instance += 1; modeKnown = false; negotiation = undefined; assembly.reset();
  for (const slot of slots) { release(slot); slot.generation = undefined; }
  stopFences?.(); stopFences = undefined;
  admission = undefined; lanes?.reset(); lanes = undefined; initialized = undefined; navigation.reset(); notify();
});
