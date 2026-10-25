/** Bounded model replay. Never executes the simulated tools in a case. */
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { check, loadCases, loadSource, replayPrompt, toolsFor } from './prompt-cases.ts';
import { evaluateRule, skillPath, shellCommand } from './prompt-case-rules.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'apps/body/src/prompt-assembly.ts';
const GUIDE_SOURCE = 'apps/server/src/free-agents.ts';
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

/** Temporary tree with every file loadSource reads, so a candidate prompt can be loaded. */
export function buildCandidateTree(root) {
  const temp = mkdtempSync(join(tmpdir(), 'beeline-prompt-nightly-'));
  cpSync(join(root, 'apps/body/src'), join(temp, 'apps/body/src'), { recursive: true });
  cpSync(join(root, GUIDE_SOURCE), join(temp, GUIDE_SOURCE));
  symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir');
  return temp;
}

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

export function chooseBlock(blocks, baseline, cases, previousId, skipped = []) {
  const protectedSections = new Set([...baseline.filter((row) => !row.pass), ...skipped]
    .map((row) => cases.find((c) => c.id === row.id)?.section));
  const candidates = blocks.filter((block) => !protectedSections.has(block.section) && !/authority|safety/i.test(block.section + ' ' + block.text));
  if (!candidates.length) return undefined;
  const previous = candidates.findIndex((block) => block.id === previousId);
  return candidates[(previous + 1) % candidates.length];
}

// One-sided exact paired sign test: discordant pairs have equal signs under no effect.
export function pairedPValue(gains, losses) {
  const n = gains + losses;
  if (!n || gains <= losses) return 1;
  let term = 2 ** -n, sum = term;
  for (let k = 1; k <= losses; k++) { term *= (n - k + 1) / k; sum += term; }
  return sum;
}

export function assessExperiment(baseline, candidate, control = []) {
  const pairs = (other) => baseline.flatMap(row => row.samples.map((s, index) => ({ id: row.id, index, baseline: s,
    other: other.find(c => c.id === row.id)?.samples[index] })));
  const changed = pairs(candidate), unchanged = pairs(control);
  const valid = p => p.baseline.status === 'behavior' && p.other?.status === 'behavior';
  const complete = changed.length > 0 && changed.every(valid) && unchanged.every(valid) &&
    candidate.length === baseline.length && control.length === baseline.length &&
    [candidate, control].every(rows => baseline.every(r => rows.find(c => c.id === r.id)?.samples.length === r.samples.length)) &&
    [...changed, ...unchanged].every(p => p.other?.seed === p.baseline.seed);
  const gains = changed.filter(p => valid(p) && !p.baseline.pass && p.other.pass).length;
  const losses = changed.filter(p => valid(p) && p.baseline.pass && !p.other.pass).length;
  const flips = unchanged.filter(p => valid(p) && p.baseline.pass !== p.other.pass).length;
  const controlGains = unchanged.filter(p => valid(p) && !p.baseline.pass && p.other.pass).length;
  const controlLosses = unchanged.filter(p => valid(p) && p.baseline.pass && !p.other.pass).length;
  const aboveControl = changed.filter((p, i) => valid(p) && valid(unchanged[i]));
  const excessGains = aboveControl.filter(p => !control.find(r => r.id === p.id).samples[p.index].pass && p.other.pass).length;
  const excessLosses = aboveControl.filter(p => control.find(r => r.id === p.id).samples[p.index].pass && !p.other.pass).length;
  const before = median(baseline.flatMap(r => r.samples.map(s => s.tokens)));
  const after = median(candidate.flatMap(r => r.samples.map(s => s.tokens)));
  const regressions = [...new Set(changed.filter(p => valid(p) && p.baseline.pass && !p.other.pass).map(p => p.id))];
  const net = gains - losses;
  // Conservative paired discordance interval; a zero-effect result needs more data.
  const margin = 1.96 * Math.sqrt(gains + losses);
  const effectInterval = changed.length ? [(net-margin)/changed.length, (net+margin)/changed.length] : [-1, 1];
  const effectPValue = pairedPValue(gains, losses), excessPValue = pairedPValue(excessGains, excessLosses);
  // Compare against both baseline and the unchanged control. Flips are unsigned
  // noise, not expected drift; requiring net > all flips never improves with N.
  const enough = complete && effectPValue < 0.025 && excessPValue < 0.025;
  const noisePairs = unchanged.filter(valid).length;
  const noiseRate = noisePairs ? flips / noisePairs : null;
  // Planning approximation: 80% power, two-sided 5%, independent discordance
  // in two comparisons. Floor prevents claiming zero uncertainty at zero flips.
  const detectableEffect = noisePairs ? Math.min(1, Math.max(6 / noisePairs,
    2.8 * Math.sqrt(2 * Math.max(noiseRate, 1 / noisePairs) / noisePairs))) : null;
  return { accepted: enough && !losses && after < before, outcome: !enough ? 'too little data' : !losses && after < before ? 'propose removal' : 'rejected',
    gains, losses, pairedSamples: changed.filter(valid).length, noiseFlips: flips, noisePairs, noiseRate,
    controlGains, controlLosses, controlDrift: noisePairs ? (controlGains-controlLosses)/noisePairs : null,
    excessGains, excessLosses, effectPValue, excessPValue, detectableEffect,
    effectInterval, regressions, before, after };
}

