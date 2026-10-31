/** Bounded model replay. Never executes the simulated tools in a case. */
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
export const DEFAULT_TOKEN_CAP = 15_000_000;
export const DEFAULT_COST_CAP = 12;
// Small and large model: one nightly cohort replays every arm on both.
export const DEFAULT_MODELS = ['openai/gpt-6-luna', 'openai/gpt-6.1-sol'];
// gpt-6.1-sol rejects disabled reasoning; low effort is its smallest accepted setting tested.
export const REASONING = { 'openai/gpt-6.1-sol': { effort: 'low' } };
export const PASS_FLOOR = 0.9;
export const TOKEN_GROWTH_PER_POINT = 0.02;
export const MAX_TOKEN_GROWTH = 0.1;
const SHORTENING_INTERVAL_MS = 7 * 24 * 3600_000 - 3600_000;
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
  return { significant: enough, accepted: enough && !losses && after < before, outcome: !enough ? 'too little data' : !losses && after < before ? 'propose removal' : 'rejected',
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
      if (tokens + reserved + bound > tokenCap || cost + reservedCost + 0.1 > costCap) throw new Error('Replay budget exhausted');
      reserved += bound;
      reservedCost += 0.1;
      return () => { reserved -= bound; reservedCost -= 0.1; };
    },
    record(usage) {
      if (!Number.isFinite(usage?.total_tokens) || usage.total_tokens <= 0 ||
          !Number.isFinite(usage?.cost) || usage.cost < 0) throw new Error('Provider returned no usable token/cost accounting');
      tokens += usage.total_tokens;
      cost += usage.cost;
      if (tokens > tokenCap || cost > costCap) throw new Error('Replay budget exceeded');
    },
    get tokens() { return tokens; }, get cost() { return cost; },
  };
}

/** An audit patch may change only the prompt sources the replay loads. */
export function allowedPatchPath(path) {
  return path === GUIDE_SOURCE || path.startsWith('apps/body/src/') && !path.split('/').some((part) => part === '..' || part === '');
}

/** Paths git would touch, read by git itself rather than by parsing hunks. */
export function patchPaths(file) {
  const fields = execFileSync('git', ['apply', '--numstat', '-z', file], { cwd: tmpdir(), encoding: 'utf8' }).split('\0');
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    const stat = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(fields[i]);
    if (!stat) continue;
    if (stat[1] === '-') throw new Error('Candidate patch contains a binary change');
    if (stat[3]) paths.push(stat[3]);
    else paths.push(fields[++i], fields[++i]);
  }
  return paths;
}

export function validateCandidatePatch(file) {
  const text = readFileSync(file, 'utf8');
  const paths = text.trim() ? patchPaths(file) : [];
  if (!paths.length) throw new Error('Candidate patch changes no files');
  const outside = paths.filter((path) => !allowedPatchPath(path));
  if (outside.length) throw new Error(`Candidate patch touches paths outside apps/body/src and ${GUIDE_SOURCE}: ${outside.join(', ')}`);
  return { text, paths, sha256: createHash('sha256').update(text).digest('hex') };
}

export function applyCandidatePatch(tree, file) {
  validateCandidatePatch(file);
  execFileSync('git', ['init', '-q'], { cwd: tree });
  execFileSync('git', ['apply', '--whitespace=nowarn', file], { cwd: tree });
}

/** D2: every requested model must reach the floor; a missing model rate never counts. */
export function floorReached(rates, models, floor = PASS_FLOOR) {
  return models.length > 0 && models.every((model) => typeof rates?.[model] === 'number' && rates[model] >= floor);
}

export function chooseMode({ patch, rates, models }) {
  if (patch) return 'audit';
  return floorReached(rates, models) ? 'shorten' : 'none';
}

// Only a fully scored cohort counts toward the floor; partial and legacy entries never do.
const historyRates = (entry) => Object.fromEntries(Object.entries(entry?.models ?? {}).map(([id, m]) => [id, m.overallPassRate]));

/** Once the floor holds, shortening runs weekly; nights in between spend nothing. */
export function weeklyShorteningSkip(prior, models, now) {
  const latest = prior.findLast((entry) => entry.status === 'complete' && entry.models);
  if (!floorReached(historyRates(latest), models)) return undefined;
  const last = prior.findLast((entry) => entry.experiment?.mode === 'shorten' && floorReached(historyRates(entry), models));
  if (last && now - Date.parse(last.startedAt) < SHORTENING_INTERVAL_MS) return `skipped: weekly shortening not due (last ${last.startedAt.slice(0, 10)})`;
}

