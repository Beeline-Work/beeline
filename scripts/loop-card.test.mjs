import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildLoopCard } from './loop-card.mjs';
import { validateSavedWorkflow } from '../packages/api-contract/src/workflow-contracts.ts';
const sha = 'a'.repeat(40);
const tuple = n => ({key:`upload/${n}`,sourceSha:sha,problem:`Upload ${n} fails`,consequence:'Work is lost',fix:'Retain the draft',confidence:'high',openQuestion:false,evidence:'https://example.com/evidence'});
const input = tuples => ({kind:'morning',date:'2026-11-05',sourceSha:sha,releaseLine:'Release: no-op · v1 · '+sha,tuples});
test('all one-, two- and three-fix cards validate; every approval dispatches only its tuple then removes it', () => {
  for (let n=1;n<=3;n++) {
    const result = buildLoopCard(input(Array.from({length:n},(_,i)=>tuple(i+1))));
    assert.equal(validateSavedWorkflow(result.contract),null);
    assert.deepEqual(buildLoopCard(input(Array.from({length:n},(_,i)=>tuple(i+1)))),result);
    for (const state of Object.values(result.contract.handoffs)) {
      if(state.kind!=='gate') continue;
      assert.equal(state.default,'skip'); assert.equal(state.on.skip,'done');
      for(const [choice,target] of Object.entries(state.on)) {
        if(choice==='skip') continue;
        const dispatch = result.contract.handoffs[target];
        assert.match(dispatch.hint,new RegExp(`upload/${choice.split('_')[1]}`));
        const next = result.contract.handoffs[dispatch.on.opened];
        assert.ok(next.kind==='terminal' || !next.on[choice]);
        assert.equal(dispatch.on.timeout,'failed');
      }
    }
  }
});
test('uncertain findings get no approval and deferred tuples remain unreported', () => {
  const result=buildLoopCard(input([tuple(1),{...tuple(2),openQuestion:true},tuple(3),tuple(4)]));
  assert.match(result.text,/OPEN QUESTION/);
  assert.deepEqual(result.deferredKeys,['upload/4']);
  assert.deepEqual(result.presentedKeys,['upload/1','upload/2','upload/3']);
  const gate=result.contract.handoffs[result.contract.start];
  assert.deepEqual(Object.keys(gate.on),['approve_1','approve_3','skip']);
  assert.equal(validateSavedWorkflow(result.contract),null);
  assert.equal(buildLoopCard(input([{...tuple(1),openQuestion:true}])).contract,null);
});
test('empty, stale, duplicate, missing evidence and oversized inputs cannot create misleading cards', () => {
  assert.equal(buildLoopCard(input([])).contract,null);
  assert.match(buildLoopCard(input([])).text,/Nothing found\./);
  assert.throws(()=>buildLoopCard(input([{...tuple(1),sourceSha:'b'.repeat(40)}])),/stale/);
  assert.throws(()=>buildLoopCard(input([tuple(1),tuple(1)])),/duplicate/);
  assert.throws(()=>buildLoopCard(input([{...tuple(1),evidence:''}])),/evidence/);
  assert.throws(()=>buildLoopCard(input([{...tuple(1),problem:'x'.repeat(100),fix:'x'.repeat(100)}])),/one screen/);
});
test('all loop procedures retain the common gates and delegate the two existing methods', () => {
  const slugs=['release-nightly','overnight-ci','overnight-codebase-health','overnight-errors','overnight-latency','morning-card','insight-loss','insight-workspace-walk'];
  for(const slug of slugs) {
    const source=readFileSync(`docs/loops/${slug}.md`,'utf8');
    for(const heading of ['1. Freshness gate','2. Fixed questions','3. Problem → fix output','4. Dedupe and handoff','5. Empty result']) assert.ok(source.includes(heading),`${slug}: ${heading}`);
    assert.match(source,/OPEN QUESTION/); assert.match(source,/Nothing found/);
  }
  assert.match(readFileSync('docs/loops/overnight-codebase-health.md','utf8'),/Call the existing `untangle-codebase` skill/);
  assert.match(readFileSync('docs/loops/overnight-errors.md','utf8'),/Call the existing `beeline-triage` skill/);
});