export function budget(tokenCap = DEFAULT_TOKEN_CAP, costCap = DEFAULT_COST_CAP) {
  let tokens = 0, cost = 0, reserved = 0, reservedCost = 0;
  return {
    reserve(body) {
      // A UTF-8 byte per input token is conservative; include output/reasoning.
      const bound = Buffer.byteLength(JSON.stringify(body.messages)) + body.max_tokens;
      if (tokens + reserved + bound > tokenCap || cost + reservedCost + 0.1 > costCap) throw new Error('Weekly replay budget exhausted');
      reserved += bound;
      reservedCost += 0.1;
      return () => { reserved -= bound; reservedCost -= 0.1; };
    },
    record(usage) {
      if (!Number.isFinite(usage?.total_tokens) || usage.total_tokens <= 0 ||
          !Number.isFinite(usage?.cost) || usage.cost < 0) throw new Error('Provider returned no usable token/cost accounting');
      tokens += usage.total_tokens;
      cost += usage.cost;
      if (tokens > tokenCap || cost > costCap) throw new Error('Weekly replay budget exceeded');
    },
    get tokens() { return tokens; }, get cost() { return cost; },
  };
}

/** JSON schema vocabulary used by the mounted tool surface. No coercion or repair. */
export function validSchema(schema, value) {
  if (schema.anyOf && !schema.anyOf.some(s => validSchema(s, value))) return false;
  if (schema.oneOf && schema.oneOf.filter(s => validSchema(s, value)).length !== 1) return false;
  if (schema.allOf && !schema.allOf.every(s => validSchema(s, value))) return false;
  if (schema.not && validSchema(schema.not, value)) return false;
  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) return false;
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(t => t === type || t === 'integer' && Number.isInteger(value))) return false;
  if (type === 'object') {
    if (schema.required?.some(k => !Object.hasOwn(value, k))) return false;
    for (const [k, v] of Object.entries(value)) {
      const child = schema.properties?.[k];
      if (child && !validSchema(child, v)) return false;
      if (!child && schema.additionalProperties === false) return false;
      if (!child && typeof schema.additionalProperties === 'object' && !validSchema(schema.additionalProperties, v)) return false;
    }
  }
  if (type === 'array' && (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity) || schema.items && value.some(v => !validSchema(schema.items, v)))) return false;
  if (type === 'string' && schema.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return false;
  if (type === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || schema.pattern && !new RegExp(schema.pattern).test(value))) return false;
  if (type === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

// Compose recorded observational shell results without invoking a shell. Unknown
// commands, redirects, paths and substitutions remain missing scenario facts.
export function scenarioShell(state, command) {
  const parts = [];
  let start = 0, quote = '', depth = 0, operator = ';';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\') { i++; continue; }
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === '`' || depth < 0) return;
    if (!depth && (c === ';' || c === '|' || command.slice(i, i+2) === '&&')) {
      if (command.slice(i, i+2) === '||') return;
      parts.push({ command: command.slice(start, i).trim(), operator });
      operator = c === '&' ? '&&' : c;
      if (c === '&') i++;
      start = i+1;
    }
  }
  if (quote || depth) return;
  parts.push({ command: command.slice(start).trim(), operator });
  if (!parts.some(p => p.command) || parts.slice(0, -1).some(p => !p.command) ||
      !parts.at(-1).command && parts.at(-1).operator !== ';') return;
  let stdout = '', exitCode = 0, cwd = '', pipeStart = 0;
  for (const part of parts) {
    if (!part.command || part.operator === '&&' && exitCode) continue;
    const head = /^head -(\d+)$/.exec(part.command);
    if (part.operator === '|') {
      if (!head) return;
      stdout = stdout.slice(0, pipeStart) + stdout.slice(pipeStart).split('\n').slice(0, Number(head[1])).join('\n');
      continue;
    }
    const cmd = part.command.replace(/ 2>(?:\/dev\/null|&1)$/, '');
    const call = { name: 'Bash', args: { command: cmd } };
    const recorded = state.results?.find(entry => entry.call === 'Bash' &&
      evaluateRule({ call: entry.call, args: entry.args }, { calls: [call], text: '' }).pass);
    let result = recorded?.result;
    if (recorded?.boundary) return;
    if (!result) {
      const cat = /^(?:cat|sed -n '1,\d+p') ([a-zA-Z0-9_./-]+)$/.exec(cmd);
      const path = cat && (cwd ? `${cwd}/${cat[1]}` : cat[1]);
      if (path && Object.hasOwn(state.files ?? {}, path)) result = { exitCode: 0, stdout: state.files[path] };
      const echo = /^echo (["'])([^\n]*)\1$/.exec(cmd);
      if (echo && !/[`$\\]/.test(echo[2].replace(/\$\?/g, ''))) result = { exitCode: 0, stdout: echo[2].replace(/\$\?/g, String(exitCode)) + '\n' };
    }
    if (!result || typeof result.exitCode !== 'number' || typeof result.stdout !== 'string') return;
    if (result.cwd !== undefined) cwd = result.cwd;
    pipeStart = stdout.length;
    stdout += result.stdout;
    exitCode = result.exitCode;
  }
  return { result: { exitCode, stdout } };
}

export function scenarioResult(testCase, call, skills) {
  if (call.name === 'Read' && Object.hasOwn(skills, call.args.file_path)) return { result: skills[call.args.file_path] };
  const state = testCase.scenario ?? {};
  const explicit = state.results?.filter(entry => evaluateRule({ call: entry.call, args: entry.args }, { calls: [call], text: '' }).pass)
    .sort((a, b) => Object.keys(b.args ?? {}).length - Object.keys(a.args ?? {}).length)[0];
  if (explicit) return { result: explicit.result, ...(explicit.boundary ? { boundary: explicit.boundary } : {}) };
  if (call.name === 'Read' && Object.hasOwn(state.files ?? {}, call.args.file_path)) return { result: state.files[call.args.file_path] };
  // Equivalent native file reads use the same recorded fact, without running a shell.
  const command = shellCommand(call);
  if (command !== undefined) {
    const path = /^cat\s+([/a-zA-Z0-9_.-]+)\s*$/.exec(command)?.[1];
    if (path && Object.hasOwn(state.files ?? {}, path)) return { result: { exitCode: 0, stdout: state.files[path] } };
    const composed = scenarioShell(state, command);
    if (composed) return composed;
  }
  if (call.name === 'read') {
    const facts = { brief: state.brief ?? testCase.session?.brief, messages: state.history ?? testCase.messages, checks: state.checks, usage: state.usage };
    if (facts[call.args.facet] !== undefined) return { result: facts[call.args.facet] };
  }
  if (call.name === 'connect' && Object.hasOwn(state.connect ?? {}, call.args.mode)) return { result: state.connect[call.args.mode] };
  const legacy = testCase.toolResults?.[call.name];
  if (legacy !== undefined) {
    let result; try { result = JSON.parse(legacy); } catch { result = legacy; }
    return { result, ...(/pending approval/i.test(legacy) ? { boundary: 'approval' } : {}) };
  }
  // Missing facts are a simulator limitation, never invented success or agent failure.
  return { result: { error: 'No scenario result recorded for this call' }, boundary: 'missing' };
}

/** Fail closed on already-observed forbidden actions, even if continuation is unavailable. */
function safetyViolation(rule, transcript) {
  if ('all' in rule) return rule.all.map(r => safetyViolation(r, transcript)).find(Boolean);
  if ('noCall' in rule || 'atMostOnce' in rule || 'not' in rule && 'call' in rule.not) {
    const verdict = evaluateRule(rule, transcript);
    if (!verdict.pass) return verdict.reason;
  }
}

export async function replaySample({ prompt, skills, rule, model, request, ledger, testCase = {}, tools = [], seed = 1, structured = true }) {
  const messages = [{ role: 'user', content: prompt }];
  const transcript = { calls: [], text: '' };
  const requests = [], rounds = [], invalidCalls = [], attemptedCalls = [];
  let tokens = 0, cost = 0;
  const finish = (status, reason, terminal) => {
    const unsafe = safetyViolation(rule, { ...transcript, calls: attemptedCalls });
    if (unsafe && status === 'incomplete') { status = 'behavior'; reason = unsafe; terminal = 'unsafe-action'; }
    if (invalidCalls.length && !transcript.calls.length && ['final', 'round-limit'].includes(terminal)) {
      status = 'behavior'; reason = 'No valid tool call after validation errors'; terminal = 'invalid-call';
    }
    let verdict = { pass: null, reason };
    if (status === 'behavior') verdict = unsafe || terminal === 'invalid-call'
      ? { pass: false, reason: unsafe ?? reason } : evaluateRule(rule, transcript);
    return { ...verdict, status, terminal, transcript, attemptedCalls, invalidCalls, tokens, cost, requests, rounds, seed,
      truthfulness: testCase.truthfulness ? evaluateRule(testCase.truthfulness, transcript) : undefined };
  };
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const answerSchema = { type: 'object', properties: { calls: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name', 'args'], additionalProperties: false } }, text: { type: 'string' } }, required: ['calls', 'text'], additionalProperties: false };
    const body = { model, messages, seed, provider: { require_parameters: true }, stream: false, max_tokens: MAX_OUTPUT, reasoning: { enabled: false }, usage: { include: true },
      ...(structured ? { response_format: { type: 'json_schema', json_schema: { name: 'replay_turn', strict: true, schema: answerSchema } } } : {}) };
    let response, release;
    try {
      release = ledger.reserve(body);
      response = await request(body);
      if (Number.isFinite(response.usage?.total_tokens)) tokens += response.usage.total_tokens;
      if (Number.isFinite(response.usage?.cost)) cost += response.usage.cost;
      ledger.record(response.usage);
    } catch (error) {
      rounds.push({ round, raw: response?.choices?.[0]?.message?.content, response, error: error.message });
      return finish('incomplete', error.message, /budget/i.test(error.message) ? 'budget' : 'transport');
    } finally { release?.(); }
    requests.push({ id: response.id, model: response.model, usage: response.usage });
    const choice = response.choices?.[0];
    const raw = choice?.message?.content;
    const trace = { round, raw, response, results: [] };
    rounds.push(trace);
    if (response.model !== model) return finish('incomplete', `Off-model replay: ${response.model}`, 'transport');
    if (!choice || choice.finish_reason !== 'stop') return finish('incomplete', 'Incomplete model answer', 'output-limit');
    let answer;
    try {
      answer = JSON.parse(raw);
      if (!validSchema(answerSchema, answer)) throw new Error('Malformed replay transcript');
    } catch (error) { return finish('format', error.message, 'json'); }
    if (answer.text) transcript.text += `${transcript.text ? '\n' : ''}${answer.text}`;
    if (!answer.calls.length) return finish('behavior', undefined, 'final');
    attemptedCalls.push(...answer.calls);
    const validCalls = [];
    for (const call of answer.calls) {
      const definition = tools.find(t => t.name === call.name);
      if (!definition || !validSchema(definition.inputSchema, call.args)) {
        const result = { error: 'validation_error', message: definition ? `Arguments must match ${JSON.stringify(definition.inputSchema)}` : `Unknown tool: ${call.name}` };
        invalidCalls.push({ round, call, result });
        trace.results.push({ call, result });
      } else validCalls.push(call);
    }
    transcript.calls.push(...validCalls);
    for (const call of validCalls) {
      // These calls end the assigned turn; trailing calls are never silently dropped.
      if (['order', 'report', 'no_reply_needed'].includes(call.name)) {
        if (answer.calls.at(-1) !== call) return { ...finish('behavior', undefined, 'invalid-sequence'), pass: false, reason: 'Calls after terminal action' };
        return finish('behavior', undefined, call.name);
      }
      const result = scenarioResult(testCase, call, skills);
      trace.results.push({ call, ...result });
      if (result.boundary === 'missing') return finish('incomplete', result.result.error, 'scenario');
      if (result.boundary) {
        if (answer.calls.at(-1) !== call) return { ...finish('behavior', undefined, 'invalid-sequence'), pass: false, reason: 'Calls after a tool boundary' };
        return finish('behavior', undefined, result.boundary);
      }
      if (['order', 'report', 'no_reply_needed', 'merge_corner'].includes(call.name)) return finish('behavior', undefined, call.name);
    }
    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: `Simulated tool results: ${JSON.stringify(trace.results)}\nContinue the same turn. Return only new calls and text as JSON. If finished, return calls:[].` });
  }
  return finish('incomplete', 'Continuation exceeded six rounds', 'round-limit');
}

export const FIXED_SAMPLES = 3;
export function proportion(samples) {
  const scored = samples.filter(s => s.status === 'behavior');
  const n = scored.length, k = scored.filter(s => s.pass).length;
  if (!n) return { passed: k, scored: n, proportion: null, interval: [0, 1] };
  const p = k / n, z = 1.96, d = 1 + z*z/n;
  const center = (p + z*z/(2*n))/d;
  const half = z*Math.sqrt(p*(1-p)/n + z*z/(4*n*n))/d;
  return { passed: k, scored: n, proportion: p, interval: [center-half, center+half] };
}
export function classCounts(rows) {
  const counts = { pass: 0, behavior: 0, format: 0, incomplete: 0 };
  for (const row of rows) for (const sample of row.samples) counts[sample.status === 'behavior' && sample.pass ? 'pass' : sample.status]++;
  return counts;
}

export function diagnostics(rows) {
  const incomplete = rows.flatMap(row => row.samples.filter(s => s.status === 'incomplete')
    .map(s => ({ id: row.id, seed: s.seed, terminal: s.terminal, reason: s.reason,
      ...(s.terminal === 'scenario' ? { call: s.rounds.at(-1)?.results?.at(-1)?.call } : {}) })));
  return { invalidCalls: rows.reduce((n, r) => n + r.samples.reduce((a, s) => a + s.invalidCalls.length, 0), 0),
    scenarioIncomplete: incomplete.filter(s => s.terminal === 'scenario').length, incomplete };
}

/** Browser-session cases stay outside both arms of the weekly cohort. */
export function needsSquire(testCase) {
  const browserTools = testCase.tools?.some((name) => name.startsWith('operate_'));
  return Boolean(browserTools && (JSON.stringify(testCase.pass).includes('operate_') ||
    testCase.messages?.some((line) => /session_id:|browser held by session/.test(line))));
}

export async function replaySuite(source, cases, options) {
  const rows = [];
  // Sample index and seed are identical across all arms. No success-dependent stopping.
  let next = 0;
  async function worker() {
   while (next < cases.length) {
    const testCase = cases[next++];
    const skills = Object.fromEntries(source.skills.beelineManagedSkills('source', { isReviewer: testCase.session?.reviewer === true })
      .map(skill => [skillPath(skill.name), skill.content]));
    const prompt = replayPrompt(source, testCase);
    const samples = [];
    for (let index = 0; index < FIXED_SAMPLES; index++) samples.push(await replaySample({ prompt, skills, rule: testCase.pass,
      ...options, testCase, tools: toolsFor(source, testCase), seed: 1000 + index }));
    const stats = proportion(samples);
    const row = { id: testCase.id, section: testCase.section, pass: stats.scored === FIXED_SAMPLES ? stats.proportion > 0.5 : null,
      status: samples.some(s => s.status === 'incomplete') ? 'incomplete' : samples.some(s => s.status === 'format') ? 'format' : 'behavior',
      ...stats, medianTokensPerTurn: median(samples.filter(s => s.tokens > 0).map(s => s.tokens)), samples };
    rows.push(row);
    options.onCase?.(row);
   }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
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

export async function runNightly({ out, history, request, tokenCap, costCap, root = ROOT, label = 'weekly replay' }) {
  mkdirSync(out, { recursive: true });
  const startedAt = new Date().toISOString();
  const workingTreeDiffHash = createHash('sha256').update(execFileSync('git', ['diff', '--no-ext-diff', 'HEAD'], { cwd: root })).digest('hex');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  // Read the production default, rather than maintain a separate model choice.
  const model = readFileSync(join(root, GUIDE_SOURCE), 'utf8')
    .match(/model: env\.BEELINE_FREE_AGENT_MODEL \|\| '([^']+)'/)?.[1];
  if (!model) throw new Error('Cannot determine the production free-agent model');
  const allCases = loadCases();
  const skipped = allCases.filter(needsSquire).map(({ id, section }) => ({ id, section, status: 'skipped:squire', reason: 'Requires a Squire browser session; excluded by the weekly cohort policy' }));
  const cases = allCases.filter((testCase) => !needsSquire(testCase));
  const source = await loadSource(root);
  const problems = check(source, allCases);
  if (problems.length) throw new Error(problems.join('\n'));
  const ledger = budget(tokenCap, costCap);
  const result = { startedAt, commit, workingTreeDiffHash, model, schemaVersion: 2, label, status: 'running', caseCount: allCases.length, eligibleCount: cases.length, skipped, baseline: [], control: [], candidate: [], experiment: { outcome: 'not run' } };
  const save = () => writeFileSync(join(out, 'result.json'), `${JSON.stringify({ ...result, tokens: ledger.tokens, cost: ledger.cost }, null, 2)}\n`);
  let temp;
  try {
    result.baseline = await replaySuite(source, cases, { model, request, ledger, onCase(row) { result.baseline.push(row); save(); } });
    result.control = await replaySuite(source, cases, { model, request, ledger, onCase(row) { result.control.push(row); save(); } });
    result.noise = assessExperiment(result.baseline, result.baseline, result.control);
    const text = readFileSync(join(root, SOURCE), 'utf8');
    const prior = existsSync(history) ? readFileSync(history, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
    const block = chooseBlock(removalBlocks(text), result.baseline, allCases, prior.at(-1)?.experiment?.block?.id, skipped);
    if (block) {
      result.experiment = { outcome: 'running', block };
      temp = buildCandidateTree(root);
      const candidateText = text.slice(0, block.start) + "''" + text.slice(block.end);
      writeFileSync(join(temp, SOURCE), candidateText);
      const candidateSource = await loadSource(temp);
      const invalid = check(candidateSource, allCases);
      if (invalid.length) result.experiment.outcome = `rejected: ${invalid.join('; ')}`;
      else {
        result.candidate = await replaySuite(candidateSource, cases, { model, request, ledger,
          onCase(row) { result.candidate.push(row); save(); } });
        const assessment = assessExperiment(result.baseline, result.candidate, result.control);
        result.experiment = { ...result.experiment, ...assessment, outcome: assessment.outcome };
        if (assessment.accepted) {
          writeFileSync(join(out, 'prompt-assembly.ts'), candidateText);
          writeFileSync(join(out, 'proposal.md'), `Remove one prompt paragraph after weekly replay\n\n## Reproduced\nNot a defect report. Experiment ${block.id} on ${commit}, model ${model}.\n\n## Demonstrated\nReplayed all ${cases.length} cases on baseline and candidate using fixed paired samples and an unchanged control. Baseline ${result.baseline.filter((r) => r.pass).length}/${cases.length}; candidate ${result.candidate.filter((r) => r.pass).length}/${cases.length}. Median tokens per simulated turn: ${assessment.before} → ${assessment.after}. No previously passing case regressed. Total weekly replay tokens: ${ledger.tokens}; cost: $${ledger.cost.toFixed(6)}.\n\nNormal independent review and merge authority still apply. Run artifact contains per-case samples and accounting.\n`);
        }
      }
    } else result.experiment.outcome = 'skipped: all blocks protected by failing cases';
    result.status = [result.baseline, result.control, result.candidate].some(rows => rows.some(r => r.samples.some(s => s.status === 'incomplete'))) ? 'incomplete' : 'complete';
  } catch (error) {
    result.status = 'incomplete';
    result.error = error.message;
    result.experiment.outcome = 'incomplete; no proposal';
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
    save();
  }
  result.classes = { baseline: classCounts(result.baseline), control: classCounts(result.control), candidate: classCounts(result.candidate) };
  result.diagnostics = Object.fromEntries(['baseline', 'control', 'candidate'].map(arm => [arm, diagnostics(result[arm])]));
  save();
  const passed = result.baseline.filter((row) => row.pass).length;
  const total = median(result.baseline.flatMap((row) => row.samples.filter(sample => sample.tokens > 0).map((sample) => sample.tokens)));
  const rate = result.baseline.length === cases.length && result.baseline.every(row => row.scored === FIXED_SAMPLES)
    ? `${passed}/${cases.length} passed (${(100 * passed / cases.length).toFixed(1)}%)`
    : `${result.baseline.length}/${cases.length} cases recorded, ${passed} majority passing with all samples scored; overall pass rate unavailable`;
  const diagnosticCounts = Object.fromEntries(Object.entries(result.diagnostics).map(([arm, d]) => [arm, { invalidCalls: d.invalidCalls, scenarioIncomplete: d.scenarioIncomplete }]));
  const reasons = Object.entries(result.diagnostics).flatMap(([arm, d]) => {
    const groups = new Map();
    for (const s of d.incomplete) {
      const key = `${s.terminal}: ${s.reason}${s.call ? ` (${JSON.stringify(s.call)})` : ''}`;
      const group = groups.get(key) ?? [];
      group.push(`${s.id}@${s.seed}`); groups.set(key, group);
    }
    return [...groups].map(([reason, ids]) => `${arm} incomplete — ${reason}: ${ids.join(', ')}`);
  });
  const summary = `Prompt ${label} ${startedAt.slice(0, 10)}: ${result.status}; ${rate}; ${skipped.length} skipped:squire; sample classes ${JSON.stringify(result.classes)}; diagnostics ${JSON.stringify(diagnosticCounts)}; control noise flips ${result.noise?.noiseFlips ?? 'unavailable'}/${result.noise?.noisePairs ?? 'unavailable'}; detectable effect (80% power approximation) ${result.noise?.detectableEffect ?? 'unavailable'}; median ${total ?? 'unknown'} tokens/turn; ${ledger.tokens} total tokens, $${ledger.cost.toFixed(6)}; experiment ${result.experiment.block?.id ?? 'none'}: ${result.experiment.outcome}${result.error ? `; ${result.error}` : ''}.\n${reasons.join('\n')}`;
  writeFileSync(join(out, 'summary.txt'), `${summary}\n`);
  mkdirSync(dirname(history), { recursive: true });
  appendFileSync(history, `${JSON.stringify({ schemaVersion: 2, classes: result.classes, diagnostics: result.diagnostics, noise: result.noise, startedAt, commit, model, status: result.status, passed, cases: cases.length, skipped, medianTokensPerTurn: total,
    tokens: ledger.tokens, cost: ledger.cost, perCase: result.baseline.map(({ id, pass, medianTokensPerTurn, proportion, interval, scored }) => ({ id, pass, medianTokensPerTurn, proportion, interval, scored })), experiment: result.experiment })}\n`);
  console.log(summary);
  return { ...result, tokens: ledger.tokens, cost: ledger.cost };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
  const out = resolve(option('--out', '.scratch/prompt-nightly/latest'));
  const history = resolve(option('--history', '.scratch/prompt-nightly/history.jsonl'));
  const exchange = option('--exchange');
  if (!exchange) throw new Error('Use --exchange with the Beeline vault-backed controller; keys never enter this process');
  const tokenCap = Number(option('--token-cap', DEFAULT_TOKEN_CAP));
  const costCap = Number(option('--cost-cap', DEFAULT_COST_CAP));
  if (![tokenCap, costCap].every((value) => Number.isFinite(value) && value > 0)) throw new Error('Budgets must be positive finite numbers');
  const result = await runNightly({ out, history, request: fileTransport(resolve(exchange)), tokenCap, costCap, label: option('--label', 'weekly replay') });
  if (result.status !== 'complete') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
