import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgliteDatabase } from './test-support.js';
import {installBackgroundOwnerTestProof,backgroundOwnerTestLock} from './test-fixtures/background-owner-test-support.js';
import { BackgroundOwnership, BACKGROUND_OWNERSHIP_SCHEMA, BackgroundEffectConflict,
  BackgroundOwnershipLost, BackgroundEnqueueContractError, type BackgroundEpoch,
  type BackgroundAttempt, type BackgroundEffectRequest } from './background-ownership.js';
import {TRAY_CLOCK_OWNER_SCHEMA} from './tray-clock-owner.js';

const database=new PgliteDatabase();
const cores:Array<{owner:BackgroundOwnership;epoch:BackgroundEpoch}>=[];
const lock=(held=true)=>backgroundOwnerTestLock(database,held);
const request=(effectId='delivery'):BackgroundEffectRequest<'push.deliver'>=>({job:'push.deliver',effectId,
  sourceClaimId:'source-delivery',sourceClaimVersion:'revision-1',provider:'fcm',canonicalRequest:'{"message":"synthetic"}'});
async function owner(){
  await database.query("INSERT INTO live_server_instances VALUES('instance',clock_timestamp()) ON CONFLICT(instance_id) DO UPDATE SET renewed_at=EXCLUDED.renewed_at");
  const core=new BackgroundOwnership(database,'instance'),epoch=await core.claim(await lock());cores.push({owner:core,epoch});return {core,epoch};
}
async function prepare(core:BackgroundOwnership,epoch:BackgroundEpoch,effectId='delivery'){
  const result=await core.prepareEffect(epoch,request(effectId));if(result.kind!=='new')throw new Error('Expected fresh synthetic attempt');return result.attempt;
}
beforeAll(async()=>{
  await database.query(`CREATE TABLE live_server_instances(instance_id text PRIMARY KEY,renewed_at timestamptz NOT NULL);
    CREATE TABLE effects(id text PRIMARY KEY);${BACKGROUND_OWNERSHIP_SCHEMA}${TRAY_CLOCK_OWNER_SCHEMA}`);
  await installBackgroundOwnerTestProof(database);
});
beforeEach(async()=>{await database.query('DELETE FROM background_effect_attempts;DELETE FROM background_leader_owners;DELETE FROM live_server_instances;DELETE FROM effects;DELETE FROM background_owner_test_backends');});
afterEach(()=>{for(const {owner,epoch}of cores.splice(0))owner.revoke(epoch);vi.restoreAllMocks();vi.useRealTimers();});
afterAll(()=>database.close());

