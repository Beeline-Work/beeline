import { usageCellSnapshot } from './agent-usage-cell';
import { mediaMetadataFor, mediaCertificateCurrent } from './media-cache-connection';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { RouterSnapshot, RouterSnapshotInput } from '@beeline/api-contract/router-protocol';
const fixture = vi.hoisted(() => ({
  authorityReady: true,
  state: 'active', events: [] as ((state: string) => void)[],
  storage: { floor: vi.fn(async () => {}), subscribeFloors: () => () => {}, write: vi.fn(async () => {}), fence: vi.fn(async () => {}), remove: vi.fn(async () => {}), subscribeFences: () => () => {} },
}));
vi.mock('react-native', () => ({ AppState: { get currentState() { return fixture.state; }, addEventListener: (_event: string, listener: (state: string) => void) => {
  fixture.events.push(listener); return { remove: () => {} };
} } }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: 'ada' }), getEffectiveRelayUrl: async () => 'https://example.test',
}));
vi.mock('./surface-storage', () => ({ routerLaneStorage: () => fixture.storage, routerAuthorityStorageReady: () => fixture.authorityReady }));
import { resetClientState } from '@/sync/client-reset';
import { acquireRouterLane, routerOwnerNegotiated, routerOwnerNavigation, routerOwnerDisconnected,
  routerOwnerCapabilities, routerFamilyMode, routerOwnerReceive, retryRouterLane, routerOwnerArtifactViewport, routerOwnerUsageProfile } from './router-owner';
const request = { family: 'needs-you-count' as const, workspaceId: 'w' };
const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
const scopes = [{ authorityScope: 'reader:ada:workspace:w', epoch: '1' }];
const authority = { digest: hash(scopes), scopes };
const snapshot = (value = 1): RouterSnapshot<'needs-you-count'> => ({ kind: 'snapshot', family: 'needs-you-count', scope: 'w',
  value: { count: value }, cut: { stream: 'workspace:w', epoch: 'stream', protocol: 1, through: value },
  authority, atomicGroup: 'needs:w:ada' });
const navigation = (key = 'channels') => ({ routes: [{ key, name: 'beeline/channels' }] });
const settle = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
beforeEach(() => { fixture.authorityReady = true; fixture.state = 'active'; resetClientState(); vi.clearAllMocks(); });

