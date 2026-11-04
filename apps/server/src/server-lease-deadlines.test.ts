import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from './database.js';
import { ServerLeaseDeadlines } from './server-lease-deadlines.js';

const database=(rows:readonly {instance_id:string;renewed_at:Date}[]=[])=>({
  query:vi.fn(async()=>({rows,rowCount:rows.length})),transaction:vi.fn(),
});
afterEach(()=>vi.useRealTimers());
describe('server lease deadlines: private owner evidence',()=>{
  it('has no repeating scan and renewals replace one actual expiry without SQL',async()=>{
    vi.useFakeTimers();vi.setSystemTime(0);
    const db=database([{instance_id:'peer',renewed_at:new Date(0)}]),expire=vi.fn(async()=>{});
    const deadlines=new ServerLeaseDeadlines(db as unknown as SqlDatabase,90_000,expire,vi.fn());
    try{
      expect(vi.getTimerCount()).toBe(0);expect(db.query).not.toHaveBeenCalled();
      await deadlines.recover();expect(db.query).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);deadlines.observe('peer',Date.now());
      await vi.advanceTimersByTimeAsync(30_000);deadlines.observe('peer',Date.now());
      await vi.advanceTimersByTimeAsync(89_999);expect(expire).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);expect(expire).toHaveBeenCalledOnce();
      expect(db.query).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
      deadlines.observe('peer',60_000);expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(3600_000);expect(expire).toHaveBeenCalledOnce();
    }finally{await deadlines.stop();}
  });
  it('deduplicates old evidence, coalesces simultaneous expiries and forgets removed owners',async()=>{
    vi.useFakeTimers();vi.setSystemTime(0);
    const db=database(),expire=vi.fn(async()=>{});
    const deadlines=new ServerLeaseDeadlines(db as unknown as SqlDatabase,90_000,expire,vi.fn());
    try{
      deadlines.observe('a',30_000);deadlines.observe('a',0);deadlines.observe('b',30_000);
      deadlines.observe('removed',0);deadlines.observe('removed',0,true);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(119_999);expect(expire).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);expect(expire).toHaveBeenCalledOnce();
      expect(db.query).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    }finally{await deadlines.stop();}
  });
  it('parks a failed actual expiry without manufacturing a retry deadline',async()=>{
    vi.useFakeTimers();vi.setSystemTime(0);
    const error=new Error('database unavailable'),report=vi.fn(),expire=vi.fn().mockRejectedValue(error);
    const deadlines=new ServerLeaseDeadlines(database() as unknown as SqlDatabase,90_000,expire,report);
    try{
      deadlines.observe('peer',0);await vi.advanceTimersByTimeAsync(90_000);
      expect(report).toHaveBeenCalledWith(error);expect(expire).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(3600_000);expect(expire).toHaveBeenCalledOnce();
    }finally{await deadlines.stop();}
  });
});
