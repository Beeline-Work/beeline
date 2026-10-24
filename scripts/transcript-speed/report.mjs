import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { percentile } from './metrics.mjs';
const [androidDir, webDir, desktopDir, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: report.mjs android-suite-dir web-suite-dir desktop-suite-dir report.md');
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const format = value => value == null ? 'not measured' : Number(value).toFixed(1);
const required = ['scroll', 'fling', 'history-prepend', 'keystroke', 'incoming', 'concurrent-streams', 'optimistic-send', 'warm-room-switches'];
const costs = [];
let md = '# Transcript speed baseline\n\n';
md += 'Local fixture only, three trials per interaction and open variant; twenty-one individual keystrokes. Android is an emulator, web is a narrow production export, and desktop is the packaged Tauri binary. None establishes physical-phone performance.\n\n';
md += 'Frame intervals are pooled across trials. Android UI percentiles are the median of each trial’s HWUI histogram percentile, not pooled quantiles. HWUI jank and missed JavaScript animation opportunities are different measures. Browser animation callbacks observe main-thread/render scheduling together; separate compositor timings and physical scanout are not measured.\n\n';
for (const [index, directory] of [androidDir, webDir, desktopDir].entries()) {
  const run = await read(path.join(directory, 'scenarios/capture.json'));
  const opens = await read(path.join(directory, 'opens/capture.json'));
  const label = ['Android release emulator', 'Narrow production web', 'Packaged Tauri desktop'][index];
  for (const scenario of required) if (run.samples.filter(s => s.scenario === scenario).length < 3) throw new Error(`${label}: insufficient ${scenario} trials`);
  if (opens.samples.length !== 9 || opens.samples.some(s => s.timedOut || (s.firstFrameMarkerMs ?? s.firstVisibleUpperBoundMs) == null)) throw new Error(`${label}: missing Room-open proof`);
  md += `## ${label}\n\n`;
  md += `Runtime: ${run.runtime ?? 'see artifact metadata'}. Device: ${run.device}. Refresh: ${format(run.refreshHz)} Hz (${run.refreshMethod ?? run.display ?? 'Android display evidence in raw capture'}).\n\n`;
  const build = run.samples.find(s => s.raw?.build)?.raw.build;
  if(index===0) md += `Runtime probe: \`${JSON.stringify(run.samples.find(s=>s.raw.runtime)?.raw.runtime)}\`.\n\n`;
  md += `Embedded build: \`${JSON.stringify(build)}\`. Artifact SHA-256: \`${run.apkSha256 ?? run.artifactSha256 ?? 'see export manifest'}\`. Fixture: \`${run.fixtureFingerprint}\`.\n\n`;
  if (index > 0) {
    const overhead = await read(path.join(directory, 'overhead/capture.json'));
    md += `Sampling overhead, paired key-to-render upper bounds: inactive p50/p95 ${format(overhead.inactive.p50Ms)}/${format(overhead.inactive.p95Ms)} ms; active ${format(overhead.active.p50Ms)}/${format(overhead.active.p95Ms)} ms. ${overhead.method}\n\n`;
  } else {
    const active = await read(path.join(directory, 'keypaint/capture.json'));
    const inactive = await read(path.join(directory, 'overhead-inactive/capture.json'));
    const activeMs=active.samples.map(s=>s.latencyMs),inactiveMs=inactive.samples.map(s=>s.latencyMs);
    md += `Sampling overhead: sequential native keypaint trials, sampler inactive p50/p95 ${format(percentile(inactiveMs,.5))}/${format(percentile(inactiveMs,.95))} ms; active ${format(percentile(activeMs,.5))}/${format(percentile(activeMs,.95))} ms. Polling is suspended in both arms. Hooks remain installed in both builds; this measures incremental sampling cost, not total instrumentation overhead.\n\n`;
  }
  md += '| Scenario | Trials | JS/render interval p50 / p95 ms | UI frame p50 / p95 ms | UI janky / rendered frames | Median transcript / row commits | Missed JS opportunities |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n';
  for (const scenario of [...new Set(run.samples.map(s => s.scenario))]) {
    const samples = run.samples.filter(s => s.scenario === scenario);
    const frames = samples.flatMap(s => s.raw.jsFrameIntervalsMs);
    const ui = samples.filter(s => s.uiFrames?.count > 0);
    const p95 = percentile(frames, .95);
    const missed = samples.reduce((sum, s) => sum + s.missedJsFrameOpportunities, 0);
    const rowCommits = percentile(samples.map(s => s.rowCommits), .5);
    md += `| ${scenario} | ${samples.length} | ${format(percentile(frames, .5))} / ${format(p95)} | ${ui.length ? `${format(percentile(ui.map(s => s.uiFrames.p50Ms), .5))} / ${format(percentile(ui.map(s => s.uiFrames.p95Ms), .5))}` : 'not separately measured'} | ${ui.length ? `${ui.reduce((n,s)=>n+s.uiFrames.jankyFrames,0)} / ${ui.reduce((n,s)=>n+s.uiFrames.count,0)}` : 'not measured'} | ${format(percentile(samples.map(s=>s.transcriptCommits),.5))} / ${format(rowCommits)} | ${missed} |\n`;
    if (scenario !== 'idle') costs.push({ platform: label, scenario, p95Ms: p95, missedFraction: missed/(frames.length+missed), rowCommits });
  }
  md += '\n| Room open | Trials | First content p50 / p95 ms | Settled p50 / p95 ms |\n| --- | ---: | ---: | ---: |\n';
  for (const variant of [...new Set(opens.samples.map(s => s.variant))]) {
    const samples = opens.samples.filter(s=>s.variant===variant);
    const first = samples.map(s=>s.firstFrameMarkerMs ?? s.firstVisibleUpperBoundMs);
    const settled = samples.map(s=>s.settledMs ?? s.settledUpperBoundMs).filter(v=>v!=null);
    md += `| ${variant} | ${samples.length} | ${format(percentile(first,.5))} / ${format(percentile(first,.95))} | ${format(percentile(settled,.5))} / ${format(percentile(settled,.95))} |\n`;
  }
  md += `\n${opens.method} ${opens.settledMethod ?? ''} ${opens.coldDefinition ?? ''}\n\n`;
  let keys, keyMethod;
  if (index === 0) {
    const key = await read(path.join(directory,'keypaint/capture.json'));
    if (key.samples.some(s=>s.timedOut)) throw new Error('Native keypaint has timeouts');
    keys = key.samples.map(s=>s.latencyMs); keyMethod = key.method;
  } else {
    keys = run.samples.flatMap(s=>s.keyPaintUpperBounds ?? []).map(s=>s.duration);
    keyMethod = 'Trusted keydown handler to the second animation callback: rendering upper bound, excluding OS input dispatch and physical scanout. Chrome Event Timing is also retained where available.';
  }
  md += `Keystroke-to-frame: n=${keys.length}, p50=${format(percentile(keys,.5))} ms, p95=${format(percentile(keys,.95))} ms. ${keyMethod}\n\n`;
  md += '| Memory after Room switches | Before MiB | After MiB | Change MiB |\n| --- | ---: | ---: | ---: |\n';
  for (const [trial,s] of run.samples.filter(s=>s.scenario==='warm-room-switches').entries()) {
    let before,after,kind;
    if(index===0) {
      const pss = text => Number(text.match(/TOTAL PSS:\s+(\d+)/)?.[1] ?? text.match(/^\s*TOTAL\s+(\d+)/m)?.[1])/1024;
      before=pss(s.memory.before);after=pss(s.memory.after);kind='app PSS';
    } else if(index===1) {before=s.memory.beforeBytes/1048576;after=s.memory.afterBytes/1048576;kind='JS heap, no forced GC';}
    else {before=s.memory.before.totalPssKiB/1024;after=s.memory.after.totalPssKiB/1024;kind='app and descendant PSS';}
    md += `| Trial ${trial+1}, ${s.memory.switches ?? s.switches} switches, ${kind} | ${format(before)} | ${format(after)} | ${format(after-before)} |\n`;
  }
  md += '\nBlank area during fling: not instrumented; no zero-blank-area claim. Memory growth across this short experiment does not by itself prove a leak.\n\n';
}
md += '## Native iOS\n\n| Status | Dependency |\n| --- | --- |\n| Pending | Owner approval of BrowserStack host edit (01M5QSN2JGRMWXHK8G9M0HNW48); resume the single native run after approval. |\n\n';
md += '## Ranked measured costs\n\nThe ranking uses pooled animation-interval p95 within each platform. It identifies expensive scenarios; it does not assign CPU time to individual functions. Platform hardware and rendering backends differ, so do not read this as a device comparison.\n\n';
for(const platform of [...new Set(costs.map(c=>c.platform))]) {
  md += `### ${platform}\n\n| Rank | Scenario | p95 interval ms | Missed opportunities % | Median row commits |\n| --- | --- | ---: | ---: | ---: |\n`;
  costs.filter(c=>c.platform===platform).sort((a,b)=>b.p95Ms-a.p95Ms).slice(0,4).forEach((c,i)=>{md += `| ${i+1} | ${c.scenario} | ${format(c.p95Ms)} | ${format(c.missedFraction*100)} | ${format(c.rowCommits)} |\n`;});
  md += '\n';
}
md += '## Recommended remaining work\n\n1. **Step 2 — reduce redraw propagation.** Isolate composer state and stabilize row inputs; rerun per-keystroke and incoming-message commit counts on Android, preserving send settlement and follow behavior. Use these measured counts as the before baseline, not a promise of a particular speedup.\n2. **Step 3 — reduce row work.** Profile history insertion, send settlement, and concurrent streams to attribute the measured stalls to row types. Optimize markdown/code/card work only where the profile supports it, then compare this same fixture.\n3. **Step 4 — benchmark list engines.** Compare the existing list with candidates using fling, explicit history prepend, landing/follow, and memory trials. Add blank-area instrumentation before choosing a replacement.\n4. **Step 5 — address remaining startup and memory cost.** Use cold/warm/cache-miss splits and repeated switches to choose the next target. Confirm memory growth with longer runs and GC-aware analysis before calling it a leak.\n';
await writeFile(output, md);
await writeFile(output.replace(/\.md$/, '.json'), JSON.stringify({ costs }, null, 2));
