import { describe, it, expect } from 'vitest';
import { AdmissionOwner, type Pass } from './private/admission.js';
import { canonical } from './private/canonical.js';
import { routes } from './routes.js';

const identity = { origin: 'https://example.test', principal: 'ada', sessionEpoch: 1 };
const room = { route: 'phone.readRoom', input: { roomId: 'room-a' } } as const;
const count = { route: 'phone.countNeedsYou', input: { workspaceId: 'workspace-a' } } as const;
const send = { route: 'phone.sendRoomMessage', input: { roomId: 'room-a', text: 'Hello', messageId: 'a'.repeat(64) } } as const;

describe('local admission shadow core (P1)', () => {
  it('spends atomically once and carries no pass fields into the wire operation', () => {
    const owner = new AdmissionOwner(identity);
    const [pass] = owner.focus(1, 'Room', [room]);
    expect(JSON.stringify(pass)).toBe('{}');
    expect(owner.spend(room, pass!).wire).toEqual({ operation: 'readRoom', input: '{"roomId":"room-a"}' });
    expect(() => owner.spend(room, pass!)).toThrow('inactive pass');
    const other = new AdmissionOwner({ ...identity, sessionEpoch: 42 });
    const [otherPass] = other.focus(999, 'Room', [room]);
    expect(other.spend(room, otherPass!).wire).toEqual({ operation: 'readRoom', input: '{"roomId":"room-a"}' });
  });

  it('rejects fabricated, JSON-restored and foreign-owner capabilities', () => {
    const owner = new AdmissionOwner(identity);
    const [pass] = owner.focus(1, 'Room', [room]);
    for (const fake of [{}, JSON.parse(JSON.stringify(pass))])
      expect(() => owner.spend(room, fake as Pass<'phone.readRoom'>)).toThrow('inactive pass');
    expect(() => new AdmissionOwner(identity).spend(room, pass!)).toThrow('inactive pass');
  });

  it('binds exact route and canonical key; wrong attempts dispatch nothing', () => {
    const owner = new AdmissionOwner(identity);
    const [pass] = owner.focus(1, 'Room', [room]);
    expect(() => owner.spend({ ...room, input: { roomId: 'room-b' } }, pass!)).toThrow('wrong route or key');
    expect(() => owner.spend(count, pass as unknown as Pass<'phone.countNeedsYou'>)).toThrow('wrong route or key');
    expect(owner.spend(room, pass!).wire.operation).toBe('readRoom');
  });

  it('joins StrictMode/render repetitions, but cannot remint a spent or blurred residency', () => {
    const owner = new AdmissionOwner(identity);
    const [pass] = owner.focus(1, 'Room', [room]);
    expect(owner.focus(1, 'Room', [room])[0]).toBe(pass);
    owner.spend(room, pass!);
    expect(() => owner.spend(room, owner.focus(1, 'Room', [room])[0]!)).toThrow('inactive pass');
    expect(() => owner.focus(1, 'Room', [{ ...room, input: { roomId: 'changed' } }])).toThrow('residency changed');
    owner.blur();
    expect(() => owner.focus(1, 'Room', [room])).toThrow('stale residency');
    expect(owner.focus(2, 'Room', [room])[0]).not.toBe(pass);
  });

  it('background and session resets revoke deferred reads and late replies', () => {
    const owner = new AdmissionOwner(identity);
    const [pass] = owner.focus(1, 'Room', [room]);
    const result = owner.spend(room, pass!);
    expect(result.isCurrent()).toBe(true);
    owner.background();
    expect(result.isCurrent()).toBe(false);
    expect(() => owner.focus(2, 'Room', [room])).toThrow('background');
    owner.foregrounded();
    expect(result.isCurrent()).toBe(false);
    const [next] = owner.focus(2, 'Room', [room]);
    owner.reset({ ...identity, principal: 'juniper' });
    expect(() => owner.spend(room, next!)).toThrow('inactive pass');
  });

  it('ends a tap on synchronous return, even when its handler returns a Promise', async () => {
    const owner = new AdmissionOwner(identity);
    await owner.tap('SendMessage', send, async pass => {
      await Promise.resolve();
      expect(() => owner.spend(send, pass)).toThrow('inactive pass');
    });
    const prepared = owner.tap('SendMessage', send, pass => owner.spend(send, pass));
    expect(prepared.isCurrent()).toBe(true); // immutable intent outlives gesture
    owner.background();
    expect(prepared.isCurrent()).toBe(true);
    owner.reset({ ...identity, sessionEpoch: 2 });
    expect(prepared.isCurrent()).toBe(false); // cannot flush under a new session
  });

  it('requires prepared command identity before admitting a send', () => {
    const owner = new AdmissionOwner(identity);
    expect(() => owner.tap('SendMessage', { ...send, input: { roomId: 'room-a', text: 'Hello' } }, () => {}))
      .toThrow('prepared message identity required');
  });

  it('gives a negotiated generation one recovery batch, never renews on failures', () => {
    const owner = new AdmissionOwner(identity);
    const [pass] = owner.connected(1, [room]);
    owner.spend(room, pass!);
    expect(() => owner.connected(1, [room])).toThrow('stale connection');
    const [next] = owner.connected(2, [room]);
    owner.background();
    owner.foregrounded();
    expect(() => owner.spend(room, next!)).toThrow('inactive pass');
    expect(() => owner.connected(2, [room])).toThrow('stale connection');
  });

  it('bounds owner keys and keeps a bounded local-only denial ring', () => {
    const owner = new AdmissionOwner(identity);
    expect(() => owner.focus(1, 'Room', [room, room])).toThrow('duplicate key');
    const many = Array.from({ length: 17 }, (_, i) => ({ ...room, input: { roomId: String(i) } }));
    expect(() => owner.focus(1, 'Room', many)).toThrow('quota');
    for (let i = 0; i < 150; i++) expect(() => owner.focus(-1, 'Room', [])).toThrow('invalid generation');
    expect(owner.localDiagnostics()).toHaveLength(100);
    expect(JSON.stringify(owner.localDiagnostics()).length).toBeLessThan(16 * 1024);
  });

  it('does not enable any production route or export an arbitrary executor', async () => {
    const api = await import('./index.js');
    expect(Object.keys(api)).toEqual(['routes']);
    expect(Object.keys(routes).length).toBeGreaterThan(300);
    expect(Object.values(routes).every(route => route.compatibility === 'legacy-only')).toBe(true);
    expect(Object.isFrozen(routes)).toBe(true);
    expect(Object.isFrozen(routes['phone.readRoom'])).toBe(true);
  });
});

describe('canonical local keys', () => {
  it('ignores object insertion order but preserves arrays and refuses non-JSON', () => {
    expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
    const cycle: unknown[] = []; cycle.push(cycle);
    for (const input of [cycle, NaN, Infinity, undefined, new Date(), new Array(2), { get a() { return 1; } }])
      expect(() => canonical(input)).toThrow();
    expect(() => canonical('x'.repeat(65536))).toThrow('too large');
  });
});