describe('private background owner epochs and immutable effect admission',()=>{
  it('admits only the explicit readiness job through the same deferred owner fence and rolls back epoch loss',async()=>{
    const {core,epoch}=await owner();
    await core.withTransaction(epoch,'tray.readiness',async db=>{
      expect((await db.query(`SELECT * FROM tray_clock_owner_fences`)).rowCount).toBe(1);
      await db.query(`INSERT INTO effects VALUES('ready')`);
    });
    expect((await database.query(`SELECT * FROM tray_clock_owner_fences`)).rows).toEqual([]);
    await expect(core.withTransaction(epoch,'tray.readiness',async db=>{
      await db.query(`INSERT INTO effects VALUES('lost-readiness')`);core.revoke(epoch);
    })).rejects.toBeInstanceOf(BackgroundOwnershipLost);
    expect((await database.query(`SELECT id FROM effects ORDER BY id`)).rows).toEqual([{id:'ready'}]);
  });
  it('requires an actual lock proof and live aggregate lease, never caller readiness flags',async()=>{
    const core=new BackgroundOwnership(database,'instance');
    await expect(core.claim(await lock(false))).rejects.toBeInstanceOf(BackgroundOwnershipLost);
    await expect(core.claim(await lock())).rejects.toBeInstanceOf(BackgroundOwnershipLost);
    expect((await database.query('SELECT * FROM background_leader_owners')).rowCount).toBe(0);
  });
  it('mints monotone generations, rejects cloned epochs and fences the previous generation',async()=>{
    const first=await owner();await first.core.withTransaction(first.epoch,'schedule.fire',async db=>{await db.query("INSERT INTO effects VALUES('one')");});
    const second=await owner();expect(BigInt(second.epoch.generation)).toBeGreaterThan(BigInt(first.epoch.generation));
    await expect(first.core.withTransaction(first.epoch,'schedule.fire',async db=>{await db.query("INSERT INTO effects VALUES('stale')");})).rejects.toBeInstanceOf(BackgroundOwnershipLost);
    expect(first.epoch.signal.aborted).toBe(true);
    await expect(second.core.withTransaction({...second.epoch},'schedule.fire',async()=>{})).rejects.toBeInstanceOf(BackgroundOwnershipLost);
    expect((await database.query('SELECT id FROM effects')).rows).toEqual([{id:'one'}]);
  });
  it.each([{backend_pid:0,backend_start:'2000-01-01'}, {backend_pid:2147483648,backend_start:'2000-01-01'},
    {backend_pid:1.5,backend_start:'2000-01-01'}, {backend_pid:123}, {backend_pid:123,backend_start:''},
    {backend_pid:123,backend_start:'x'.repeat(129)}])('refuses an unbounded/missing dedicated backend proof %j before any epoch row',async proof=>{
    const core=new BackgroundOwnership(database,'instance');
    const invalid={query:async<Row>()=>({rows:[{held:true,...proof} as unknown as Row]})};
    await expect(core.claim(invalid)).rejects.toBeInstanceOf(BackgroundOwnershipLost);
    expect((await database.query('SELECT * FROM background_leader_owners')).rowCount).toBe(0);
  });
  it('rejects a lost exact backend even with fresh aggregate evidence and no replacement generation',async()=>{
    await database.query(`INSERT INTO live_server_instances VALUES('instance',clock_timestamp())`);
    const backend=await lock(),core=new BackgroundOwnership(database,'instance'),epoch=await core.claim(backend);cores.push({owner:core,epoch});
    await backend.lose();const effect=vi.fn(async()=>{});
    await expect(core.withTransaction(epoch,'systemDm.deliver',effect)).rejects.toBeInstanceOf(BackgroundOwnershipLost);
    expect(effect).not.toHaveBeenCalled();expect(epoch.signal.aborted).toBe(true);
  });
  it('rolls back database work when ownership is revoked before the commit boundary',async()=>{
    const {core,epoch}=await owner();let finish!:()=>void,entered!:()=>void;
    const reached=new Promise<void>(resolve=>{entered=resolve;});
    const operation=core.withTransaction(epoch,'systemDm.deliver',async db=>{
      await db.query("INSERT INTO effects VALUES('canceled')");entered();await new Promise<void>(resolve=>{finish=resolve;});
    });
    const denied=expect(operation).rejects.toBeInstanceOf(BackgroundOwnershipLost);
    await reached;core.revoke(epoch);finish();await denied;
    expect((await database.query('SELECT * FROM effects')).rowCount).toBe(0);
  });
  it('keeps private epoch loss final even when newer aggregate evidence arrives',async()=>{
    const {core,epoch}=await owner();core.revoke(epoch);
    core.observeServerLease('instance',Date.now()+1000);expect(epoch.signal.aborted).toBe(true);
    await expect(core.withTransaction(epoch,'schedule.fire',async()=>{})).rejects.toBeInstanceOf(BackgroundOwnershipLost);
  });
  it('uses authoritative lease expiry before work even if no lock-connection loss was delivered',async()=>{
    const {core,epoch}=await owner();await database.query("UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '91 seconds'");
    const effect=vi.fn(async()=>{});
    await expect(core.withTransaction(epoch,'schedule.fire',effect)).rejects.toBeInstanceOf(BackgroundOwnershipLost);
    expect(effect).not.toHaveBeenCalled();expect(epoch.signal.aborted).toBe(true);
  });
  it('commits UNKNOWN and frozen bytes before enqueue and never offers a replay handle',async()=>{
    const {core,epoch}=await owner();const input={...request()};const pending=core.prepareEffect(epoch,input);
    input.canonicalRequest='changed after admission';const prepared=await pending;
    expect(prepared.kind).toBe('new');if(prepared.kind!=='new')return;
    expect((await database.query('SELECT state,canonical_request FROM background_effect_attempts')).rows)
      .toEqual([{state:'unknown',canonical_request:'{"message":"synthetic"}'}]);
    const send=vi.fn((_value:BackgroundEffectRequest<'push.deliver'>)=>undefined);
    expect((await core.enqueue(epoch,prepared.attempt,send)).state).toBe('unknown');
    expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0]![0].canonicalRequest).toBe('{"message":"synthetic"}');
    expect(Object.isFrozen(send.mock.calls[0]![0])).toBe(true);
    await expect(core.enqueue(epoch,prepared.attempt,send)).rejects.toBeInstanceOf(BackgroundOwnershipLost);
    expect((await core.prepareEffect(epoch,request())).kind).toBe('existing');expect(send).toHaveBeenCalledTimes(1);
    await expect(core.prepareEffect(epoch,{...request(),canonicalRequest:'different'})).rejects.toBeInstanceOf(BackgroundEffectConflict);
  });
  it('denies delayed prepared work after takeover without erasing its prior UNKNOWN record',async()=>{
    const first=await owner(),attempt=await prepare(first.core,first.epoch);await owner();const send=vi.fn(()=>undefined);
    await expect(first.core.enqueue(first.epoch,attempt,send)).rejects.toBeInstanceOf(BackgroundOwnershipLost);
    expect(send).not.toHaveBeenCalled();expect((await database.query('SELECT state FROM background_effect_attempts')).rows).toEqual([{state:'unknown'}]);
  });
  it('rejects a known async adapter before invocation; a regular thenable-returning fault stays UNKNOWN without replay',async()=>{
    const {core,epoch}=await owner();const first=await prepare(core,epoch,'async'),second=await prepare(core,epoch,'thenable');
    let calls=0;
    const asyncAdapter=(async()=>{calls++;}) as unknown as (_request:BackgroundEffectRequest<'push.deliver'>)=>undefined;
    await expect(core.enqueue(epoch,first,asyncAdapter)).rejects.toBeInstanceOf(BackgroundEnqueueContractError);expect(calls).toBe(0);
    const thenableAdapter=(()=>{calls++;return Promise.resolve();}) as unknown as (_request:BackgroundEffectRequest<'push.deliver'>)=>undefined;
    await expect(core.enqueue(epoch,second,thenableAdapter)).rejects.toBeInstanceOf(BackgroundEnqueueContractError);expect(calls).toBe(1);
    await expect(core.enqueue(epoch,second,()=>undefined)).rejects.toBeInstanceOf(BackgroundOwnershipLost);
    expect((await database.query("SELECT count(*)::int count FROM background_effect_attempts WHERE state='unknown'")).rows[0]?.count).toBe(2);
  });
  it('preserves committed UNKNOWN when the final fence commit acknowledgment fails after enqueue',async()=>{
    const {core,epoch}=await owner(),attempt=await prepare(core,epoch);const original=database.transaction.bind(database);
    vi.spyOn(database,'transaction').mockImplementationOnce(async work=>{await original(work);throw new Error('lost final commit acknowledgment');});
    const send=vi.fn(()=>undefined);
    await expect(core.enqueue(epoch,attempt,send)).rejects.toThrow('lost final commit');expect(send).toHaveBeenCalledTimes(1);
    expect((await database.query('SELECT state FROM background_effect_attempts')).rows).toEqual([{state:'unknown'}]);
    await expect(core.enqueue(epoch,attempt,send)).rejects.toBeInstanceOf(BackgroundOwnershipLost);expect(send).toHaveBeenCalledTimes(1);
  });
  it('settles only the exact entered attempt once, including a late outcome after leader loss',async()=>{
    const {core,epoch}=await owner(),attempt=await prepare(core,epoch);await core.enqueue(epoch,attempt,()=>undefined);core.revoke(epoch);
    expect((await core.recordOutcome(attempt,'succeeded','verified synthetic receipt')).state).toBe('succeeded');
    expect((await core.recordOutcome(attempt,'succeeded','verified synthetic receipt')).state).toBe('succeeded');
    await expect(core.recordOutcome(attempt,'failed','conflicting receipt')).rejects.toBeInstanceOf(BackgroundEffectConflict);
  });
  it('does not dispatch if durable preparation fails and bounds bytes and closed job/provider correlation',async()=>{
    const {core,epoch}=await owner();
    await expect(core.prepareEffect(epoch,{...request(),canonicalRequest:'x'.repeat(65_537)})).rejects.toBeInstanceOf(BackgroundEffectConflict);
    await expect(core.prepareEffect(epoch,{...request(),provider:'email'} as unknown as BackgroundEffectRequest<'push.deliver'>)).rejects.toBeInstanceOf(BackgroundEffectConflict);
    const original=database.transaction.bind(database);
    vi.spyOn(database,'transaction').mockImplementationOnce(async work=>original(async tx=>{await work(tx);throw new Error('prepare rollback');}));
    await expect(core.prepareEffect(epoch,request())).rejects.toThrow('prepare rollback');
    expect((await database.query('SELECT * FROM background_effect_attempts')).rowCount).toBe(0);
  });
});

// Type-only guard: the concrete private adapter must return undefined, not
// void, because TypeScript permits Promise-returning callbacks where void fits.
function callbackTypes(core:BackgroundOwnership,epoch:BackgroundEpoch,attempt:BackgroundAttempt<'push.deliver'>){
  if(false){
    // @ts-expect-error Async provider completion cannot be returned under the row fence.
    void core.enqueue(epoch,attempt,async()=>{});
    // @ts-expect-error The closed push provider cannot be an email adapter.
    const invalid:BackgroundEffectRequest<'push.deliver'>={...request(),provider:'email'};
    void invalid;
  }
}
void callbackTypes;
