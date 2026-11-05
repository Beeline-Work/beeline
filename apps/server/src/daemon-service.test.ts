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
