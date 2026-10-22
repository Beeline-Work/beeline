/** Apply wording-only judgments without rerunning the model-under-test. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { summarize } from './discovery-score.mjs';
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (!args.includes('--run') || !args.includes('--judgments') || !args.includes('--out'))
    throw new Error('Use --run result.json --judgments judgments.json --out judged.json');
const run = JSON.parse(readFileSync(resolve(option('--run')), 'utf8'));
const judgments = JSON.parse(readFileSync(resolve(option('--judgments')), 'utf8'));
if (!Array.isArray(judgments))
    throw new Error('Judgments must be an array');
const corpus = JSON.parse(readFileSync(new URL('../docs/prompts/cases/discovery/corpus.json', import.meta.url), 'utf8'));
const rubric = readFileSync(new URL('../docs/prompts/cases/discovery/judge.md', import.meta.url));
const cohort = corpus.filter((c) => run.rows.some((r) => r.id === c.id));
const summary = summarize(cohort, run.observations, judgments, createHash('sha256').update(rubric).digest('hex'));
const result = { ...run, ...summary, judgments, passRate: run.configurationParity === 'unverified; smoke only' ? null : summary.passRate };
const out = resolve(option('--out'));
if (out === resolve(option('--run')))
    throw new Error('Keep the original observations; use a separate judged output');
writeFileSync(out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(`Judged ${summary.rows.filter((r) => !r.provisional).length}/${summary.total}; overall rate ${result.passRate ?? 'unavailable'}`);
