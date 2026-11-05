import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundLeader, type LeaderConnection } from './background-leader.js';
vi.mock('./sentry.js', () => ({ captureServerError: vi.fn() }));
const settle = async () => { for (let i=0;i<40;i++) await Promise.resolve(); };
class Ownership {
  owner?: Client;
  clients: Client[] = [];
  connect = async () => { const client=new Client(this);this.clients.push(client);return client; };
  advance() { if (!this.owner) this.clients.find(c=>c.waiting&&!c.destroyed)?.grant(); }
}
class Client extends EventEmitter implements LeaderConnection {
  destroyed=false; waiting=false; statements:string[]=[]; grants=0;
  private resolve?:()=>void; private reject?:(error:Error)=>void;
  constructor(readonly lock:Ownership) { super(); }
  async query<Row>(sql:string):Promise<{rows:Row[]}> {
    this.statements.push(sql);
    if(this.destroyed) throw new Error('closed');
    if(sql.includes('pg_advisory_lock')) {
      this.waiting=true;
      await new Promise<void>((resolve,reject)=>{this.resolve=resolve;this.reject=reject;this.lock.advance();});
    }
    return {rows:[]};
  }
  grant(){ this.waiting=false;this.lock.owner=this;this.grants++;this.resolve?.(); }
  release=vi.fn(()=>{
    if(this.destroyed)return;this.destroyed=true;this.waiting=false;this.reject?.(new Error('closed'));
    if(this.lock.owner===this)this.lock.owner=undefined;this.lock.advance();
  });
  lose(){ this.emit('error',new Error('connection lost'));this.release(); }
}
afterEach(()=>vi.useRealTimers());
describe('source and deadline owned background leadership',()=>{
  it('runs one acquisition pass and owns zero health queries or timers through an idle day',async()=>{
    vi.useFakeTimers();const lock=new Ownership(),cycle=vi.fn(async()=>Infinity);
    const leader=new BackgroundLeader({connectDedicated:lock.connect},cycle);void leader.run();await settle();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(cycle).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    expect(lock.clients[0]!.statements).toEqual(['SET statement_timeout=0; SET lock_timeout=60000','SELECT pg_advisory_lock($1)']);
    leader.wake();await settle();expect(cycle).toHaveBeenCalledTimes(2);expect(cycle).toHaveBeenLastCalledWith(false, expect.any(AbortSignal));
    await leader.stop();expect(lock.clients[0]!.release).toHaveBeenCalledOnce();
  });
  it('waits once in PostgreSQL and transfers ownership on the actual connection release',async()=>{
    vi.useFakeTimers();const lock=new Ownership(),a=vi.fn(async()=>Infinity),b=vi.fn(async()=>Infinity);
    const first=new BackgroundLeader({connectDedicated:lock.connect},a),second=new BackgroundLeader({connectDedicated:lock.connect},b);
    void first.run();await settle();void second.run();await settle();
    await vi.advanceTimersByTimeAsync(86_400_000);expect(a).toHaveBeenCalledOnce();expect(b).not.toHaveBeenCalled();
    expect(lock.clients).toHaveLength(2);expect(lock.clients[1]!.statements).toHaveLength(2);
    await first.stop();await settle();expect(b).toHaveBeenCalledOnce();expect(b).toHaveBeenLastCalledWith(true, expect.any(AbortSignal));await second.stop();
  });
  it('parks a failed acquisition until a real recovery',async()=>{
    vi.useFakeTimers();const lock=new Ownership();let recover!:()=>void;const stop=vi.fn();
    const connect=vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(lock.connect);
    const cycle=vi.fn(async()=>Infinity),leader=new BackgroundLeader({connectDedicated:connect,onRecovery:fn=>{recover=fn;return stop;}},cycle);
    void leader.run();await settle();await vi.advanceTimersByTimeAsync(86_400_000);expect(connect).toHaveBeenCalledOnce();
    recover();await settle();expect(connect).toHaveBeenCalledTimes(2);expect(cycle).toHaveBeenCalledOnce();
    await leader.stop();expect(stop).toHaveBeenCalledOnce();
  });
  it('attempts one replacement after connection loss and parks if that replacement fails',async()=>{
    vi.useFakeTimers();const lock=new Ownership();const connect=vi.fn().mockImplementationOnce(lock.connect).mockRejectedValue(new Error('offline'));
    const cycle=vi.fn(async()=>Infinity),leader=new BackgroundLeader({connectDedicated:connect},cycle);void leader.run();await settle();
    lock.clients[0]!.lose();await settle();await vi.advanceTimersByTimeAsync(86_400_000);
    expect(connect).toHaveBeenCalledTimes(2);expect(cycle).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);await leader.stop();
  });
  it('does not replenish replacement admission before the new owner finishes recovery', async () => {
    vi.useFakeTimers();
    const lock = new Ownership();
    let finish!: () => void;
    const recovery = new Promise<void>(resolve => { finish = resolve; });
    let recovered!: () => void;
    const cycle = vi.fn().mockResolvedValueOnce(Infinity).mockImplementationOnce(() => recovery).mockResolvedValue(Infinity);
    const leader = new BackgroundLeader({ connectDedicated: lock.connect,
      onRecovery: listener => { recovered = listener; return () => {}; } }, cycle);
    void leader.run();
    await settle();
    lock.clients[0]!.lose();
    lock.clients[0]!.emit('end');
    await settle();
    expect(lock.clients).toHaveLength(2);
    lock.clients[1]!.lose();
    finish();
    await settle();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(lock.clients).toHaveLength(2);
    expect(cycle).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    recovered();
    await settle();
    expect(lock.clients).toHaveLength(3);
    // Completed initial work restores admission for a later incident.
    lock.clients[2]!.lose();
    await settle();
    expect(lock.clients).toHaveLength(4);
    await leader.stop();
  });

  it('runs an actual deadline once, retains a committed wake received in flight, and then parks',async()=>{
    vi.useFakeTimers();const lock=new Ownership();let leader:BackgroundLeader;
    const cycle=vi.fn().mockResolvedValueOnce(5000).mockImplementationOnce(async()=>{leader.wake();return Infinity;}).mockResolvedValue(Infinity);
    leader=new BackgroundLeader({connectDedicated:lock.connect},cycle);void leader.run();await settle();
    await vi.advanceTimersByTimeAsync(4999);expect(cycle).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(1);
    expect(cycle).toHaveBeenCalledTimes(3);expect(vi.getTimerCount()).toBe(0);await leader.stop();
  });
  it('destroys blocked acquisition on stop, while an active business cycle drains first',async()=>{
    const lock=new Ownership();let finish!:()=>void;const work=new Promise<void>(resolve=>{finish=resolve;});
    const first=new BackgroundLeader({connectDedicated:lock.connect},()=>work),standby=new BackgroundLeader({connectDedicated:lock.connect},vi.fn());
    void first.run();await settle();void standby.run();await settle();await standby.stop();
    expect(lock.clients[1]!.destroyed).toBe(true);const stopped=first.stop();await settle();expect(lock.clients[0]!.destroyed).toBe(false);
    finish();await stopped;expect(lock.clients[0]!.destroyed).toBe(true);
  });
  it('does not run a far future obligation at the host timer maximum',async()=>{
    vi.useFakeTimers();const lock=new Ownership();const cycle=vi.fn().mockResolvedValueOnce(3_000_000_000).mockResolvedValue(Infinity);
    const leader=new BackgroundLeader({connectDedicated:lock.connect},cycle);void leader.run();await settle();
    await vi.advanceTimersByTimeAsync(2_147_483_647);expect(cycle).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(852_516_353);expect(cycle).toHaveBeenCalledTimes(2);await leader.stop();
  });
  it('aborts a lost owner before draining its active cycle',async()=>{
    const lock=new Ownership();let finish!:()=>void;let signal!:AbortSignal;
    const work=new Promise<void>(resolve=>{finish=resolve;});
    const cycle=vi.fn().mockImplementationOnce((_fresh:boolean,current:AbortSignal)=>{signal=current;return work;}).mockResolvedValue(Infinity);
    const leader=new BackgroundLeader({connectDedicated:lock.connect},cycle);
    void leader.run();await settle();expect(signal.aborted).toBe(false);
    lock.clients[0]!.lose();expect(signal.aborted).toBe(true);
    await settle();expect(cycle).toHaveBeenCalledOnce();
    finish();await settle();expect(cycle).toHaveBeenCalledTimes(2);
    await leader.stop();
  });
});
