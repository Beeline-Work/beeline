import test from 'node:test';
import assert from 'node:assert/strict';
import { isKeyboardShown, requireRoomList } from './capture-ui.mjs';
test('system keyboard visibility takes precedence over a retained IME view', () => {
  assert.equal(isKeyboardShown('mInputShown=false\n mIsInputViewShown=true mStatusIcon=0'), false);
  assert.equal(isKeyboardShown('mInputShown=true\n mIsInputViewShown=false'), true);
  assert.equal(isKeyboardShown('mInputShown=false'), false);
  assert.equal(isKeyboardShown('mInputShown=true'), true);
  assert.equal(isKeyboardShown('mIsInputViewShown=true'), true);
  assert.equal(isKeyboardShown('mIsInputViewShown=false'), false);
});
const list = '<node content-desc="Latency Rig 200 — switch Workspace" bounds="[0,0][200,10]"/><node content-desc="all conversations" bounds="[0,10][100,30]"/><node text="#Rig room 001" bounds="[20,50][180,80]"/>';
test('a signed-out screen or a covering Workspace overlay cannot become a timing sample', () => {
  assert.throws(() => requireRoomList('<node text="Continue with GitHub" bounds="[0,0][100,100]"/>'), /sign in/);
  assert.throws(() => requireRoomList(list + '<node content-desc="Close Workspace switcher" bounds="[10,0][200,800]"/>'), /overlay/);
  assert.deepEqual(requireRoomList(list), [100, 65]);
  assert.throws(() => requireRoomList(list.replace('Latency Rig 200', 'Latency Rig 1')), /Latency Rig 200/);
});

import m47_test from 'node:test';

import m47_assert from 'node:assert/strict';

import { waitForReactionChip as m47_waitForReactionChip } from "./capture-ui.mjs";
import { describe as mergedDescribe47 } from 'node:test';
mergedDescribe47("nightly-reaction.test.mjs", () => {


const hierarchy = (target, count, bounds = '[64,1986][196,2060]') =>
  `<hierarchy><node resource-id="reaction-chip-${target}-&#128077;" content-desc="&#x1f44d;, ${count} reaction${count === 1 ? '' : 's'}" bounds="${bounds}" /></hierarchy>`;


m47_test('reaction setup waits past the previous two-reaction tail for the fresh fixture', async () => {
  // The failed emulator hierarchy contained the preceding completed sample's
  // chip, while the newly inserted target was not yet in the viewport.
  const snapshots = [hierarchy('previous', 2), hierarchy('previous', 2), hierarchy('fresh', 1)];
  const waits = [];
  m47_assert.deepEqual(await m47_waitForReactionChip(async () => snapshots.shift(), 'fresh',
    'react-message setup (sample 17/20)', { wait: async ms => waits.push(ms) }), [130, 2023]);
  m47_assert.deepEqual(waits, [1500, 1500]);
});


m47_test('the correct one-reaction fixture adds no setup delay', async () => {
  m47_assert.deepEqual(await m47_waitForReactionChip(async () => hierarchy('fresh', 1), 'fresh', 'reaction', {
    wait: async () => m47_assert.fail('already ready'),
  }), [130, 2023]);
});


m47_test('wrong, already completed, or invisible chips fail with their sample after bounded readiness checks', async () => {
  for (const xml of [hierarchy('wrong', 1), hierarchy('fresh', 2), hierarchy('fresh', 1, '[0,0][0,0]')]) {
    let dumps = 0;
    const waits = [];
    await m47_assert.rejects(m47_waitForReactionChip(async () => { dumps++; return xml; }, 'fresh',
      'react-message setup (sample 17/20)', { wait: async ms => waits.push(ms) }),
    /react-message setup \(sample 17\/20\).*three hierarchies/);
    m47_assert.equal(dumps, 3);
    m47_assert.deepEqual(waits, [1500, 1500]);
  }
});
});
