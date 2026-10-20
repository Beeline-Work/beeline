import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { evaluateRule, type Transcript } from '../../../../scripts/prompt-case-rules.js';

const root = process.argv[2]!;
const cases = resolve(dirname(process.argv[1]!), '..');
let pass = 0;
let total = 0;
let casePass = 0;
let caseTotal = 0;
let complete = 0;
const failures: { id: string; variant: string; passed: number; samples: number }[] = [];

for (const variant of ['with', 'without']) {
  const dir = join(root, variant);
  if (!existsSync(dir)) continue;
  const files = readdirSync(dir);
  for (const prompt of files.filter((file) => file.endsWith('.prompt.md'))) {
    const id = prompt.replace('.prompt.md', '');
    const casePath = join(cases, `${id}.json`);
    if (!existsSync(casePath)) continue;
    const testCase = JSON.parse(readFileSync(casePath, 'utf8'));
    const samples = files.filter((file) =>
      file.startsWith(`${id}.`) && /^\d+\.json$/.test(file.slice(id.length + 1)));
    let passed = 0;
    for (const file of samples) {
      total++;
      try {
        const answer = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        const transcript: Transcript = {
          calls: Array.isArray(answer.calls) ? answer.calls.map((call) => ({
            name: String(call?.name ?? ''), args: call?.args ?? {},
          })) : [],
          text: typeof answer.text === 'string' ? answer.text : '',
        };
        if (evaluateRule(testCase.pass, transcript).pass) {
          pass++;
          passed++;
        }
      } catch {
        // A failed or malformed replay remains a failed sample.
      }
    }
    caseTotal++;
    if (samples.length === 3) {
      complete++;
      if (passed >= 2) casePass++;
    }
    if (samples.length > 0 && passed !== samples.length) {
      failures.push({ id, variant, passed, samples: samples.length });
    }
  }
}
console.log(JSON.stringify({ casePass, caseTotal, complete, pass, total, failures }, null, 2));
