import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { RouterSnapshot, RouterSnapshotInput } from '@beeline/api-contract/router-protocol';
const fixture = vi.hoisted(() => ({
  state: 'active', events: [] as ((state: string) => void)[],
  storage: { write: vi.fn(async () => {}), fence: vi.fn(async () => {}), remove: vi.fn(async () => {}), subscribeFences: () => () => {} },
}));
vi.mock('react-native', () => ({ AppState: { get currentState() { return fixture.state; }, addEventListener: (_event: string, listener: (state: string) => void) => {
  fixture.events.push(listener); return { remove: () => {} };
} } }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: 'ada' }), getEffectiveRelayUrl: async () => 'https://example.test',
}));
vi.mock('./surface-storage', () => ({ routerLaneStorage: () => fixture.storage }));
import { resetClientState } from '@/sync/client-reset';
import { acquireRouterLane, routerOwnerNegotiated, routerOwnerNavigation, routerOwnerDisconnected,
  routerFamilyMode, routerOwnerReceive, retryRouterLane } from './router-owner';
const request = { family: 'needs-you-count' as const, workspaceId: 'w' };
const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
const scopes = [{ authorityScope: 'reader:ada:workspace:w', epoch: '1' }];
const authority = { digest: hash(scopes), scopes };
const snapshot = (value = 1): RouterSnapshot<'needs-you-count'> => ({ kind: 'snapshot', family: 'needs-you-count', scope: 'w',
  value: { count: value }, cut: { stream: 'workspace:w', epoch: 'stream', protocol: 1, through: value },
  authority, atomicGroup: 'needs:w:ada' });
const navigation = (key = 'channels') => ({ routes: [{ key, name: 'beeline/channels' }] });
const settle = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
beforeEach(() => { fixture.state = 'active'; resetClientState(); vi.clearAllMocks(); });

describe('real mobile router owner', () => {
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
    routerOwnerNavigation(navigation());
    const lane = acquireRouterLane(request, () => true, () => {});
    await routerOwnerNegotiated({ generation: 1, families: ['needs-you-count'], execute }); await settle();
    const removedScopes = [{ authorityScope: 'reader:ada:workspace:w', epoch: '2' }];
    const facts = [{ atomicGroup: 'workspace-authority', authority: { digest: hash(removedScopes), scopes: removedScopes },
      payload: { kind: 'authority', scope: 'w', authorityScope: 'reader:ada:workspace:w', allowed: false } }];
    const frame = { batchId: 'revoke', from: snapshot().cut, to: snapshot(2).cut, partCount: 1, contentDigest: hash(facts) };
    routerOwnerReceive({ ...frame, kind: 'push-part', partIndex: 0, facts });
    routerOwnerReceive({ ...frame, kind: 'push-commit' });
    await settle();
    expect(lane.current()).toMatchObject({ state: 'REVOKED', value: null });
    expect(fixture.storage.fence).toHaveBeenCalledWith('reader:ada:workspace:w', '2');
    expect(execute).toHaveBeenCalledTimes(1);
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
