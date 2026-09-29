// Scene-list sanity check: contiguous shots, no near-zero shots, every render() runs (so every
// word lookup resolves). The composition must `export const SHOTS`.
// Usage: edit the import below, then from the project dir:
//   npx esbuild checkshots.tsx --bundle --platform=node --jsx=automatic --outfile=/tmp/cs.js --log-level=error && node /tmp/cs.js
// (a font-loading "Failed to parse URL" error printed afterwards is harmless.)
import {SHOTS} from './src/MyVideo';
let prevEnd = 0;
const problems: string[] = [];
SHOTS.forEach((s, i) => {
  if (Math.abs(s.start - prevEnd) > 1e-6) problems.push(`gap/overlap before shot ${i}: prev end ${prevEnd.toFixed(3)} start ${s.start.toFixed(3)}`);
  if (s.end <= s.start) problems.push(`shot ${i} non-positive ${s.start}-${s.end}`);
  if (s.end - s.start < 0.2) problems.push(`shot ${i} very short ${(s.end - s.start).toFixed(3)}s at ${s.start.toFixed(2)}`);
  prevEnd = s.end;
  for (const t of [s.start, (s.start + s.end) / 2, s.end - 1 / 60]) s.render(t, s);
});
console.log(`shots ${SHOTS.length}; last end ${prevEnd.toFixed(2)}`);
console.log(SHOTS.map((s) => `${s.start.toFixed(2)}${s.enter[0]}`).join(' '));
console.log(problems.length ? problems.join('\n') : 'no problems');
