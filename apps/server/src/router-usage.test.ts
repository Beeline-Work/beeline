import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentUsageCell } from '@beeline/api-contract/helper-usage';
const fixture = vi.hoisted(() => ({ enabled: false, send: undefined as undefined | ((cell: AgentUsageCell) => void),
  unavailable: undefined as undefined | (() => void), release: vi.fn(), fence: vi.fn() }));
vi.mock('./helper-usage.js', () => ({ helperUsageEnabled: () => fixture.enabled,
  subscribeAgentUsageCells: vi.fn((_db, _owner, send, unavailable, ready) => {
    fixture.send = send; fixture.unavailable = unavailable; ready(); return fixture.release;
  }), fenceAgentUsageCellEnqueue: (...args: unknown[]) => fixture.fence(...args),
}));
import { routerSocketProtocol } from './router-socket.js';
import { LiveHub } from './live.js';
import type { SqlDatabase } from './database.js';
import type { PhoneService } from './phone-service.js';
const cell: AgentUsageCell = { v: 1, agentId: 'agent', ownerId: 'owner', generation: 'a'.repeat(32), revision: 1, allowed: true, usage: null };
function setup(ready = true) {
  const query = vi.fn(async () => { throw new Error('No initial data query authorized'); });
  const db = { query } as unknown as SqlDatabase;
  const live = new LiveHub(); const frames: Record<string, unknown>[] = [];
  const protocol = routerSocketProtocol(db, 'owner', frame => frames.push(JSON.parse(frame)),
    { families: [], listenerReady: () => ready }, { live, phone: {} as PhoneService, rooms: () => [] });
  return { db, query, live, frames, protocol };
}
beforeEach(() => { fixture.enabled = false; fixture.send = undefined; fixture.unavailable = undefined; vi.clearAllMocks(); });
describe('independently negotiated usage source lane', () => {
  it('requires explicit protocol support, deployment gate and ready committed listener', async () => {
    for (const [enabled, ready, message] of [[false, true, {protocol:1, usageCellV1:true}],
      [true, false, {protocol:1, usageCellV1:true}], [true, true, {protocol:1}],
      [true, true, {protocol:2, usageCellV1:true}]] as const) {
      fixture.enabled = enabled;
      const { protocol, frames, query } = setup(ready);
      await protocol.handle({ type:'router-negotiate', ...message });
      expect(protocol.supportsUsage()).toBe(false); expect(frames.at(-1)?.usageCellV1).toBeUndefined();
      expect(() => protocol.requireUsage()).toThrow(); expect(query).not.toHaveBeenCalled(); protocol.close();
    }
    expect(fixture.send).toBeUndefined();
  });
  it('installs one owner source without held-key or profile inventory and routes committed cells', async () => {
    fixture.enabled = true; const { protocol, frames, query } = setup();
    await protocol.handle({ type:'router-negotiate', protocol:1, usageCellV1:true });
    expect(frames.at(-1)).toMatchObject({type:'router-capabilities',usageCellV1:true});
    expect(protocol.supportsUsage()).toBe(true); expect(query).not.toHaveBeenCalled();
    fixture.send!(cell); expect(frames.at(-1)).toEqual({kind:'usage-cell',cell});
    protocol.close(); expect(fixture.release).toHaveBeenCalledOnce();
    fixture.send!(cell); expect(frames.filter(frame=>frame.kind==='usage-cell')).toHaveLength(1);
  });
  it('lost listener readiness hides cells and refuses reads without a retry', async () => {
    fixture.enabled = true; const { protocol, live, frames, query } = setup();
    await protocol.handle({ type:'router-negotiate', protocol:1, usageCellV1:true });
    live.projectionUnavailable();
    expect(frames.at(-1)).toEqual({kind:'usage-unavailable'}); expect(protocol.supportsUsage()).toBe(false);
    expect(() => protocol.requireUsage()).toThrow(); expect(query).not.toHaveBeenCalled();
    fixture.send!(cell); expect(frames.filter(frame=>frame.kind==='usage-cell')).toHaveLength(0); protocol.close();
  });
  it('uses the current owner fence for the initial cell reply at synchronous enqueue', async () => {
    fixture.enabled = true; const { protocol, db } = setup();
    await protocol.handle({ type:'router-negotiate', protocol:1, usageCellV1:true });
    const denied = {...cell,revision:2,allowed:false,usage:undefined};
    fixture.fence.mockImplementation(async (_db,_owner,_cell,send) => send(denied));
    const enqueue = vi.fn(); await protocol.fenceReply('readAgentUsageCell',{agentId:'agent'},cell,enqueue);
    expect(fixture.fence).toHaveBeenCalledWith(db,'owner',cell,expect.any(Function));
    expect(enqueue).toHaveBeenCalledWith(denied); protocol.close();
  });
});
