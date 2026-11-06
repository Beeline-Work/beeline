import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { initializeRelease, productionReleaseDecision, nativeFingerprintsChanged, planOutputs, restoreReleasePlan } from './unified-release.mjs';

const oldSha = 'a'.repeat(40), nextSha = 'b'.repeat(40);
const previous = () => {
  const state = initializeRelease({ version: 'v0.1.1', sourceSha: oldSha });
  state.state = 'delivered';
  Object.values(state.components).forEach(c => { c.state = 'checked'; });
  return state;
};

test('same released SHA is a no-op even with carried components', () => {
  const release = previous();
  release.components['mobile-native'].state = 'carried';
  assert.deepEqual(productionReleaseDecision({ previous: release, sourceSha: oldSha }),
    { kind: 'no-op', storeTrack: 'none', selectedComponents: [], nativePlatforms: [] });
});

test('new SHA with unchanged native inputs ships OTA, server, helper and web only', () => {
  assert.deepEqual(productionReleaseDecision({ previous: previous(), sourceSha: nextSha, runtimePin: { changed: false } }),
    { kind: 'ota', storeTrack: 'none', selectedComponents: ['server','helper','mobile-ota','website'], nativePlatforms: ['android','ios'] });
});

test('either runtime or fingerprint change selects BOTH production stores', () => {
  for (const change of [{ runtimePin: { changed: true, changedPlatforms: ['android'] } }, { fingerprintsChanged: true }]) {
    const plan = productionReleaseDecision({ previous: previous(), sourceSha: nextSha, ...change });
    assert.equal(plan.kind, 'store');
    assert.equal(plan.storeTrack, 'production');
    assert.deepEqual(plan.nativePlatforms, ['android','ios']);
    assert.ok(plan.selectedComponents.includes('mobile-native'));
  }
});

test('explicit recovery and beta inputs keep their existing choices', () => {
  const plan = productionReleaseDecision({ previous: previous(), sourceSha: nextSha, fingerprintsChanged: true, selection: 'mobile-native', storeTrack: 'beta' });
  assert.equal(plan.storeTrack, 'beta');
  assert.deepEqual(plan.selectedComponents, ['mobile-native']);
});

test('fingerprint comparison rejects missing native evidence', () => {
  assert.throws(() => nativeFingerprintsChanged(previous(), nextSha, { gitShow: () => '{}' }), /missing native fingerprint/);
});

test('workflow plan command and job gates carry all three decisions end to end', () => {
  const root = mkdtempSync(join(tmpdir(), 'nightly-plan-'));
  const script = resolve('scripts/unified-release.mjs');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init','-q'); git('config','user.email','test@example.com'); git('config','user.name','Test');
    mkdirSync(join(root,'apps/mobile'), { recursive: true });
    const pin = { android:{runtimeVersion:'1'},ios:{runtimeVersion:'2'},fingerprints:{android:oldSha,ios:oldSha} };
    const save = () => writeFileSync(join(root,'apps/mobile/native-fingerprint.json'), JSON.stringify(pin));
    save(); git('add','.'); git('commit','-qm','baseline');
    const released = git('rev-parse','HEAD');
    const baseline = previous(); baseline.sourceSha = released;
    Object.values(baseline.components).forEach(c => { c.sourceSha = released; });
    // A carried native component must not turn the same-SHA branch into a supplemental release.
    baseline.components['mobile-native'].state = 'carried';
    baseline.components['mobile-native'].sourceSha = oldSha;
    writeFileSync(join(root,'previous.json'), JSON.stringify(baseline));
    for (const branch of ['no-op','ota','store-fingerprint','store-runtime']) {
      const kind = branch.startsWith('store-') ? 'store' : branch;
      if (kind === 'ota') { writeFileSync(join(root,'change.txt'),'new'); git('add','.'); git('commit','-qm','JS change'); }
      if (branch === 'store-fingerprint') { pin.fingerprints.ios=nextSha; save(); git('add','.'); git('commit','-qm','native fingerprint change'); }
      if (branch === 'store-runtime') { pin.fingerprints.ios=oldSha; pin.android.runtimeVersion='3'; save(); git('add','.'); git('commit','-qm','native runtime change'); }
      const sha = git('rev-parse','HEAD');
      execFileSync(process.execPath,[script,'plan','--sha',sha,'--version',kind==='no-op'?'v0.1.1':'v0.1.2','--previous',join(root,'previous.json'),'--state',join(root,'state.json'),'--outputs',join(root,`${branch}.txt`)],{cwd:root});
      const state = JSON.parse(readFileSync(join(root,'state.json'),'utf8'));
      const output = readFileSync(join(root,`${branch}.txt`),'utf8');
      assert.equal(state.plan.releaseKind,kind);
      const restored = restoreReleasePlan({version:state.version,sourceSha:sha,previous:baseline,
        plan:Object.fromEntries(planOutputs(state,baseline).trim().split('\n').map(line=>line.split('='))),startedAt:state.startedAt});
      if(kind!=='no-op') { assert.equal(restored.plan.releaseKind,kind); assert.equal(restored.plan.storeTrack,state.plan.storeTrack); }

      assert.match(output,new RegExp(`^no_op=${kind==='no-op'}$`,'m'));
      assert.match(output,new RegExp(`^run_mobile_native=${kind==='store'}$`,'m'));
      if(kind==='store') { assert.match(output,/^store_track=production$/m); assert.deepEqual(state.plan.nativePlatforms,['android','ios']); }
      if(kind==='no-op') for(const c of ['server','helper','mobile_ota','mobile_native','desktop','website']) assert.match(output,new RegExp(`^run_${c}=false$`,'m'));
    }
    const workflow = parse(readFileSync('.github/workflows/unified-release.yml','utf8'));
    for(const name of ['mobile_native_android','mobile_native_ios']) assert.match(workflow.jobs[name].if,/needs.initialize.outputs.store_track/);
    const ios = workflow.jobs.mobile_native_ios.steps;
    assert.equal(ios.find(s=>s.name==='Send production iOS version to App Review').if,"needs.initialize.outputs.store_track == 'production'");
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('the first routine release selects every component because nothing can be carried', () => {
  const plan=productionReleaseDecision({sourceSha:nextSha});
  assert.equal(plan.kind,'store'); assert.equal(plan.storeTrack,'production');
  assert.equal(plan.selectedComponents.length,6);
  assert.equal(initializeRelease({version:'v0.1.1',sourceSha:nextSha,selectedComponents:plan.selectedComponents}).state,'planned');
});
