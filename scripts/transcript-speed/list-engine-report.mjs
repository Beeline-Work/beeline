/** Compare alternating complete suites without converting missing evidence to zero. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { percentile, historyPageProved } from './metrics.mjs';
const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error('Usage: list-engine-report.mjs capture-root output.md');
const engines = ['flatlist', 'flashlist', 'legendlist'];
const scenarios = ['keystroke', 'scroll', 'fling', 'history-prepend', 'incoming', 'concurrent-streams', 'optimistic-send', 'warm-room-switches'];
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const observedFailures = existsSync(path.join(root, 'observed-failures.json')) ? read(path.join(root, 'observed-failures.json')) : [];
const fmt = value => value === null || value === undefined ? 'unmeasured' : value.toFixed(2);
const spread = values => values.length ? `${fmt(percentile(values, .5))}; ${fmt(Math.min(...values))}–${fmt(Math.max(...values))}` : 'unmeasured';
const pss = text => Number(text?.match(/TOTAL PSS:\s*(\d+)/)?.[1] ?? text?.match(/^\s*TOTAL\s+(\d+)/m)?.[1]) / 1024;
let fingerprint;
const lines = ['# List engine measurements', '',
  'Three alternating blocks per engine/platform. Each cell is parenthesized. JS values are animation-frame intervals, not execution times. HWUI jank is not a count of physically dropped frames. Open and memory cells show median; minimum–maximum.', ''];
for (const platform of ['android', 'web']) {
  lines.push(`## ${platform}`, '', '| Engine | Flow status | JS p50 / p95, ms | Worst JS gap, ms | Missed JS opportunities | HWUI janky / rendered; missed vsync | Warm open settled, ms | Memory, MiB |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  const collected = new Map();
  for (const engine of engines) {
    const trials = Array.from({ length: 3 }, (_, block) => {
      const lane = path.join(root, platform, `block-${block}-${engine}`);
      const record = read(path.join(lane, 'scenarios/capture.json'));
      if (!record.completed) throw new Error(`Incomplete ${lane}`);
      fingerprint ??= record.fixtureFingerprint;
      if (record.fixtureFingerprint !== fingerprint) throw new Error('Different fixture fingerprints');
      for (const scenario of scenarios)
        if (!record.samples.some(sample => sample.scenario === scenario)) throw new Error(`Missing ${scenario}: ${lane}`);
      for (const sample of record.samples)
        if (sample.raw.build.listEngine !== engine) throw new Error(`Wrong engine: ${lane}`);
      const opens = read(path.join(lane, 'opens/capture.json'));
      if (opens.samples.length !== 3 || opens.samples.some(sample => sample.timedOut || (sample.settledMs ?? sample.settledUpperBoundMs) == null))
        throw new Error(`Incomplete open proof: ${lane}`);
      return { record, opens };
    });
    const samples = trials.flatMap(trial => trial.record.samples);
    const intervals = samples.flatMap(sample => sample.raw.jsFrameIntervalsMs);
    const missed = samples.reduce((sum, sample) => sum + sample.missedJsFrameOpportunities, 0);
    const missedVsync = samples.every(sample => Number.isFinite(sample.uiFrames?.missedVsync))
      ? samples.reduce((sum, sample) => sum + sample.uiFrames.missedVsync, 0) : null;
    const ui = platform === 'android' && samples.every(sample => Number.isFinite(sample.uiFrames?.jankyFrames) && Number.isFinite(sample.uiFrames?.count))
      ? `${samples.reduce((sum, sample) => sum + sample.uiFrames.jankyFrames, 0)} / ${samples.reduce((sum, sample) => sum + sample.uiFrames.count, 0)}; ${fmt(missedVsync)}` : 'unmeasured';
    const warm = trials.flatMap(trial => trial.opens.samples.filter(sample => sample.variant === 'warm').map(sample => sample.settledMs ?? sample.settledUpperBoundMs));
    const memory = trials.map(trial => platform === 'android'
      ? pss(trial.record.samples.find(sample => sample.scenario === 'warm-room-switches').memory.after)
      : trial.record.memoryAfterCapture / 1024 / 1024);
    if (memory.some(value => !Number.isFinite(value))) throw new Error('Missing memory measurement');
    const failures = [...new Set(trials.flatMap(trial => [
      ...(trial.record.pathFailures ?? []).map(failure => failure.scenario),
      ...trial.record.samples.filter(sample => sample.scenario === 'history-prepend' &&
        !historyPageProved(sample.history?.oldestBefore, sample.history?.oldestAfter)).map(() => 'history-prepend'),
      ...trial.record.samples.filter(sample => sample.scenario === 'optimistic-send' && sample.serverSettled !== true).map(() => 'settled-send'),
      ...trial.record.samples.filter(sample => platform === 'web' && sample.scenario === 'scroll' && sample.scrollChanged !== true).map(() => 'scroll'),
    ]))];
    failures.push(...observedFailures.filter(failure => failure.platform === platform && failure.engine === engine).map(failure => failure.scenario));
    const visual = read(path.join(root, platform, `visual-${engine}/samples.json`));
    if (visual.samples.length !== 8) throw new Error('Incomplete visual sample set');
    if (platform === 'web') {
      if (visual.build?.listEngine !== engine || visual.visiblePath?.length !== 3) throw new Error('Incomplete visible-path proof');
      failures.push(...visual.visiblePath.filter(result => !result.passed).map(result => result.scenario));
    } else if (visual.apkSha256 !== trials[0].record.apkSha256) throw new Error('Visual audit APK differs from timing APK');
    lines.push(`| ${engine} | ${failures.length ? `FAIL: ${[...new Set(failures)].join(', ')}` : 'Harness passed'} | (${fmt(percentile(intervals, .5))} / ${fmt(percentile(intervals, .95))}) | (${fmt(Math.max(...intervals))}) | (${missed}) | (${ui}) | (${spread(warm)}) | (${spread(memory)}) |`);
    collected.set(engine, { trials, samples });
  }
  lines.push('', platform === 'android' ? 'Memory is app process PSS after the repeated Room-switch scenario.' : 'Memory is Chrome JS heap used after capture; this is not browser process PSS.', '',
    '| Scenario | Engine | Trial JS p95 median; min–max, ms | Worst gap median; min–max, ms | Row commits median; min–max |', '| --- | --- | ---: | ---: | ---: |');
  for (const scenario of scenarios) for (const engine of engines) {
    const matching = collected.get(engine).samples.filter(sample => sample.scenario === scenario);
    lines.push(`| ${scenario} | ${engine} | (${spread(matching.map(sample => sample.jsFrameIntervalP95Ms))}) | (${spread(matching.map(sample => sample.jsFrameIntervalMaxMs))}) | (${spread(matching.map(sample => sample.rowCommits))}) |`);
  }
  lines.push('', '| Engine | Cold process settled, ms | Cache miss settled, ms |', '| --- | ---: | ---: |');
  for (const engine of engines) {
    const opens = collected.get(engine).trials.flatMap(trial => trial.opens.samples);
    const values = variant => opens.filter(sample => sample.variant.startsWith(variant)).map(sample => sample.settledMs ?? sample.settledUpperBoundMs);
    lines.push(`| ${engine} | (${spread(values('cold-process'))}) | (${spread(values('cache-miss'))}) |`);
  }
  lines.push('');
}
writeFileSync(output, `${lines.join('\n').trimEnd()}\n`);
