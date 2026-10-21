/** Bounded model replay. Never executes the simulated tools in a case. */
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { check, loadCases, loadSource, parseAnswer, replayPrompt } from './prompt-cases.ts';
import { evaluateRule, skillPath } from './prompt-case-rules.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'apps/body/src/prompt-assembly.ts';
const MAX_OUTPUT = 4096;
const MAX_ROUNDS = 6;
export const DEFAULT_TOKEN_CAP = 6_000_000;
export const DEFAULT_COST_CAP = 3;
export const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Only complete literal paragraphs in render functions can be removed. */
export function removalBlocks(text) {
  const source = ts.createSourceFile(SOURCE, text, ts.ScriptTarget.Latest, true);
  const blocks = [];
  const walk = (node, section) => {
    if (ts.isObjectLiteralExpression(node)) {
      const id = node.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(source) === 'id');
      if (id && ts.isStringLiteral(id.initializer)) section = id.initializer.text;
    }
    if (section && ts.isStringLiteral(node) && node.text.length >= 70 &&
        ts.isCallExpression(node.parent) && node.parent.expression.getText(source) === 'paragraphs') {
      blocks.push({ id: `${section}:${createHash('sha256').update(node.text).digest('hex').slice(0, 12)}`,
        section, text: node.text, start: node.getStart(source), end: node.end });
    }
    ts.forEachChild(node, (child) => walk(child, section));
  };
  walk(source);
  return blocks;
}

export function chooseBlock(blocks, baseline, cases, previousId) {
  const protectedSections = new Set(baseline.filter((row) => !row.pass).map((row) => cases.find((c) => c.id === row.id)?.section));
  const candidates = blocks.filter((block) => !protectedSections.has(block.section));
  if (!candidates.length) return undefined;
  const previous = candidates.findIndex((block) => block.id === previousId);
  return candidates[(previous + 1) % candidates.length];
}

export function assessExperiment(baseline, candidate) {
  const missing = baseline.length !== candidate.length || baseline.some((row) => !candidate.some((c) => c.id === row.id));
  const regressions = baseline.filter((row) => row.pass && !candidate.find((c) => c.id === row.id)?.pass).map((row) => row.id);
  const before = median(baseline.flatMap((row) => row.samples.map((s) => s.tokens)));
  const after = median(candidate.flatMap((row) => row.samples.map((s) => s.tokens)));
  const tokensDrop = before !== null && after !== null && after < before;
  return { accepted: !missing && !regressions.length && tokensDrop &&
    candidate.filter((row) => row.pass).length >= baseline.filter((row) => row.pass).length,
    regressions, before, after };
}

export function budget(tokenCap = DEFAULT_TOKEN_CAP, costCap = DEFAULT_COST_CAP) {
  let tokens = 0, cost = 0, reserved = 0, reservedCost = 0;
  return {
    reserve(body) {
      // A UTF-8 byte per input token is conservative; include output/reasoning.
      const bound = Buffer.byteLength(JSON.stringify(body.messages)) + body.max_tokens;
      if (tokens + reserved + bound > tokenCap || cost + reservedCost + 0.1 > costCap) throw new Error('Nightly replay budget exhausted');
      reserved += bound;
      reservedCost += 0.1;
      return () => { reserved -= bound; reservedCost -= 0.1; };
    },
    record(usage) {
      if (!Number.isFinite(usage?.total_tokens) || usage.total_tokens <= 0 ||
          !Number.isFinite(usage?.cost) || usage.cost < 0) throw new Error('Provider returned no usable token/cost accounting');
      tokens += usage.total_tokens;
      cost += usage.cost;
      if (tokens > tokenCap || cost > costCap) throw new Error('Nightly replay budget exceeded');
    },
    get tokens() { return tokens; }, get cost() { return cost; },
  };
}

