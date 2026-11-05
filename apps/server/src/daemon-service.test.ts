import type { QueryResult } from "./database.js";
import { describe } from 'vitest';
import { describe } from 'vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { DaemonService } from './daemon-service.js';
import type { SqlDatabase } from './database.js';
import { LiveHub } from './live.js';


describe("turn-ownership-recovery", () => {
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
it.each([true, false])('never redispatches a failed effect after 24h (owned=%s)',async owned=>{
  vi.useFakeTimers();
  const timers=vi.spyOn(globalThis,'setTimeout');
  const deadlock=Object.assign(new Error('Synthetic transaction rolled back'),{code:'40P01'});
  const query=vi.fn(async(sql:string)=>sql.includes('agent_command_generation_owners')
    ?{rows:owned?[{owned:true}]:[],rowCount:owned?1:0}
    :{rows:[{corner_reviewer:false,is_corner:false,private_command:false,voice_agent_name:null}],rowCount:1});
  const transaction=vi.fn(async()=>{throw deadlock;});
  const daemon=new DaemonService({query,transaction} as unknown as SqlDatabase,new LiveHub());
  const input={roomId:'11111111-1111-4111-8111-111111111111',requestId:'same-request',generationId:'same-generation',activity:[]};
  const result=daemon.execute('postAgentActivity',input,'synthetic-agent').catch(error=>error);
  await vi.advanceTimersByTimeAsync(24*60*60_000);
  expect(await result).toBe(deadlock);
  expect(transaction).toHaveBeenCalledOnce();expect(timers).not.toHaveBeenCalled();
  expect(query).toHaveBeenCalledTimes(2);
  expect(input).toMatchObject({requestId:'same-request',generationId:'same-generation'});
});
});


