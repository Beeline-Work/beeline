import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeTimeline } from './timeline-summary.mjs';

test('timeline output preserves missing observations and computes medians from server timestamps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-timeline-summary-'));
  try {
    const mention = '2026-10-16T12:00:00.000Z';
    const rows = [1000, 5000, 3000].map((ms, index) => ({
      sample: index + 1,
      mode: 'resume',
      mention,
      events: [],
      commands: [],
      marks: [],
      flyEvents: [],
      reply: { created_at: new Date(Date.parse(mention) + ms).toISOString() },
    }));
    await writeFile(join(root, 'results.json'), JSON.stringify(rows));
    for (const row of rows) await writeFile(join(root, `${row.sample}-resume-helper.log`), '');
    const result = await summarizeTimeline(root);
    assert.equal(result.summaries.resume.samples, 3);
    assert.equal(result.summaries.resume.timeline.reply, 3000);
    assert.equal(result.summaries.resume.timeline.sessionReady, null);
    assert.equal(result.summaries.resume.observations.sessionReady, 0);
    assert.equal(result.summaries.resume.segments.modelFirstByte, null);
    assert.equal(result.summaries.resume.segments.wakeToFlyAccepted, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
