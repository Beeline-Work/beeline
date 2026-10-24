import { readFile, writeFile } from 'node:fs/promises';
import { percentile } from './metrics.mjs';
const [androidPath, webPath, desktopPath, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: report.mjs android.json web.json desktop.json report.md');
const runs = await Promise.all([androidPath, webPath, desktopPath].map(async path => JSON.parse(await readFile(path, 'utf8'))));
const n = value => value == null ? '—' : Number(value).toFixed(1);
let markdown = '# Transcript measurement results\n\n';
markdown += 'JS columns pool recorded requestAnimationFrame intervals. UI columns are medians of per-trial Android HWUI percentile estimates; they are not pooled quantiles. Janky frames and missed JS opportunities measure different things. These runs do not establish physical-device performance.\n\n';
for (const [i, name] of ['Android release emulator', 'Narrow production web', 'Packaged Tauri'].entries()) {
  const run = runs[i];
  markdown += `## ${name}\n\n| Scenario | Trials | JS interval p50 / p95 ms | UI frame p50 / p95 ms | Median transcript / row commits | Missed JS opportunities |\n| --- | ---: | ---: | ---: | ---: | ---: |\n`;
  for (const scenario of [...new Set(run.samples.map(sample => sample.scenario))]) {
    const samples = run.samples.filter(sample => sample.scenario === scenario);
    const frames = samples.flatMap(sample => sample.raw.jsFrameIntervalsMs);
    const ui = samples.filter(sample => sample.uiFrames?.count > 0);
    markdown += `| ${scenario} | ${samples.length} | ${n(percentile(frames, .5))} / ${n(percentile(frames, .95))} | ${n(percentile(ui.map(sample => sample.uiFrames.p50Ms), .5))} / ${n(percentile(ui.map(sample => sample.uiFrames.p95Ms), .5))} | ${n(percentile(samples.map(sample => sample.transcriptCommits), .5))} / ${n(percentile(samples.map(sample => sample.rowCommits), .5))} | ${samples.reduce((sum, sample) => sum + sample.missedJsFrameOpportunities, 0)} |\n`;
  }
  markdown += `\nRuntime: ${run.runtime ?? 'see raw capture'}. Refresh: ${run.refreshHz} Hz. Overhead: ${run.profilingOverhead}.\n\n`;
  const metadata = run.samples.find(sample => sample.raw.build)?.raw.build;
  if (metadata) markdown += `Embedded build metadata: \`${JSON.stringify(metadata)}\`.\n\n`;
}
markdown += '## Native iOS\n\n| Status | Dependency |\n| --- | --- |\n| Pending | Owner approval of BrowserStack Appium host metadata edit |\n';
await writeFile(output, markdown);
