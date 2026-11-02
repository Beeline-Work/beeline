/** Run in the assigned Beeline agent's corner, never in GitHub Actions. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadCases, loadSource } from './prompt-cases.ts';
import { executeSample } from './prompt-subscription-replay.mjs';
import { needsSquire } from './prompt-nightly.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const MODELS = { baby: 'gpt-6-luna', terra: 'gpt-5.6-terra', speedy: 'gpt-6.1-sol' };
const variant = { name: 'full', mode: 'full', core: [], promptEdits: [], appendRules: '' };
const cell = value => String(value ?? '').replace(/[|\r\n]/g, ' ').slice(0, 250);
export function verdict(result) {
  const eligible = result.rows.filter(row => row.status !== 'skipped:squire');
  return eligible.length > 0 && eligible.length === result.expected && eligible.every(row => row.pass === true) && !result.error;
}
export function markdown(result) {
  return [`<!-- beeline-prompt-replay:${result.head} -->`,
    `**Prompt replay: ${verdict(result) ? 'PASS' : 'FAIL'}**`, '',
    `Head: \`${result.head}\` · Beeline agent: ${result.agent} · subscription: \`${result.model}\``,
    'One fresh sample per case; simulated tools only. Browser-session cases are explicitly excluded, as in the nightly cohort.',
    ...(result.error ? ['', `Replay error: ${cell(result.error)}`] : []), '',
    '| Case | Result | Detail |', '| --- | --- | --- |',
    ...result.rows.map(row => `| ${cell(row.id)} | ${row.status === 'skipped:squire' ? 'SKIP' : row.pass ? 'PASS' : 'FAIL'} | ${cell(row.reason)} |`), '',
    `${result.rows.filter(row => row.pass).length}/${result.expected} eligible cases passed; ${result.rows.filter(row => row.status === 'skipped:squire').length} browser cases skipped.`,
  ].join('\n');
}
export function liveHead(repository, number) {
  // gh-axi renders scalar responses in an api_response envelope. Request only
  // fixed-format state/hash, avoiding assumptions about its object formatter.
  const output = execFileSync('gh-axi', ['api', `repos/${repository}/pulls/${number}`,
    '--template', '{{.state}} {{.head.sha}}'], { encoding: 'utf8' });
  const match = output.match(/\b(open|closed) ([a-f0-9]{40})\b/);
  if (!match) throw new Error('Could not read live PR head');
  return { state: match[1], head: match[2] };
}
export async function replay({ repository, number, head, agent, out, sourceRoot = ROOT }, dependencies = {}) {
  if (repository !== 'Beeline-Work/beeline' || !Number.isSafeInteger(number) || number < 1 ||
      !/^[a-f0-9]{40}$/.test(head) || !Object.hasOwn(MODELS, agent)) throw new Error('Expected Beeline PR, exact head and baby/terra/speedy agent');
  const current = dependencies.liveHead ?? liveHead;
  const isCurrent = () => { const live = current(repository, number); return live.state === 'open' && live.head === head; };
  if (!isCurrent()) return { status: 'superseded' };
  const checkout = dependencies.checkout ?? (() => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim());
  if (checkout() !== head) throw new Error('Checkout is not the requested PR head');
  mkdirSync(out, { recursive: true });
  const cases = (dependencies.loadCases ?? loadCases)();
  const result = { repository, number, head, agent, model: MODELS[agent], expected: cases.filter(c => !needsSquire(c)).length, rows: [] };
  const save = () => {
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    writeFileSync(join(out, 'verdict.md'), markdown(result) + '\n');
  };
  save();
  try {
    const source = await (dependencies.loadSource ?? loadSource)(sourceRoot);
    let stopped;
    for (const testCase of cases) {
      if (needsSquire(testCase)) result.rows.push({ id: testCase.id, status: 'skipped:squire', reason: 'Requires a real browser session' });
      else if (stopped) result.rows.push({ id: testCase.id, status: 'incomplete', pass: false, reason: stopped });
      else {
        try {
          const sample = await (dependencies.executeSample ?? executeSample)({ source, testCase, variant,
            model: result.model, directory: join(out, testCase.id), timeoutMs: 180000 });
          const pass = sample.status === 'behavior' && sample.pass === true && !sample.timedOut && sample.exitCode === 0;
          result.rows.push({ id: testCase.id, status: sample.status, pass,
            reason: sample.error || sample.reason || (pass ? '' : 'Incomplete model sample') });
          if (sample.modelStopped) stopped = sample.error || 'Subscription unavailable';
        } catch (error) {
          stopped = error.message;
          result.rows.push({ id: testCase.id, status: 'incomplete', pass: false, reason: stopped });
        }
      }
      save();
    }
  } catch (error) { result.error = error.message; }
  // Infrastructure failures must still produce one explicit row per case.
  for (const testCase of cases) if (!result.rows.some(row => row.id === testCase.id))
    result.rows.push({ id: testCase.id, pass: false, status: 'incomplete', reason: result.error });
  save();
  if (!isCurrent()) return { status: 'superseded', result };
  const publish = dependencies.publish ?? (() => execFileSync('gh-axi', ['pr', 'comment', String(number),
    '--repo', repository, '--body-file', join(out, 'verdict.md')], { encoding: 'utf8' }));
  publish();
  return { status: verdict(result) ? 'pass' : 'fail', result };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  replay({ repository: option('--repository'), number: Number(option('--number')), head: option('--head'),
    agent: option('--agent'), out: resolve(option('--out') ?? '.beeline-proof/prompt-pr-replay') })
    .then(result => { console.log(result.status); process.exitCode = result.status === 'fail' ? 1 : 0; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