export async function replaySample({ prompt, skills, rule, model, request, ledger }) {
  const messages = [{ role: 'user', content: prompt }];
  const transcript = { calls: [], text: '' };
  const requests = [];
  let tokens = 0, cost = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = { model, messages, stream: false, max_tokens: MAX_OUTPUT, reasoning: { enabled: false }, usage: { include: true } };
    const release = ledger.reserve(body);
    let response;
    try { response = await request(body); ledger.record(response.usage); }
    finally { release(); }
    tokens += response.usage.total_tokens;
    cost += response.usage.cost;
    requests.push({ id: response.id, model: response.model, usage: response.usage });
    if (response.model !== model) throw new Error(`Off-model replay: ${response.model}`);
    const choice = response.choices?.[0];
    if (!choice || choice.finish_reason !== 'stop' || typeof choice.message?.content !== 'string')
      return { pass: false, reason: 'Incomplete model answer', transcript, tokens, cost, requests };
    let answer;
    try {
      answer = parseAnswer(choice.message.content);
      if (!Array.isArray(answer.calls) || typeof answer.text !== 'string' ||
          answer.calls.some((call) => !call || typeof call.name !== 'string' || !call.args || typeof call.args !== 'object'))
        throw new Error('Malformed replay transcript');
    } catch (error) {
      return { pass: false, reason: error.message, transcript, tokens, cost, requests };
    }
    // A skill Read is a pause boundary; nothing beyond it has been simulated.
    const boundary = answer.calls.findIndex((call) => call.name === 'Read' && Object.hasOwn(skills, call.args.file_path));
    transcript.calls.push(...(boundary < 0 ? answer.calls : answer.calls.slice(0, boundary + 1)));
    if (answer.text) transcript.text += `${transcript.text ? '\n' : ''}${answer.text}`;
    if (boundary < 0) return { ...evaluateRule(rule, transcript), transcript, tokens, cost, requests };
    const call = answer.calls[boundary];
    messages.push({ role: 'assistant', content: JSON.stringify({ calls: answer.calls.slice(0, boundary + 1), text: answer.text }) });
    messages.push({ role: 'user', content: `Requested skill result: ${JSON.stringify({ call, content: skills[call.args.file_path] })}\nContinue the same turn. Return only new calls and text as JSON.` });
  }
  // An unfinished skill continuation cannot pass a negative-only rule.
  return { pass: false, reason: 'Skill continuation exceeded six rounds', transcript, tokens, cost, requests };
}