describe('real mobile router owner', () => {
  it('requests no projected families without durable authority storage', () => {
    fixture.authorityReady = false;
    expect(routerOwnerCapabilities()).toEqual({ families: [], authorityFencesV1: false });
    fixture.authorityReady = true;
    expect(routerOwnerCapabilities()).toEqual({ families: ['room-list', 'needs-you-count', 'room-head'], authorityFencesV1: true });
  });
  it('mount alone creates no pass; committed navigation admits one count-only read', async () => {
    const execute = vi.fn(async (_input: RouterSnapshotInput) => snapshot());
    const lane = acquireRouterLane(request, () => true, () => {});
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute }); await settle();
    expect(execute).not.toHaveBeenCalled();
    routerOwnerNavigation(navigation()); await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(request);
    expect(lane.current().value).toEqual({ count: 1 });
    lane.release();
  });
  it('StrictMode observer cleanup and setup joins the same navigation pass and flight', async () => {
    const execute = vi.fn(async () => snapshot());
    routerOwnerNavigation(navigation());
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute });
    const old = acquireRouterLane(request, () => true, () => {}); old.release();
    const next = acquireRouterLane(request, () => true, () => {}); await settle();
    routerOwnerNavigation(navigation()); await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(next.current().value).toEqual({ count: 1 });
    next.release();
  });
  it('duplicate observers share one lane and one release leaves the other live', async () => {
    const execute = vi.fn(async () => snapshot());
    routerOwnerNavigation(navigation());
    const first = acquireRouterLane(request, () => true, () => {});
    const second = acquireRouterLane(request, () => true, () => {});
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute }); await settle();
    first.release();
    expect(second.current().state).toBe('LIVE'); expect(execute).toHaveBeenCalledTimes(1);
    second.release();
  });
  it('new negotiated connection recovers one demanded key and legacy remains a separate path', async () => {
    const execute = vi.fn(async () => snapshot());
    routerOwnerNavigation(navigation());
    const lane = acquireRouterLane(request, () => true, () => {});
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute }); await settle();
    routerOwnerDisconnected(); expect(lane.current().value).toBeNull();
    await routerOwnerNegotiated({ generation: 2, families: ['needs-you-count'], execute }); await settle();
    expect(execute).toHaveBeenCalledTimes(2);
    routerOwnerDisconnected(); await routerOwnerNegotiated({ generation: 3, families: [], execute }); await settle();
    expect(routerFamilyMode('needs-you-count')).toBe('legacy'); expect(execute).toHaveBeenCalledTimes(2);
    lane.release();
  });
  it('background revokes reads while healthy foreground only resumes observation', async () => {
    const execute = vi.fn(async () => snapshot());
    routerOwnerNavigation(navigation());
    const lane = acquireRouterLane(request, () => true, () => {});
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute }); await settle();
    fixture.state = 'background'; fixture.events.forEach(listener => listener('background'));
    fixture.state = 'active'; fixture.events.forEach(listener => listener('active')); await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    lane.release();
  });
  it('a failed read waits for a synchronous explicit Retry and never repeats itself', async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(snapshot());
    routerOwnerNavigation(navigation());
    const lane = acquireRouterLane(request, () => true, () => {});
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute }); await settle();
    expect(lane.current().state).toBe('PARKED'); expect(execute).toHaveBeenCalledTimes(1);
    retryRouterLane(request); await settle();
    expect(execute).toHaveBeenCalledTimes(2); expect(lane.current().state).toBe('LIVE'); lane.release();
  });
  it('purges a server-shaped Workspace removal through the exact denied authority domain', async () => {
    const execute = vi.fn(async () => snapshot());
    routerOwnerNavigation({ routes: [{ key: 'room', name: 'beeline/chat/[channelId]', params: { channelId: 'room', communityId: 'w' } }] });
    const lane = acquireRouterLane(request, () => true, () => {});
    const objectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const mediaScopes = [{ authorityScope: `object:${objectId}`, epoch: '1' }, ...scopes];
    const executeMetadata = vi.fn(async () => ({ objectId, sha256: 'a'.repeat(64), size: 1,
      mimeType: 'image/png', expiresAt: Date.now() + 60_000, authority: { scopes: mediaScopes, digest: hash(mediaScopes) } }));
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute,
      authorityFencesV1: true, mediaMetadataV1: true, executeMetadata }); await settle();
    routerOwnerArtifactViewport('room', [objectId]);
    const media = await mediaMetadataFor('https://example.test', 'ada', objectId);
    expect(mediaCertificateCurrent(media!)).toBe(true);
    const removedScopes = [{ authorityScope: 'reader:ada:workspace:w', epoch: '2' }];
    const facts = [{ atomicGroup: 'workspace-authority', authority: { digest: hash(removedScopes), scopes: removedScopes },
      payload: { kind: 'authority', scope: 'w', authorityScope: 'reader:ada:workspace:w', allowed: false } }];
    const frame = { batchId: 'revoke', from: snapshot().cut, to: snapshot(2).cut, partCount: 1, contentDigest: hash(facts) };
    routerOwnerReceive({ ...frame, kind: 'push-part', partIndex: 0, facts });
    expect(mediaCertificateCurrent(media!)).toBe(true);
    routerOwnerReceive({ ...frame, kind: 'push-commit' });
    await settle();
    expect(lane.current()).toMatchObject({ state: 'REVOKED', value: null });
    expect(fixture.storage.fence).toHaveBeenCalledWith('reader:ada:workspace:w', '2');
    expect(mediaCertificateCurrent(media!)).toBe(false);
    expect(executeMetadata).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    lane.release();
  });
  it('purges a metadata-only object without a read-family subscription or invented data cut', async () => {
    const execute = vi.fn(async () => snapshot());
    const objectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const mediaScopes = [{ authorityScope: `object:${objectId}`, epoch: '1' }];
    const executeMetadata = vi.fn(async () => ({ objectId, sha256: 'a'.repeat(64), size: 1,
      mimeType: 'image/png', expiresAt: Date.now() + 60_000, authority: { scopes: mediaScopes, digest: hash(mediaScopes) } }));
    routerOwnerNavigation({ routes: [{ key: 'room', name: 'beeline/chat/[channelId]', params: { channelId: 'room', communityId: 'w' } }] });
    await routerOwnerNegotiated({ generation: 1, families: [], execute, executeMetadata, mediaMetadataV1: true, authorityFencesV1: true });
    routerOwnerArtifactViewport('room', [objectId]);
    const media = await mediaMetadataFor('https://example.test', 'ada', objectId);
    expect(mediaCertificateCurrent(media!)).toBe(true);
    const removed = [{ authorityScope: `object:${objectId}`, epoch: '2' }];
    routerOwnerReceive({ kind: 'authority-fence', scope: objectId, authorityScope: removed[0]!.authorityScope,
      authority: { scopes: removed, digest: hash(removed) } });
    await settle();
    expect(mediaCertificateCurrent(media!)).toBe(false);
    expect(executeMetadata).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
  });
  it('advances object authority without denying metadata at the current epoch', async () => {
    const objectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const mediaScopes = [{ authorityScope: `object:${objectId}`, epoch: '2' }];
    const executeMetadata = vi.fn(async () => ({ objectId, sha256: 'a'.repeat(64), size: 1,
      mimeType: 'image/png', expiresAt: Date.now() + 60_000, authority: { scopes: mediaScopes, digest: hash(mediaScopes) } }));
    routerOwnerNavigation({ routes: [{ key: 'room', name: 'beeline/chat/[channelId]', params: { channelId: 'room', communityId: 'w' } }] });
    await routerOwnerNegotiated({ generation: 1, families: [], execute: async () => snapshot(), executeMetadata, mediaMetadataV1: true, authorityFencesV1: true });
    routerOwnerArtifactViewport('room', [objectId]);
    const media = await mediaMetadataFor('https://example.test', 'ada', objectId);
    routerOwnerReceive({ kind: 'authority-fence', mode: 'advance', scope: objectId,
      authorityScope: mediaScopes[0]!.authorityScope, authority: { scopes: mediaScopes, digest: hash(mediaScopes) } });
    await settle();
    expect(mediaCertificateCurrent(media!)).toBe(true);
    const next = [{ authorityScope: mediaScopes[0]!.authorityScope, epoch: '3' }];
    routerOwnerReceive({ kind: 'authority-fence', mode: 'advance', scope: objectId,
      authorityScope: next[0]!.authorityScope, authority: { scopes: next, digest: hash(next) } });
    await settle();
    expect(mediaCertificateCurrent(media!)).toBe(false);
    expect(executeMetadata).toHaveBeenCalledTimes(1);
  });
  it('adopts content-free authority independently of data cuts and fails closed on authority feed loss', async () => {
    const execute = vi.fn(async () => snapshot());
    routerOwnerNavigation(navigation());
    const lane = acquireRouterLane(request, () => true, () => {});
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], authorityFencesV1: true, execute }); await settle();
    const before = lane.current().cut;
    const removed = [{ authorityScope: 'reader:ada:workspace:w', epoch: '2' }];
    routerOwnerReceive({ kind: 'authority-fence', scope: 'w', authorityScope: removed[0]!.authorityScope,
      authority: { scopes: removed, digest: hash(removed) } });
    await settle();
    expect(before?.through).toBe(1);
    expect(lane.current()).toMatchObject({ state: 'REVOKED', cut: null, value: null });
    expect(fixture.storage.fence).toHaveBeenCalledWith(removed[0]!.authorityScope, '2');
    expect(execute).toHaveBeenCalledTimes(1);
    routerOwnerReceive({ kind: 'router-unavailable', stream: 'authority:ada', families: [], reason: 'listener' });
    retryRouterLane(request); await settle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(lane.current().value).toBeNull();
    lane.release();
  });
  it('malformed wire never throws, creates a pass, or issues a read', async () => {
    const execute = vi.fn(async () => snapshot());
    routerOwnerNavigation(navigation());
    const lane = acquireRouterLane(request, () => true, () => {});
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute }); await settle();
    for (const value of [null, {}, { kind: 'push-part' }, { kind: 'push-part', to: snapshot().cut, facts: null },
      { kind: 'router-unavailable', stream: 'workspace:w', families: null }]) expect(() => routerOwnerReceive(value)).not.toThrow();
    await settle(); expect(execute).toHaveBeenCalledTimes(1); lane.release();
  });
});