describe("daemon-service.access", () => {
const ROOM = '11111111-1111-4111-8111-111111111111';
const AGENT = 'a'.repeat(64);

describe('daemon room access', () => {
  it('offers active-only discovery without changing the historical listing', async () => {
    const query = vi.fn(async <Row>(sql: string): Promise<QueryResult<Row>> => {
      if (sql.includes('FROM room_access WHERE room_id=$1'))
        return { rows: [{ corner_reviewer: false, is_corner: false }] as Row[], rowCount: 1 };
      if (sql.includes('FROM rooms r JOIN corner_facts f')) {
        const rows = [
          { id: 'active', parent_id: ROOM, created_by: AGENT, archived: false,
            closed_at: null, lifecycle: {}, name: 'Active', objective: 'Active' },
          { id: 'archived', parent_id: ROOM, created_by: AGENT, archived: true,
            closed_at: new Date(), lifecycle: {}, name: 'Old', objective: 'Old' },
        ];
        const activeOnly = sql.includes('AND r.archived_at IS NULL');
        return { rows: (activeOnly ? rows.slice(0, 1) : rows) as Row[],
          rowCount: activeOnly ? 1 : 2 };
      }
      return { rows: [], rowCount: 0 };
    });
    const daemon = new DaemonService({ query } as unknown as SqlDatabase, new LiveHub());
    const active = await daemon.execute('listRoomCorners', { roomId: ROOM, activeOnly: true }, AGENT);
    const all = await daemon.execute('listRoomCorners', { roomId: ROOM }, AGENT);
    expect(active.corners.map((corner) => corner.cornerId)).toEqual(['active']);
    expect(all.corners.map((corner) => corner.cornerId)).toEqual(['active', 'archived']);
    expect(query.mock.calls.find(([sql]) => sql.includes('FROM rooms r JOIN corner_facts f'))?.[0])
      .toContain('AND r.archived_at IS NULL');
  });

  it('projects only existing member Room/corner lifecycle facts without expanding top-level discovery', async () => {
    const query = vi.fn(async <Row>(sql: string): Promise<QueryResult<Row>> => {
      if (sql.includes('SELECT r.id room_id, r.parent_id')) return { rows: [
        { room_id: ROOM, parent_id: null, archived: false, repository_revision: 'v1' },
        { room_id: 'archived-corner', parent_id: ROOM, archived: true, landed_head_sha: 'b'.repeat(40) },
      ] as Row[], rowCount: 2 };
      return { rows: [], rowCount: 0 };
    });
    const daemon = new DaemonService({ query } as unknown as SqlDatabase, new LiveHub());
    const result = await daemon.execute('getDaemonBootstrap', { agentId: AGENT }, AGENT);
    expect(result.rooms.map(room => room.roomId)).toEqual([ROOM]);
    expect(result.storageRooms).toEqual([
      { roomId: ROOM, archived: false }, { roomId: 'archived-corner', archived: true, landedHeadSha: 'b'.repeat(40) },
    ]);
    const sql = query.mock.calls.find(([sql]) => sql.includes('SELECT r.id room_id, r.parent_id'))?.[0];
    expect(sql).toContain('m.room_id=COALESCE(r.parent_id,r.id)');
    expect(sql).toContain('m.identity_id=$1 AND (m.removed_at IS NULL OR');
    expect(sql).toContain('(r.parent_id IS NULL AND r.archived_at IS NOT NULL)');
    expect(sql).toContain("f.lifecycle->>'outcome'='landed'");
    expect(sql).toContain("f.lifecycle->'pr'->>'mergedAt' IS NOT NULL");
  });

  it('checks membership once when listing a Room\'s corners', async () => {
    const query = vi.fn(async <Row>(sql: string): Promise<QueryResult<Row>> => {
      if (sql.includes('FROM room_access WHERE room_id=$1'))
        return { rows: [{ corner_reviewer: false, is_corner: false }] as Row[], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const database = { query } as unknown as SqlDatabase;
    const daemon = new DaemonService(database, new LiveHub());

    await expect(daemon.execute('listRoomCorners', { roomId: ROOM }, AGENT))
      .resolves.toEqual({ corners: [] });
    expect(query.mock.calls.filter(([sql]) => sql.includes('FROM room_access WHERE room_id=$1')))
      .toHaveLength(1);
  });

  it('checks membership once when restoring a corner', async () => {
    const query = vi.fn(async <Row>(sql: string): Promise<QueryResult<Row>> => {
      if (sql.includes('FROM room_access WHERE room_id=$1'))
        return { rows: [{ corner_reviewer: false, is_corner: true }] as Row[], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const daemon = new DaemonService({ query } as unknown as SqlDatabase, new LiveHub());

    await daemon.execute('getCornerRestoreState', { cornerId: ROOM }, AGENT);
    expect(query.mock.calls.filter(([sql]) => sql.includes('FROM room_access WHERE room_id=$1')))
      .toHaveLength(1);
  });
  it('reports an active human hold on the restore state', async () => {
    const query = vi.fn(async <Row>(sql: string): Promise<QueryResult<Row>> => {
      if (sql.includes('FROM room_access WHERE room_id=$1'))
        return { rows: [{ corner_reviewer: false, is_corner: true }] as Row[], rowCount: 1 };
      if (sql.includes('FROM corner_merge_holds WHERE corner_id=$1'))
        return {
          rows: [{ id: 'hold-1', actorId: 'a'.repeat(64), standing: 'owner', setAt: 'now' }] as Row[],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    });
    const daemon = new DaemonService({ query } as unknown as SqlDatabase, new LiveHub());

    await expect(
      daemon.execute('getCornerRestoreState', { cornerId: ROOM }, AGENT),
    ).resolves.toMatchObject({ held: true });
  });
  it('denies a malformed Room id before the UUID access query', async () => {
    const query = vi.fn(async () => {
      throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' });
    });
    const daemon = new DaemonService({ query } as unknown as SqlDatabase, new LiveHub());

    await expect(daemon.execute('getCornerRestoreState', { cornerId: 'not-a-uuid' }, AGENT))
      .rejects.toThrow('daemon room access denied');
    expect(query).not.toHaveBeenCalled();
  });
});
});
