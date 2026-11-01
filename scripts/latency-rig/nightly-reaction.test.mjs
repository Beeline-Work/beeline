import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForReactionChip } from './capture-ui.mjs';

const hierarchy = (target, count, bounds = '[64,1986][196,2060]') =>
  `<hierarchy><node resource-id="reaction-chip-${target}-&#128077;" content-desc="&#x1f44d;, ${count} reaction${count === 1 ? '' : 's'}" bounds="${bounds}" /></hierarchy>`;

test('reaction setup waits past the previous two-reaction tail for the fresh fixture', async () => {
  // The failed emulator hierarchy contained the preceding completed sample's
  // chip, while the newly inserted target was not yet in the viewport.
  const snapshots = [hierarchy('previous', 2), hierarchy('previous', 2), hierarchy('fresh', 1)];
  const waits = [];
  assert.deepEqual(await waitForReactionChip(async () => snapshots.shift(), 'fresh',
    'react-message setup (sample 17/20)', { wait: async ms => waits.push(ms) }), [130, 2023]);
  assert.deepEqual(waits, [1500, 1500]);
});

test('the correct one-reaction fixture adds no setup delay', async () => {
  assert.deepEqual(await waitForReactionChip(async () => hierarchy('fresh', 1), 'fresh', 'reaction', {
    wait: async () => assert.fail('already ready'),
  }), [130, 2023]);
});

test('wrong, already completed, or invisible chips fail with their sample after bounded readiness checks', async () => {
  for (const xml of [hierarchy('wrong', 1), hierarchy('fresh', 2), hierarchy('fresh', 1, '[0,0][0,0]')]) {
    let dumps = 0;
    const waits = [];
    await assert.rejects(waitForReactionChip(async () => { dumps++; return xml; }, 'fresh',
      'react-message setup (sample 17/20)', { wait: async ms => waits.push(ms) }),
    /react-message setup \(sample 17\/20\).*three hierarchies/);
    assert.equal(dumps, 3);
    assert.deepEqual(waits, [1500, 1500]);
  }
});