it('retains committed profile selection before initialization and owns one cell read per connection', async () => {
  const cell = { v: 1 as const, agentId: 'agent', ownerId: 'ada', generation: 'a'.repeat(32), revision: 1, allowed: true as const, usage: null };
  const executeUsageCell = vi.fn(async () => cell);
  routerOwnerUsageProfile('agent');
  routerOwnerNavigation({ routes: [{ key: 'profile', name: 'beeline/agent-profile', params: { agentId: 'agent' } }] });
  await routerOwnerNegotiated({ generation: 1, families: [], usageCellV1: true, executeUsageCell, execute: async () => snapshot() });
  await settle();
  expect(executeUsageCell).toHaveBeenCalledTimes(1);
  expect(usageCellSnapshot('agent').cell).toEqual(cell);
  routerOwnerUsageProfile('agent'); await settle(); expect(executeUsageCell).toHaveBeenCalledTimes(1);
  routerOwnerReceive({ kind: 'usage-cell', cell: { ...cell, revision: 2, allowed: false, usage: undefined } });
  expect(usageCellSnapshot('agent').cell?.allowed).toBe(false);
  routerOwnerDisconnected(); expect(usageCellSnapshot('agent').cell).toBeNull();
  await routerOwnerNegotiated({ generation: 2, families: [], usageCellV1: true, executeUsageCell, execute: async () => snapshot() });
  await settle(); expect(executeUsageCell).toHaveBeenCalledTimes(2);
});

