/** Attribute separate diagnostic captures to the exact installed Hermes bundle. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const { SourceMapConsumer } = require('source-map');
const { createContext } = require('metro-symbolicate/private/Symbolication');
const directory = process.argv[2];
if (!directory || !process.env.TRANSCRIPT_APK) throw new Error('Supply capture directory and TRANSCRIPT_APK');
const build = process.env.TRANSCRIPT_MAP_DIRECTORY ?? 'apps/mobile/android/app/build/generated';
const digest = value => createHash('sha256').update(value).digest('hex');
const bytecode = readFileSync(`${build}/assets/react/release/index.android.bundle`);
const installed = execFileSync('unzip', ['-p', process.env.TRANSCRIPT_APK, 'assets/index.android.bundle'], { maxBuffer: 64e6 });
if (digest(bytecode) !== digest(installed)) throw new Error('Source-map bytecode differs from APK');
const map = readFileSync(`${build}/sourcemaps/react/release/index.android.bundle.map`, 'utf8');
const context = createContext(SourceMapConsumer, map, {
  nameSource: 'function_names', inputLineStart: 1, inputColumnStart: 0, outputLineStart: 1, outputColumnStart: 0,
});
const capture = JSON.parse(readFileSync(`${directory}/capture.json`, 'utf8'));
if (!capture.scenarioOptions?.profileRows) throw new Error('Diagnostic row-profile capture required');
if (capture.apkSha256 !== digest(readFileSync(process.env.TRANSCRIPT_APK))) throw new Error('Capture APK differs');
const rank = counts => [...counts].sort((a, b) => b[1] - a[1]).map(([frame, samples]) => ({ frame, samples }));
const summaries = [];
for (const file of readdirSync(directory).filter(name => /^profile-.+-\d+\.json$/.test(name)).sort()) {
  const [, scenario, repeatText] = file.match(/^profile-(.+)-(\d+)\.json$/);
  const sample = capture.samples.filter(value => value.scenario === scenario)[Number(repeatText)];
  if (!sample) throw new Error(`Missing frame sample for ${file}`);
  const trace = JSON.parse(readFileSync(`${directory}/${file}`, 'utf8'));
  for (const frame of Object.values(trace.stackFrames)) {
    if (frame.funcVirtAddr != null && frame.offset != null) {
      const position = context.getOriginalPositionDetailsFor(1, Number(frame.funcVirtAddr) + Number(frame.offset));
      frame.original = { source: position.source, line: position.line, column: position.column, functionName: position.functionName };
    }
  }
  const inclusive = new Map(), nearestProduct = new Map();
  let selectedSamples = 0, rootOnly = 0;
  for (const tick of trace.samples) {
    const milliseconds = Number(tick.ts) / 1000;
    if (milliseconds < sample.raw.startMs || milliseconds > sample.raw.endMs) continue;
    selectedSamples++;
    const stack = [];
    for (let id = String(tick.sf); trace.stackFrames[id]; id = String(trace.stackFrames[id].parent)) stack.push(trace.stackFrames[id]);
    if (stack.length === 1) rootOnly++;
    const label = frame => frame.original?.source
      ? `${frame.original.functionName || frame.name} (${frame.original.source}:${frame.original.line})` : frame.name;
    for (const name of new Set(stack.map(label))) inclusive.set(name, (inclusive.get(name) ?? 0) + 1);
    const product = stack.find(frame => frame.original?.source?.startsWith('/sources/'));
    if (product) nearestProduct.set(label(product), (nearestProduct.get(label(product)) ?? 0) + 1);
  }
  if (!selectedSamples) throw new Error(`No Hermes samples overlap the frame window: ${file}`);
  summaries.push({ file, scenario, repeat: Number(repeatText), startMs: sample.raw.startMs, endMs: sample.raw.endMs,
    selectedSamples, rootOnly, inclusiveStacks: rank(inclusive), nearestProductStacks: rank(nearestProduct) });
  writeFileSync(`${directory}/${file.replace('.json', '-symbolicated.json')}`, JSON.stringify(trace));
}
if (!summaries.length) throw new Error('No row profiles found');
writeFileSync(`${directory}/profile-summary.json`, JSON.stringify({ bytecodeSha256: digest(bytecode), sourceMapSha256: digest(map),
  note: 'Separate diagnostic runs, never acceptance timing. Counts are sampled stacks, not invocation counts or additive CPU time. Samples are restricted to each JS measurement window; native frame percentiles from this profiled run do not qualify as acceptance evidence.',
  summaries }, null, 2));
console.log(JSON.stringify(summaries.map(({ scenario, selectedSamples, rootOnly, nearestProductStacks }) =>
  ({ scenario, selectedSamples, rootOnly, nearestProductStacks: nearestProductStacks.slice(0, 15) })), null, 2));
