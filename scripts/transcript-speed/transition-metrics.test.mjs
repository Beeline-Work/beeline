import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transitionMetrics } from './transition-metrics.mjs';
const cpu=Array.from({length:151},(_,i)=>({epochMs:10000+i*10,runtimeNs:i*2e6}));
test('settling waits for paint and resets on a long gap inside the quiet window',()=>{
 const sample={startMs:0,endMs:1500,jsFrameIntervalsMs:[...Array(20).fill(10),200,...Array(109).fill(10)]};
 const r=transitionMetrics(sample,{startMs:10100,paintMs:10250},10000,cpu);
 assert.deepEqual(r.timeToSettledBoundsMs,[800,810]);
 assert.equal(r.worstJsGapMs,200);
 assert.ok(r.jsBusyCpuMs>150 && r.jsBusyCpuMs<170);
 assert.ok(r.jsBusyCpuBoundsMs[0]<=r.jsBusyCpuMs && r.jsBusyCpuBoundsMs[1]>=r.jsBusyCpuMs);
});
test('a long gap starting before quiet completion cannot be hidden behind its endpoint',()=>{
 const sample={startMs:0,endMs:1500,jsFrameIntervalsMs:[...Array(59).fill(10),200,...Array(70).fill(10)]};
 const r=transitionMetrics(sample,{startMs:10050,paintMs:10100},10000,cpu);
 assert.deepEqual(r.timeToSettledBoundsMs,[1240,1250]);
});
test('rejects missing CPU coverage, excessive alignment uncertainty and unsettled windows',()=>{
 const s={startMs:0,endMs:1000,jsFrameIntervalsMs:Array(99).fill(10)};
 assert.throws(()=>transitionMetrics(s,{startMs:10100,paintMs:10550},10000,cpu),/escaped/);
 assert.throws(()=>transitionMetrics({...s,endMs:1100},{startMs:10100,paintMs:10200},10000,cpu),/uncertainty/);
 assert.throws(()=>transitionMetrics(s,{startMs:10100,paintMs:10200},10000,[]),/CPU samples/);
});