/**
 * D1: pooled paired significance, no per-model net loss, and median tokens per
 * turn may grow at most 2% per pooled percentage point gained, capped at 10%.
 */
export function decideCandidate(pooled, perModel) {
  const gainPoints = pooled.pairedSamples ? 100 * (pooled.gains - pooled.losses) / pooled.pairedSamples : 0;
  const tokenAllowance = Math.min(MAX_TOKEN_GROWTH, TOKEN_GROWTH_PER_POINT * Math.max(gainPoints, 0));
  const tokenGrowth = Object.fromEntries(Object.entries(perModel).map(([id, a]) => [id, a.before ? (a.after - a.before) / a.before : null]));
  const netLoss = Object.entries(perModel).filter(([, a]) => a.losses > a.gains).map(([id]) => id);
  const costly = Object.entries(tokenGrowth).filter(([, growth]) => growth === null || growth > tokenAllowance).map(([id]) => id);
  const percent = (value) => `${(100 * value).toFixed(1)}%`;
  const outcome = !pooled.significant ? 'too little data'
    : netLoss.length ? `rejected: losses exceed gains on ${netLoss.join(', ')}`
    : costly.length ? `rejected: token growth ${costly.map((id) => `${id} ${tokenGrowth[id] === null ? 'unknown' : percent(tokenGrowth[id])}`).join(', ')} above ${percent(tokenAllowance)} allowance`
    : 'propose prompt change';
  return { accepted: outcome === 'propose prompt change', outcome, gainPoints, tokenAllowance, tokenGrowth };
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
    // A directory view derives only names present in this case's file snapshot.
    const ls = /^ls(?: -[a-zA-Z]+)*(?: ([a-zA-Z0-9_./ -]+))?$/.exec(cmd);
    if (ls && Object.keys(state.files ?? {}).length) {
      const views = (ls[1]?.split(/\s+/) ?? ['.']).map(path => {
        const target = [cwd, path === '.' ? '' : path.replace(/^\.\//, '').replace(/\/$/, '')].filter(Boolean).join('/');
        if (Object.hasOwn(state.files, target)) return path + '\n';
        const prefix = target ? target + '/' : '';
        const names = [...new Set(Object.keys(state.files).filter(file => file.startsWith(prefix))
          .map(file => file.slice(prefix.length).split('/')[0]))];
        return names.length ? names.sort().join('\n') + '\n' : undefined;
      });
      if (views.every(v => v !== undefined)) result = { exitCode: 0, stdout: views.join('') };
    }
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

// Rules inspect calls, not tool-result fields. A matching positive action still
// needs its recorded result: an empty acknowledgement must not certify success.
function needsRecordedResult(rule, call) {
  if (!rule) return false;
  if (rule.all || rule.any) return (rule.all ?? rule.any).some(r => needsRecordedResult(r, call));
  if (rule.not || rule.noCall || rule.atMostOnce) return false;
  if (rule.ordered) return rule.ordered.some(r => needsRecordedResult(r, call));
  if (rule.skill) return call.name === rule.beforeRetry || call.name === 'Read' && call.args.file_path === skillPath(rule.skill);
  return rule.call && evaluateRule(rule, { calls: [call], text: '' }).pass;
}

/** Extract complete top-level objects, respecting strings and nested braces. */
export function parseAnswer(raw) {
  try { return { answer: JSON.parse(raw), recovered: false }; } catch {}
  const objects = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (depth && quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (depth && c === '"') quoted = true;
    else if (c === '{') { if (!depth) start = i; depth++; }
    else if (c === '}' && depth && !--depth) {
      try { objects.push(JSON.parse(raw.slice(start, i + 1))); } catch { throw new Error('Malformed replay transcript'); }
    }
  }
  if (depth || objects.length !== 1) throw new Error('Expected one replay answer object');
  return { answer: objects[0], recovered: true };
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
  if (needsRecordedResult(testCase.pass, call) || needsRecordedResult(testCase.truthfulness, call))
    return { result: { error: 'No scenario result recorded for this call' }, boundary: 'missing' };
  const result = command !== undefined ? { exitCode: 0, stdout: '' }
    : call.name === 'Read' ? '' : call.name === 'read' ? []
    : call.name === 'connect' ? { connected: false, apps: [] }
    : ['remember', 'stop', 'open_corner'].includes(call.name) ? { acknowledged: true }
    : {};
  return { result, unrecorded: true };
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
  const messages = [{ role: 'user', content: prompt + '\nFor the response schema, encode each calls[].args as a JSON string containing the tool argument object.' }];
  const transcript = { calls: [], text: '' };
  const requests = [], rounds = [], invalidCalls = [], attemptedCalls = [];
  let tokens = 0, cost = 0, recovered = 0, strict = structured;
  const finish = (status, reason, terminal) => {
    const unsafe = safetyViolation(rule, { ...transcript, calls: attemptedCalls });
    if (unsafe && status === 'incomplete') { status = 'behavior'; reason = unsafe; terminal = 'unsafe-action'; }
    if (invalidCalls.length && !transcript.calls.length && ['final', 'round-limit'].includes(terminal)) {
      status = 'behavior'; reason = 'No valid tool call after validation errors'; terminal = 'invalid-call';
    }
    let verdict = { pass: null, reason };
    if (status === 'behavior') verdict = unsafe || terminal === 'invalid-call'
      ? { pass: false, reason: unsafe ?? reason } : evaluateRule(rule, transcript);
    return { ...verdict, status, terminal, transcript, attemptedCalls, invalidCalls, recovered, tokens, cost, requests, rounds, seed,
      truthfulness: testCase.truthfulness ? evaluateRule(testCase.truthfulness, transcript) : undefined };
  };
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const answerSchema = { type: 'object', properties: { calls: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name', 'args'], additionalProperties: false } }, text: { type: 'string' } }, required: ['calls', 'text'], additionalProperties: false };
    // String-encoded arguments keep the wire schema closed; decoded calls still
    // undergo the original mounted-tool validation below.
    const wireSchema = structuredClone(answerSchema);
    wireSchema.properties.calls.items.properties.args = { type: 'string' };
    const body = { model, messages, seed, provider: { require_parameters: true }, stream: false, max_tokens: MAX_OUTPUT, reasoning: REASONING[model] ?? { enabled: false }, usage: { include: true },
      ...(structured ? { response_format: { type: 'json_schema', json_schema: { name: 'replay_turn', strict, schema: strict ? wireSchema : answerSchema } } } : {}) };
    let response, release;
    try {
      release = ledger.reserve(body);
      try { response = await request(body); }
      catch (error) {
        if (!strict || !/strict|json.?schema|HTTP (400|422)\b/i.test(error.message)) throw error;
        strict = false;
        body.response_format.json_schema = { name: 'replay_turn', strict: false, schema: wireSchema };
        response = await request(body);
      }
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
      const parsed = parseAnswer(raw);
      answer = parsed.answer;
      for (const call of answer?.calls ?? []) if (typeof call.args === 'string') call.args = JSON.parse(call.args);
      if (!validSchema(answerSchema, answer)) throw new Error('Malformed replay transcript');
      if (parsed.recovered) recovered++;
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
    // An observed forbidden action already decides behavior; neutral results
    // must not extend it into unnecessary simulated retries.
    if (safetyViolation(rule, { ...transcript, calls: attemptedCalls })) return finish('behavior', undefined, 'unsafe-action');
    for (const call of validCalls) {
      // These calls end the assigned turn; trailing calls are never silently dropped.
      if (['order', 'report', 'no_reply_needed'].includes(call.name)) {
        if (answer.calls.at(-1) !== call) return { ...finish('behavior', undefined, 'invalid-sequence'), pass: false, reason: 'Calls after terminal action' };
        return finish('behavior', undefined, call.name);
      }
      const result = scenarioResult({ ...testCase, pass: rule }, call, skills);
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
  return { recoveredSamples: rows.reduce((n, r) => n + r.samples.filter(s => s.recovered > 0).length, 0),
    unrecordedCalls: rows.flatMap(r => r.samples.flatMap(s => s.rounds.flatMap(round => round.results ?? []))).filter(r => r.unrecorded).length,
    invalidCalls: rows.reduce((n, r) => n + r.samples.reduce((a, s) => a + s.invalidCalls.length, 0), 0),
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

/** Commit a case/seed only after every model and arm finishes its budgeted turn.
 * Paid partial work remains in interruptedGroups, outside the paired cohort.
 */
export async function replayInterleaved(sources, cases, { models, request, ledger, onCase, onInterrupted }) {
  const names = Object.keys(sources);
  const rows = Object.fromEntries(models.map(model => [model, Object.fromEntries(names.map(name => [name, []]))]));
  let stopped = false;
  for (const testCase of cases) {
    const samples = Object.fromEntries(models.map(model => [model, Object.fromEntries(names.map(name => [name, []]))]));
    for (let index = 0; index < FIXED_SAMPLES; index++) {
      const seed = 1000 + index, group = [];
      if (!stopped) {
        outer: for (const model of models) for (const name of names) {
          const source = sources[name];
          const skills = Object.fromEntries(source.skills.beelineManagedSkills('source', { isReviewer: testCase.session?.reviewer === true })
            .map(skill => [skillPath(skill.name), skill.content]));
          const sample = await replaySample({ prompt: replayPrompt(source, testCase), skills, rule: testCase.pass,
            model, request, ledger, testCase, tools: toolsFor(source, testCase), seed });
          group.push({ model, arm: name, sample });
          if (sample.terminal === 'budget') { stopped = true; onInterrupted?.({ id: testCase.id, seed, attempts: group }); break outer; }
        }
      }
      for (const model of models) for (const name of names) samples[model][name].push(stopped
        ? { status: 'incomplete', terminal: 'budget', reason: 'Replay budget exhausted before complete paired group', pass: null,
            seed, tokens: 0, cost: 0, invalidCalls: [], rounds: [], requests: [], transcript: { calls: [], text: '' } }
        : group.find(g => g.model === model && g.arm === name).sample);
    }
    for (const model of models) for (const name of names) {
      const ss = samples[model][name], stats = proportion(ss);
      const row = { id: testCase.id, section: testCase.section, pass: stats.scored === FIXED_SAMPLES ? stats.proportion > 0.5 : null,
        status: ss.some(s => s.status === 'incomplete') ? 'incomplete' : ss.some(s => s.status === 'format') ? 'format' : 'behavior',
        ...stats, medianTokensPerTurn: median(ss.filter(s => s.tokens > 0).map(s => s.tokens)), samples: ss };
      rows[model][name].push(row);
      onCase?.(model, name, row);
    }
  }
  return rows;
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

/**
 * Squire egress grant: the proxy injects the vaulted key, so this process holds
 * only a capped, revocable grant token. Errors never echo the token or upstream body.
 */
export function grantTransport({ baseUrl, token, timeoutMs = 180_000, fetchImpl = fetch }) {
  if (!/^https?:\/\//.test(baseUrl ?? '')) throw new Error('--grant-base-url must be an http(s) URL');
  if (!token) throw new Error('Grant token file is empty');
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/chat/completions`;
  const redact = (text) => String(text).split(token).join('[redacted]');
  return async (body) => {
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : redact(error?.cause?.code ?? error?.name ?? 'network error');
      throw new Error(`Grant request failed: ${reason}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Grant request failed: HTTP ${response.status}`);
    }
    try { return await response.json(); } catch { throw new Error('Grant request failed: response was not JSON'); }
  };
}

/** A run that dies after starting must not leave result.json at `running`. */
export function markTerminal(out, status, reason) {
  const file = join(out, 'result.json');
  let result = {};
  try { result = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  if (result.status && result.status !== 'running') return;
  mkdirSync(out, { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...result, status, error: reason,
    experiment: { ...result.experiment, outcome: 'incomplete; no proposal' } }, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** Baseline scoring for one model or the pooled cohort; only fully scored cases count. */
export function scoreRows(rows, eligible) {
  const scoredCases = rows.filter(row => row.scored === FIXED_SAMPLES && typeof row.pass === 'boolean').length;
  const passed = scoredCases ? rows.filter(row => row.pass === true).length : null;
  const formatInvalidCases = rows.filter(row => row.samples.some(sample => sample.status === 'format')).length;
  return { passed, scoredCases, formatInvalidCases, unscoredCases: eligible - scoredCases,
    passRate: scoredCases ? passed / scoredCases : null,
    overallPassRate: scoredCases === eligible ? passed / scoredCases : null };
}

const medianTokens = (rows) => median(rows.flatMap((row) => row.samples.filter(sample => sample.tokens > 0).map((sample) => sample.tokens)));
const ARMS = ['baseline', 'control', 'candidate'];

export async function runNightly({ out, history, request, tokenCap, costCap, root = ROOT, label = 'nightly replay', models = DEFAULT_MODELS, candidatePatch, now = Date.now() }) {
  mkdirSync(out, { recursive: true });
  const startedAt = new Date(now).toISOString();
  const workingTreeDiffHash = createHash('sha256').update(execFileSync('git', ['diff', '--no-ext-diff', 'HEAD'], { cwd: root })).digest('hex');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const prior = existsSync(history) ? readFileSync(history, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  // Reject an out-of-scope patch before any paid request.
  const patch = candidatePatch ? validateCandidatePatch(candidatePatch) : undefined;
  const notDue = patch ? undefined : weeklyShorteningSkip(prior, models, now);
  if (notDue) {
    const summary = `Prompt ${label} ${startedAt.slice(0, 10)}: ${notDue}; both models at or above ${100 * PASS_FLOOR}%; no replay, no tokens.`;
    writeFileSync(join(out, 'summary.txt'), `${summary}\n`);
    console.log(summary);
    return { startedAt, status: 'skipped', experiment: { outcome: notDue }, tokens: 0, cost: 0 };
  }
  const allCases = loadCases();
  const skipped = allCases.filter(needsSquire).map(({ id, section }) => ({ id, section, status: 'skipped:squire', reason: 'Requires a Squire browser session; excluded by the nightly cohort policy' }));
  const cases = allCases.filter((testCase) => !needsSquire(testCase));
  const source = await loadSource(root);
  const problems = check(source, allCases);
  if (problems.length) throw new Error(problems.join('\n'));
  // One ledger caps the whole run across both models.
  const ledger = budget(tokenCap, costCap);
  const perModel = Object.fromEntries(models.map((model) => [model, { baseline: [], control: [], candidate: [] }]));
  const result = { startedAt, commit, workingTreeDiffHash, model: models.join(','), schemaVersion: 3, label, status: 'running', caseCount: allCases.length, eligibleCount: cases.length, skipped,
    baseline: [], control: [], candidate: [], experiment: { outcome: 'not run' } };
  // Pooled rows keep case identity per model, so pairing never crosses models.
  const pool = (arm) => models.flatMap((model) => perModel[model][arm].map((row) => ({ ...row, id: `${model}:${row.id}`, model })));
  // Rows are stored once, pooled at the top level; per-model entries hold only summaries.
  const save = () => writeFileSync(join(out, 'result.json'), `${JSON.stringify({ ...result, ...Object.fromEntries(ARMS.map((name) => [name, pool(name)])),
    models: Object.fromEntries(models.map((model) => { const { baseline, control, candidate, ...rest } = perModel[model]; return [model, rest]; })),
    tokens: ledger.tokens, cost: ledger.cost }, null, 2)}\n`);
  const arm = (name, armSource) => Promise.all(models.map(async (model) => {
    perModel[model][name] = await replaySuite(armSource, cases, { model, request, ledger, onCase(row) { perModel[model][name].push(row); save(); } });
  }));
  let temp, candidateText;
  try {
    let candidateSource;
    if (patch) {
      temp = buildCandidateTree(root);
      applyCandidatePatch(temp, candidatePatch);
      candidateSource = await loadSource(temp);
    }
    let interleaved = false;
    if (candidateSource) {
      const invalid = check(candidateSource, allCases);
      if (invalid.length) throw new Error(`Invalid candidate: ${invalid.join('; ')}`);
      result.interruptedGroups = [];
      await replayInterleaved({ baseline: source, control: source, candidate: candidateSource }, cases, {
        models, request, ledger,
        onCase(model, name, row) { perModel[model][name].push(row); save(); },
        onInterrupted(group) { result.interruptedGroups.push(group); save(); },
      });
      interleaved = true;
    } else {
      // D2 chooses a shortening only after the full baseline reveals protected sections.
      await arm('baseline', source);
      await arm('control', source);
    }
    for (const model of models) perModel[model].noise = assessExperiment(perModel[model].baseline, perModel[model].baseline, perModel[model].control);
    result.noise = assessExperiment(pool('baseline'), pool('baseline'), pool('control'));
    const rates = Object.fromEntries(models.map((model) => [model, scoreRows(perModel[model].baseline, cases.length).passRate]));
    // The floor needs every eligible case scored on every model.
    const fullRates = Object.fromEntries(models.map((model) => [model, scoreRows(perModel[model].baseline, cases.length).overallPassRate]));
    result.floorReached = floorReached(fullRates, models);
    const mode = chooseMode({ patch, rates: fullRates, models });
    let block;
    if (mode === 'audit') result.experiment = { mode, outcome: 'running', patch: { paths: patch.paths, sha256: patch.sha256 } };
    else if (mode === 'shorten') {
      const text = readFileSync(join(root, SOURCE), 'utf8');
      const lastBlock = prior.findLast((entry) => entry.experiment?.block)?.experiment.block.id;
      block = chooseBlock(removalBlocks(text), models.flatMap((model) => perModel[model].baseline), allCases, lastBlock, skipped);
      if (block) {
        result.experiment = { mode, outcome: 'running', block };
        temp = buildCandidateTree(root);
        candidateText = text.slice(0, block.start) + "''" + text.slice(block.end);
        writeFileSync(join(temp, SOURCE), candidateText);
        candidateSource = await loadSource(temp);
      } else result.experiment = { mode, outcome: 'skipped: all blocks protected by failing cases' };
    } else result.experiment = { mode, outcome: 'skipped: no audit candidate' };
    if (candidateSource) {
      const invalid = check(candidateSource, allCases);
      if (invalid.length) result.experiment.outcome = `rejected: ${invalid.join('; ')}`;
      else {
        if (!interleaved) await arm('candidate', candidateSource);
        const pooled = assessExperiment(pool('baseline'), pool('candidate'), pool('control'));
        for (const model of models) {
          const assessment = assessExperiment(perModel[model].baseline, perModel[model].candidate, perModel[model].control);
          perModel[model].experiment = { gains: assessment.gains, losses: assessment.losses, before: assessment.before, after: assessment.after,
            passRateBefore: rates[model], passRateAfter: scoreRows(perModel[model].candidate, cases.length).passRate };
        }
        const modelExperiments = Object.fromEntries(models.map((model) => [model, perModel[model].experiment]));
        let decision;
        if (mode === 'audit') decision = decideCandidate(pooled, modelExperiments);
        else {
          // Shortening keeps both models at or above the floor.
          const kept = floorReached(Object.fromEntries(models.map((model) => [model, scoreRows(perModel[model].candidate, cases.length).overallPassRate])), models);
          decision = { accepted: pooled.accepted && kept, outcome: pooled.accepted && !kept ? `rejected: below ${100 * PASS_FLOOR}% floor` : pooled.outcome };
        }
        result.experiment = { ...result.experiment, ...pooled, ...decision, perModel: modelExperiments };
        if (decision.accepted) {
          const rows = models.map((model) => {
            const e = modelExperiments[model];
            const rate = (value) => value === null ? 'unscored' : `${(100 * value).toFixed(1)}%`;
            return `| ${model} | ${rate(e.passRateBefore)} | ${rate(e.passRateAfter)} | ${e.gains} | ${e.losses} | ${e.before} | ${e.after} |`;
          }).join('\n');
          const change = mode === 'audit' ? `Apply the audited prompt change in candidate.patch (sha256 ${patch.sha256}); its reasons per failing case are in the run's audit.md.` : `Remove one prompt paragraph (${block.id}).`;
          if (mode === 'audit') writeFileSync(join(out, 'candidate.patch'), patch.text);
          else writeFileSync(join(out, 'prompt-assembly.ts'), candidateText);
          writeFileSync(join(out, 'proposal.md'), `${mode === 'audit' ? 'Improve the agent prompt after nightly replay' : 'Remove one prompt paragraph after weekly replay'}\n\n## Reproduced\nNot a defect report. ${change} Run on ${commit}, models ${models.join(', ')}.\n\n## Demonstrated\nReplayed all ${cases.length} eligible cases per model on baseline, unchanged control and candidate with fixed paired seeds.\n\n| Model | Baseline pass rate | Candidate pass rate | Gains | Losses | Median tokens/turn before | After |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows}\n\nPooled paired test: ${pooled.gains} gains, ${pooled.losses} losses over ${pooled.pairedSamples} samples; p ${pooled.effectPValue.toExponential(2)} against baseline, ${pooled.excessPValue.toExponential(2)} against control. Decision: ${decision.outcome}. Total replay tokens: ${ledger.tokens}; cost: $${ledger.cost.toFixed(6)}.\n\nNormal independent review and merge authority still apply. The run artifact contains per-case samples and accounting.\n`);
        }
      }
    }
    for (const model of models) perModel[model].experiment ??= { outcome: result.experiment.outcome };
    result.status = models.some((model) => ARMS.some((name) => perModel[model][name].some(r => r.samples.some(s => s.status === 'incomplete')))) ? 'incomplete' : 'complete';
  } catch (error) {
    result.status = 'incomplete';
    result.error = error.message;
    result.experiment.outcome = 'incomplete; no proposal';
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
    for (const name of ARMS) result[name] = pool(name);
    save();
  }
  result.pairing = {
    completeCases: result.baseline.filter(row => ARMS.every(name => result[name].find(r => r.id === row.id)?.samples.length === FIXED_SAMPLES &&
      result[name].find(r => r.id === row.id).samples.every(s => s.terminal !== 'budget'))).length,
    scoredSamples: result.baseline.reduce((n, row) => n + row.samples.filter((s, index) => ARMS.every(name => {
      const other = result[name].find(r => r.id === row.id)?.samples[index];
      return other?.status === 'behavior' && other.seed === s.seed;
    })).length, 0),
  };
  result.classes = Object.fromEntries(ARMS.map(name => [name, classCounts(result[name])]));
  result.diagnostics = Object.fromEntries(ARMS.map(name => [name, diagnostics(result[name])]));
  result.scoring = scoreRows(result.baseline, cases.length * models.length);
  const modelSummaries = Object.fromEntries(models.map((model) => {
    const scoring = scoreRows(perModel[model].baseline, cases.length);
    perModel[model].scoring = scoring;
    perModel[model].classes = Object.fromEntries(ARMS.map(name => [name, classCounts(perModel[model][name])]));
    return [model, { passed: scoring.passed, scoredCases: scoring.scoredCases, unscoredCases: scoring.unscoredCases, passRate: scoring.passRate, overallPassRate: scoring.overallPassRate,
      medianTokensPerTurn: medianTokens(perModel[model].baseline), experiment: perModel[model].experiment }];
  }));
  save();
  const total = medianTokens(result.baseline);
  const { passed, scoredCases, formatInvalidCases } = result.scoring;
  const rate = scoredCases
    ? `${passed}/${scoredCases} pooled behavior-scored cases passed (${(100 * result.scoring.passRate).toFixed(1)}%); ${formatInvalidCases} format-invalid cases; ${result.scoring.unscoredCases} unscored cases${result.scoring.overallPassRate === null ? '; overall pass rate unavailable' : ''}`
    : `no behavior verdicts (${formatInvalidCases} format-invalid cases); behavior pass rate unavailable; ${result.scoring.unscoredCases} unscored cases; overall pass rate unavailable`;
  const perModelRates = models.map((model) => {
    const m = modelSummaries[model];
    return `${model.replace(/^.*\//, '')} ${m.scoredCases ? `${m.passed}/${m.scoredCases} (${(100 * m.passRate).toFixed(1)}%)` : 'unscored'}`;
  }).join(', ');
  const diagnosticCounts = Object.fromEntries(Object.entries(result.diagnostics).map(([name, d]) => [name, { invalidCalls: d.invalidCalls, scenarioIncomplete: d.scenarioIncomplete, recoveredSamples: d.recoveredSamples, unrecordedCalls: d.unrecordedCalls }]));
  const reasons = Object.entries(result.diagnostics).flatMap(([name, d]) => {
    const groups = new Map();
    for (const s of d.incomplete) {
      const key = `${s.terminal}: ${s.reason}${s.call ? ` (${JSON.stringify(s.call)})` : ''}`;
      const group = groups.get(key) ?? [];
      group.push(`${s.id}@${s.seed}`); groups.set(key, group);
    }
    return [...groups].map(([reason, ids]) => `${name} incomplete — ${reason}: ${ids.join(', ')}`);
  });
  const experimentName = result.experiment.block?.id ?? (result.experiment.patch ? `patch ${result.experiment.patch.paths.join(', ')}` : 'none');
  const summary = `Prompt ${label} ${startedAt.slice(0, 10)}: ${result.status}; complete three-arm cases ${result.pairing.completeCases}/${cases.length * models.length}, scored triplets ${result.pairing.scoredSamples}; baseline ${perModelRates}; ${result.floorReached ? `both models at or above ${100 * PASS_FLOOR}%` : `below ${100 * PASS_FLOOR}% floor`}; ${rate}; ${skipped.length} skipped:squire; sample classes ${JSON.stringify(result.classes)}; diagnostics ${JSON.stringify(diagnosticCounts)}; control noise flips ${result.noise?.noiseFlips ?? 'unavailable'}/${result.noise?.noisePairs ?? 'unavailable'}; detectable effect (80% power approximation) ${result.noise?.detectableEffect ?? 'unavailable'}; median ${total ?? 'unknown'} tokens/turn; ${ledger.tokens} total tokens, $${ledger.cost.toFixed(6)}; experiment ${experimentName}: ${result.experiment.outcome}${result.error ? `; ${result.error}` : ''}.\n${reasons.join('\n')}`;
  writeFileSync(join(out, 'summary.txt'), `${summary}\n`);
  mkdirSync(dirname(history), { recursive: true });
  appendFileSync(history, `${JSON.stringify({ schemaVersion: 3, pairing: result.pairing, classes: result.classes, diagnostics: result.diagnostics, noise: result.noise, startedAt, commit, model: result.model, status: result.status, ...result.scoring, cases: cases.length, skipped, medianTokensPerTurn: total,
    tokens: ledger.tokens, cost: ledger.cost, perCase: result.baseline.map(({ id, model, pass, medianTokensPerTurn, proportion, interval, scored }) => ({ id, model, pass, medianTokensPerTurn, proportion, interval, scored })),
    floorReached: Boolean(result.floorReached), models: modelSummaries, experiment: result.experiment })}\n`);
  console.log(summary);
  return { ...result, models: perModel, tokens: ledger.tokens, cost: ledger.cost };
}

export async function runCli(args, { run = runNightly } = {}) {
  const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
  const out = resolve(option('--out', '.scratch/prompt-nightly/latest'));
  const history = resolve(option('--history', '.scratch/prompt-nightly/history.jsonl'));
  const exchange = option('--exchange');
  const grantBaseUrl = option('--grant-base-url'), grantTokenFile = option('--grant-token-file');
  const grant = grantBaseUrl !== undefined || grantTokenFile !== undefined;
  if (Boolean(exchange) === grant) throw new Error('Use exactly one transport: --exchange <dir>, or --grant-base-url <url> with --grant-token-file <path>');
  let request;
  if (grant) {
    if (!grantBaseUrl || !grantTokenFile) throw new Error('--grant-base-url and --grant-token-file are required together');
    if (statSync(grantTokenFile).mode & 0o077) throw new Error('Grant token file must be readable only by its owner (chmod 600)');
    request = grantTransport({ baseUrl: grantBaseUrl, token: readFileSync(grantTokenFile, 'utf8').trim() });
  } else request = fileTransport(resolve(exchange));
  const tokenCap = Number(option('--token-cap', DEFAULT_TOKEN_CAP));
  const costCap = Number(option('--cost-cap', DEFAULT_COST_CAP));
  if (![tokenCap, costCap].every((value) => Number.isFinite(value) && value > 0)) throw new Error('Budgets must be positive finite numbers');
  const models = option('--models', DEFAULT_MODELS.join(',')).split(',').map((model) => model.trim()).filter(Boolean);
  if (!models.length) throw new Error('--models needs at least one model');
  const patch = option('--candidate-patch');
  // SIGKILL cannot be caught; every other exit records why the run stopped.
  const signals = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 };
  const onSignal = (signal) => { markTerminal(out, 'killed', `Controller received ${signal}`); process.exit(signals[signal]); };
  for (const signal of Object.keys(signals)) process.on(signal, onSignal);
  try {
    const result = await run({ out, history, request, tokenCap, costCap, models,
      candidatePatch: patch && resolve(patch), label: option('--label', 'nightly replay') });
    if (!['complete', 'skipped'].includes(result.status)) process.exitCode = 1;
    return result;
  } catch (error) {
    markTerminal(out, 'failed', `Controller error: ${error?.message ?? error}`);
    throw error;
  } finally {
    for (const signal of Object.keys(signals)) process.off(signal, onSignal);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runCli(process.argv.slice(2));