export async function replaySuite(source, cases, options) {
  const rows = [];
  let next = 0;
  let failed;
  async function worker() {
   while (next < cases.length && !failed) {
    const testCase = cases[next++];
    try {
    const skills = Object.fromEntries(source.skills.beelineManagedSkills('source', { isReviewer: testCase.session?.reviewer === true })
      .map((skill) => [skillPath(skill.name), skill.content]));
    const prompt = replayPrompt(source, testCase);
    const samples = [];
    const sample = () => replaySample({ prompt, skills, rule: testCase.pass, ...options });
    samples.push(await sample());
    if (!samples[0].pass) {
      samples.push(await sample());
      samples.push(await sample());
    }
    const pass = samples.length === 1 ? samples[0].pass : samples.filter((s) => s.pass).length >= 2;
    const row = { id: testCase.id, section: testCase.section, pass, medianTokensPerTurn: median(samples.map((s) => s.tokens)), samples };
    rows.push(row);
    if (options.onCase) options.onCase(row);
    } catch (error) { failed = error; }
   }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  if (failed) throw failed;
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/** File exchange permits a Beeline agent to use sealed Squire calls, without keys in this process. */
export function fileTransport(directory) {
  mkdirSync(directory, { recursive: true });
  let sequence = 0;
  return async (body) => {
    const id = String(++sequence).padStart(5, '0');
    const requestPath = join(directory, `${id}.request.json`);
    writeFileSync(`${requestPath}.tmp`, JSON.stringify(body));
    renameSync(`${requestPath}.tmp`, requestPath);
    const responsePath = join(directory, `${id}.response.json`);
    const deadline = Date.now() + 180_000;
    while (!existsSync(responsePath)) {
      if (Date.now() > deadline) throw new Error(`Sealed transport timed out for ${id}`);
      await new Promise((done) => setTimeout(done, 100));
    }
    const response = JSON.parse(readFileSync(responsePath, 'utf8'));
    if (response.error) throw new Error(`Sealed model request failed: ${response.error}`);
    return response;
  };
}

export async function httpTransport(body) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured');
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Model request failed: HTTP ${response.status}`);
  return response.json();
}

export async function runNightly({ out, history, request, tokenCap, costCap, root = ROOT }) {
  mkdirSync(out, { recursive: true });
  const startedAt = new Date().toISOString();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  // Read the production default, rather than maintain a separate model choice.
  const model = readFileSync(join(root, 'apps/server/src/free-agents.ts'), 'utf8')
    .match(/model: env\.BEELINE_FREE_AGENT_MODEL \|\| '([^']+)'/)?.[1];
  if (!model) throw new Error('Cannot determine the production free-agent model');
  const cases = loadCases();
  const source = await loadSource(root);
  const problems = check(source, cases);
  if (problems.length) throw new Error(problems.join('\n'));
  const ledger = budget(tokenCap, costCap);
  const result = { startedAt, commit, model, status: 'running', caseCount: cases.length, baseline: [], candidate: [], experiment: { outcome: 'not run' } };
  const save = () => writeFileSync(join(out, 'result.json'), `${JSON.stringify({ ...result, tokens: ledger.tokens, cost: ledger.cost }, null, 2)}\n`);
  let temp;
  try {
    result.baseline = await replaySuite(source, cases, { model, request, ledger, onCase(row) { result.baseline.push(row); save(); } });
    const text = readFileSync(join(root, SOURCE), 'utf8');
    const prior = existsSync(history) ? readFileSync(history, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
    const block = chooseBlock(removalBlocks(text), result.baseline, cases, prior.at(-1)?.experiment?.block?.id);
    if (block) {
      result.experiment = { outcome: 'running', block };
      temp = mkdtempSync(join(tmpdir(), 'beeline-prompt-nightly-'));
      cpSync(join(root, 'apps/body/src'), join(temp, 'apps/body/src'), { recursive: true });
      symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir');
      const candidateText = text.slice(0, block.start) + "''" + text.slice(block.end);
      writeFileSync(join(temp, SOURCE), candidateText);
      const candidateSource = await loadSource(temp);
      const invalid = check(candidateSource, cases);
      if (invalid.length) result.experiment.outcome = `rejected: ${invalid.join('; ')}`;
      else {
        result.candidate = await replaySuite(candidateSource, cases, { model, request, ledger,
          onCase(row) { result.candidate.push(row); save(); } });
        const assessment = assessExperiment(result.baseline, result.candidate);
        result.experiment = { ...result.experiment, ...assessment, outcome: assessment.accepted ? 'propose removal' : 'rejected' };
        if (assessment.accepted) {
          writeFileSync(join(out, 'prompt-assembly.ts'), candidateText);
          writeFileSync(join(out, 'proposal.md'), `Remove one prompt paragraph after nightly replay\n\n## Reproduced\nNot a defect report. Experiment ${block.id} on ${commit}, model ${model}.\n\n## Demonstrated\nReplayed all ${cases.length} cases on baseline and candidate using the existing first-pass/2-of-3 rule. Baseline ${result.baseline.filter((r) => r.pass).length}/${cases.length}; candidate ${result.candidate.filter((r) => r.pass).length}/${cases.length}. Median tokens per simulated turn: ${assessment.before} → ${assessment.after}. No previously passing case regressed. Total nightly tokens: ${ledger.tokens}; cost: $${ledger.cost.toFixed(6)}.\n\nNormal independent review and merge authority still apply. Run artifact contains per-case samples and accounting.\n`);
        }
      }
    } else result.experiment.outcome = 'skipped: all blocks protected by failing cases';
    result.status = 'complete';
  } catch (error) {
    result.status = 'incomplete';
    result.error = error.message;
    result.experiment.outcome = 'incomplete; no proposal';
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
    save();
  }
  const passed = result.baseline.filter((row) => row.pass).length;
  const total = median(result.baseline.flatMap((row) => row.samples.map((sample) => sample.tokens)));
  const rate = result.status === 'complete'
    ? `${passed}/${cases.length} passed (${(100 * passed / cases.length).toFixed(1)}%)`
    : `${result.baseline.length}/${cases.length} cases completed, ${passed} passed; overall pass rate unavailable`;
  const summary = `Prompt nightly ${startedAt.slice(0, 10)}: ${result.status}; ${rate}; median ${total ?? 'unknown'} tokens/turn; ${ledger.tokens} total tokens, $${ledger.cost.toFixed(6)}; experiment ${result.experiment.block?.id ?? 'none'}: ${result.experiment.outcome}${result.error ? `; ${result.error}` : ''}.`;
  writeFileSync(join(out, 'summary.txt'), `${summary}\n`);
  mkdirSync(dirname(history), { recursive: true });
  appendFileSync(history, `${JSON.stringify({ startedAt, commit, model, status: result.status, passed, cases: cases.length, medianTokensPerTurn: total,
    tokens: ledger.tokens, cost: ledger.cost, perCase: result.baseline.map(({ id, pass, medianTokensPerTurn }) => ({ id, pass, medianTokensPerTurn })), experiment: result.experiment })}\n`);
  console.log(summary);
  return { ...result, tokens: ledger.tokens, cost: ledger.cost };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
  const out = resolve(option('--out', '.scratch/prompt-nightly/latest'));
  const history = resolve(option('--history', '.scratch/prompt-nightly/history.jsonl'));
  const exchange = option('--exchange');
  const tokenCap = Number(option('--token-cap', DEFAULT_TOKEN_CAP));
  const costCap = Number(option('--cost-cap', DEFAULT_COST_CAP));
  if (![tokenCap, costCap].every((value) => Number.isFinite(value) && value > 0)) throw new Error('Budgets must be positive finite numbers');
  const result = await runNightly({ out, history, request: exchange ? fileTransport(resolve(exchange)) : httpTransport, tokenCap, costCap });
  if (result.status !== 'complete') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
