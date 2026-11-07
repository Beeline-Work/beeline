import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlyMachines } from './fly-machines.js';
import { FreeAgentService, freeAgentConfigFromEnv } from './free-agents.js';
import { LiveHub, type LiveEvent } from './live.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';

const OWNER = 'a'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const IMAGE = `registry.fly.io/beeline-free-agents:release@sha256:${'b'.repeat(64)}`;

describe('release refresh and committed free-agent sleep events', () => {
  let db: PgliteDatabase;
  let live: LiveHub;
  let service: FreeAgentService;
  let off: () => void;
  let failStart: string | undefined;
  let beforeSuspend: (() => Promise<void>) | undefined;
  const fleet = new Map<string, { state: string; instance_id: string; config: {
    image: string; env: { keep: string }; rootfs: { persist: string };
  } }>();
  const calls: string[] = [];
  const logs: string[] = [];
  const agentId = (n: number) => n.toString(16).padStart(64, '0');

  beforeEach(async () => {
    db = await migratedDatabase();
    live = new LiveHub();
    fleet.clear(); calls.length = 0; logs.length = 0; failStart = undefined; beforeSuspend = undefined;
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const match = new URL(String(url)).pathname.match(/\/machines\/(m\d+)(.*)/)!;
      const [, id, path] = match;
      const machine = fleet.get(id!)!;
      calls.push(`${init?.method} ${id}${path}`);
      if (!path && init?.method === 'GET') return Response.json(machine);
      if (!path && init?.method === 'POST') {
        const update = JSON.parse(String(init.body));
        expect(update.current_version).toBe(machine.instance_id);
        expect(update.skip_launch).toBe(true);
        machine.config = update.config;
        machine.instance_id += '-updated';
        machine.state = 'replacing';
        return Response.json({ instance_id: machine.instance_id });
      }
      if (path === '/stop') machine.state = 'stopped';
      else if (path === '/wait') machine.state = new URL(String(url)).searchParams.get('state')!;
      else if (path === '/suspend') { await beforeSuspend?.(); machine.state = 'suspended'; }
      else if (path === '/start') {
        if (id === failStart) return new Response('start refused', { status: 500 });
        machine.state = 'started';
      } else throw new Error(`Unexpected Fly call ${url}`);
      return Response.json({});
    });
    service = new FreeAgentService(db, freeAgentConfigFromEnv({
      BEELINE_FREE_AGENT_SEAL_KEY: 'test', FLY_FREE_AGENT_IMAGE: IMAGE,
    }, 'https://server.test')!, new FlyMachines('test', 'proof', request), async () => {
      throw new Error('refresh must not provision or bootstrap');
    }, line => logs.push(line));
    off = service.subscribeToWakes(live);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [OWNER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Refresh')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,visibility)
      VALUES($1,$2,$3,'General','public')`, [ROOM, WORKSPACE, OWNER]);
  });
  afterEach(async () => { off(); await db.close(); });

  async function seed(n: number, state = 'sleeping', flyState = 'suspended', removed = false, machine = true) {
    const agent = agentId(n);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Starter')`, [agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, OWNER]);
    await db.query(`INSERT INTO free_agents(agent_id,owner_id,workspace_id,sealed_keys,state,fly_machine_id,removed_at,created_at)
      VALUES($1,$2,$3,'sealed',$4,$5,CASE WHEN $6 THEN now() END,now()-interval '30 days')`,
    [agent, OWNER, WORKSPACE, state, machine ? `m${n}` : null, removed]);
    fleet.set(`m${n}`, { state: flyState, instance_id: `v${n}`, config: {
      image: 'registry.fly.io/beeline-free-agents:old@sha256:old',
      env: { keep: agent }, rootfs: { persist: 'always' },
    } });
    return agent;
  }

  async function command(n: number, state: 'pending' | 'claimed') {
    await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,
      root_command_id,root_source_message_id,agent_depth,state)
      VALUES($1,$2,$3,$1,'input','human_tag',$1,$1,0,$4)`, [`command-${n}`, ROOM, agentId(n), state]);
  }

  const commandEvent = (n: number): LiveEvent => ({ type: 'invalidate', roomId: ROOM,
    reason: 'postgres:agent_commands', targetAgentId: agentId(n), operation: 'UPDATE' });

  it('selects the entire sleeping fleet, preserves files, and suspends each refreshed helper on connection', async () => {
    // More than the former small refresh counts: old suspended snapshots and cold stops.
    for (let n = 1; n <= 32; n++) await seed(n, 'sleeping', n === 2 ? 'stopped' : 'suspended');
    for (const [i, state] of ['running', 'waking', 'stopped', 'failed', 'destroyed'].entries())
      await seed(40 + i, state);
    await seed(50, 'sleeping', 'suspended', true);
    await seed(51, 'sleeping', 'suspended', false, false);
    await service.refreshSleepingMachines();
    for (let n = 1; n <= 32; n++) expect(fleet.get(`m${n}`)).toMatchObject({ state: 'started',
      config: { image: IMAGE, env: { keep: agentId(n) }, rootfs: { persist: 'always' } } });
    expect(calls.some(call => /m(4\d|5\d)/.test(call))).toBe(false);
    expect((await db.query(`SELECT 1 FROM free_agent_events WHERE kind='refresh_started'`)).rowCount).toBe(32);
    expect((await db.query(`SELECT 1 FROM agent_commands`)).rowCount).toBe(0);
    for (let n = 1; n <= 32; n++) {
      await db.query(`UPDATE free_agents SET state='running' WHERE agent_id=$1`, [agentId(n)]);
      live.publish({ type: 'agent-connection', roomId: '', agentId: agentId(n), epoch: 1 });
    }
    await vi.waitFor(async () => expect((await db.query(`SELECT 1 FROM free_agent_events WHERE kind='slept'`)).rowCount).toBe(32));
    for (let n = 1; n <= 32; n++) expect(fleet.get(`m${n}`)?.state).toBe('suspended');
    expect(logs).toContain('release refresh started 32; unchanged 0; failed 0');
    // The next real command resumes the prepared snapshot, with no stop/update.
    calls.length = 0;
    await command(1, 'pending');
    expect(await service.wake(agentId(1))).toBe(true);
    expect(calls).toEqual(['GET m1', 'POST m1/start']);
  });

  it.each(['pending', 'claimed'] as const)('never suspends %s work; completion admits one suspend without a clock', async state => {
    await seed(1, 'running', 'started');
    fleet.get('m1')!.config.image = IMAGE;
    await command(1, state);
    const sleep = vi.spyOn(service, 'requestSleep');
    live.publish(commandEvent(1));
    expect(await sleep.mock.results.at(-1)!.value).toEqual({ sleep: false });
    expect(calls).toEqual([]);
    await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id='command-1'`);
    live.publish(commandEvent(1));
    expect(await sleep.mock.results.at(-1)!.value).toEqual({ sleep: true });
    await vi.waitFor(() => expect(fleet.get('m1')?.state).toBe('suspended'));
    live.publish(commandEvent(1));
    expect(await sleep.mock.results.at(-1)!.value).toEqual({ sleep: false });
    expect(calls.filter(call => call === 'POST m1/suspend')).toHaveLength(1);
  });

  it('attempts every selected Machine and exposes partial failures to the release command', async () => {
    await seed(1); await seed(2); failStart = 'm1';
    await expect(service.refreshSleepingMachines()).rejects.toThrow('Free-agent image refresh failed');
    expect(calls).toContain('POST m1/start');
    expect(calls).toContain('POST m2/start');
    expect((await db.query(`SELECT agent_id FROM free_agent_events WHERE kind='refresh_started'`)).rows)
      .toEqual([{ agent_id: agentId(2) }]);
    expect(logs).toContain('release refresh started 1; unchanged 0; failed 1');
  });

  it('protects connector installation until its committed completion event', async () => {
    await seed(1, 'running', 'started'); fleet.get('m1')!.config.image = IMAGE;
    await db.query(`INSERT INTO squire_machines(owner_id,machine_id,helper_agent_id,squire_work)
      VALUES($1,'connector-host',$2,'{"install":true}')`, [OWNER, agentId(1)]);
    // A live connection prevents the existing connector wake path from restarting it.
    await db.query(`INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('server',now())`);
    await db.query(`INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
      VALUES($1,1,'connection','server')`, [agentId(1)]);
    const sleep = vi.spyOn(service, 'requestSleep');
    const event: LiveEvent = { type: 'invalidate', roomId: '', reason: 'connector-assignment', targetAgentId: agentId(1) };
    live.publish(event);
    expect(await sleep.mock.results.at(-1)!.value).toEqual({ sleep: false });
    expect(calls).toEqual([]);
    await db.query(`UPDATE squire_machines SET squire_work='{}' WHERE owner_id=$1`, [OWNER]);
    live.publish(event);
    expect(await sleep.mock.results.at(-1)!.value).toEqual({ sleep: true });
    await vi.waitFor(() => expect(fleet.get('m1')?.state).toBe('suspended'));
  });

  it('arbitrates duplicate connection events across server subscribers with one suspend', async () => {
    await seed(1, 'running', 'started'); fleet.get('m1')!.config.image = IMAGE;
    const second = service.subscribeToWakes(live);
    try {
      live.publish({ type: 'agent-connection', roomId: '', agentId: agentId(1), epoch: 1 });
      await vi.waitFor(() => expect(fleet.get('m1')?.state).toBe('suspended'));
      expect(calls.filter(call => call === 'POST m1/suspend')).toHaveLength(1);
    } finally { second(); }
  });

  it('resumes work admitted during suspension from the actual suspend completion event', async () => {
    await seed(1, 'running', 'started'); fleet.get('m1')!.config.image = IMAGE;
    let finishSuspend!: () => void;
    beforeSuspend = () => new Promise<void>(resolve => { finishSuspend = resolve; });
    live.publish({ type: 'agent-connection', roomId: '', agentId: agentId(1), epoch: 1 });
    await vi.waitFor(() => expect(finishSuspend).toBeTypeOf('function'));
    await command(1, 'pending');
    expect(await service.wake(agentId(1))).toBe(true);
    // The still-serving helper can claim the command before Fly finishes freezing.
    await db.query(`UPDATE agent_commands SET state='claimed' WHERE id='command-1'`);
    finishSuspend();
    await vi.waitFor(() => expect(calls.filter(call => call === 'POST m1/start')).toHaveLength(2));
    expect(fleet.get('m1')?.state).toBe('started');
  });
});
