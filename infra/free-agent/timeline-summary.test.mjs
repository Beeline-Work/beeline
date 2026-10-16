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


test('stopped restart keeps its wake timeline and session phase durations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-stopped-summary-'));
  try {
    const mention = '2026-10-16T12:00:00.000Z';
    await writeFile(join(root, 'results.json'), JSON.stringify([{
      sample: 1, mode: 'stopped-restart', mention,
      events: [{ kind: 'wake_requested', at: mention },
        { kind: 'connected', at: '2026-10-16T12:00:04.000Z' }],
      commands: [{ claimed_at: '2026-10-16T12:00:04.100Z' }],
      marks: [{ step: 'fly-start-accepted', at: '2026-10-16T12:00:01.000Z' }],
      flyEvents: [{ status: 'started', timestamp: Date.parse(mention) + 2000 }],
      reply: { created_at: '2026-10-16T12:00:10.000Z' },
    }]));
    await writeFile(join(root, '1-stopped-restart-helper.log'),
      '[body] session-start 2026-10-16T12:00:08.000Z room=room step=model-selection elapsedMs=3800 stepMs=10');
    const result = await summarizeTimeline(root);
    assert.equal(result.summaries['stopped-restart'].timeline.sessionReady, 8000);
    assert.equal(result.summaries['stopped-restart'].segments.helperStartup, 2000);
    assert.equal(result.details[0].sessionSteps[0].stepMs, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