it('a healthy Room foreground resumes observation without a new pass and exposes explicit Retry for its unverified head',async()=>{
  const room={family:'room-head' as const,roomId:'11111111-1111-4111-8111-111111111111',workspaceId:'w'};
  const roomScopes=[...scopes,{authorityScope:'room:11111111-1111-4111-8111-111111111111',epoch:'1'}];
  const current={...snapshot(),family:'room-head',scope:'11111111-1111-4111-8111-111111111111',value:{room:{id:'11111111-1111-4111-8111-111111111111'},messages:[]},
    authority:{scopes:roomScopes,digest:hash(roomScopes)},atomicGroup:'room-head:room:ada'} as unknown as RouterSnapshot<'room-head'>;
  const execute=vi.fn(async()=>current);
  routerOwnerNavigation({routes:[{key:'room',name:'beeline/chat/[channelId]',params:{channelId:'11111111-1111-4111-8111-111111111111',communityId:'w'}}]});
  const lane=acquireRouterLane(room,()=>true,()=>{});
  await routerOwnerNegotiated({generation:1,families:['room-head'],execute});await settle();
  expect(lane.current().state).toBe('LIVE');expect(execute).toHaveBeenCalledTimes(1);
  fixture.state='background';fixture.events.forEach(listener=>listener('background'));
  fixture.state='active';fixture.events.forEach(listener=>listener('active'));await settle();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(lane.current()).toMatchObject({state:'PARKED',value:null,error:expect.stringContaining('Retry')});
  retryRouterLane(room);await settle();expect(execute).toHaveBeenCalledTimes(2);expect(lane.current().state).toBe('LIVE');
  lane.release();
});
