/** Subscription-only Codex/MCP replay. All advertised operations are canned. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { loadCases, loadSource, replayPrompt, toolsFor } from './prompt-cases.ts';
import { evaluateRule, skillPath } from './prompt-case-rules.ts';
import { median, needsSquire } from './prompt-nightly.mjs';
import { deniesAvailableTool } from './prompt-tool-loading.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIGS = join(ROOT, 'scripts/prompt-variants');
const p90 = values => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.9) - 1] : null;
export function loadSplit(cases) {
  const split = JSON.parse(readFileSync(join(CONFIGS, 'split.json'), 'utf8'));
  const eligible = cases.filter(c => !needsSquire(c)).map(c => c.id).sort();
  const actual = [...split.tune, ...split.heldout].sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(eligible)) throw new Error('Frozen split differs from eligible cohort; do not silently repartition');
  return split;
}
export function nativePrompt(source, testCase, variant, tools, seed) {
  const original = replayPrompt(source, testCase);
  // Keep the assembled scenario, skills and rules; replace only the JSON emulator protocol.
  let prompt = original.slice(original.indexOf('## System prompt'));
  const begin = prompt.indexOf('## Tools\n'), end = prompt.indexOf('## Available skills\n');
  if (begin < 0 || end < begin) throw new Error('Replay tool section missing');
  prompt = prompt.slice(0, begin) + prompt.slice(end);
  for (const edit of variant.promptEdits ?? []) {
    if (!prompt.includes(edit.from)) throw new Error(`Variant edit not found: ${edit.from.slice(0, 60)}`);
    prompt = prompt.replaceAll(edit.from, edit.to);
  }
  const index = variant.mode === 'deferred' ? '\n## Deferred tool index\n' + tools.filter(t => !variant.core.includes(t.name)).map(t =>
    `${t.name}: ${variant.purposes?.[t.name] ?? t.description.split(/\s+/).slice(0, variant.indexWords ?? 14).join(' ')}`).join('\n') : '';
  return `Replay seed: ${seed}. You are the agent described in this scenario for one simulated turn.\n` +
    'Use only the replay MCP tools. Their operations are simulations and never affect real services. Call the actual MCP tools, rather than printing proposed calls as JSON. Treat their results as recorded scenario facts. End when the assigned turn ends or a boundary is returned. Never use native host tools.\n' +
    (variant.mode === 'deferred' ? 'All indexed tools are available: use find_tools to load a noncore definition, wait for its result, then call the newly available MCP tool. Loaded definitions persist only for this sample.\n' : '') +
    prompt + index + '\n' + (variant.appendRules ?? '');
}
function unsafe(rule, calls) {
  if (rule.all) return rule.all.map(r => unsafe(r, calls)).find(Boolean);
  if ('noCall' in rule || 'atMostOnce' in rule || rule.not?.call) {
    const verdict = evaluateRule(rule, { calls, text: '' });
    if (!verdict.pass) return verdict.reason;
  }
}
export function gradeNative(testCase, trace, events, variant, tools) {
  const text = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item.text).join('\n');
  const transcript = { calls: trace.calls, text };
  const violation = unsafe(testCase.pass, trace.attemptedCalls);
  const finished = events.some(e => e.type === 'turn.completed');
  const infrastructureError = events.some(e => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call' && /requires approval|startup failed|transport closed/i.test(e.item.error?.message ?? ''));
  const escaped = events.some(e => e.type === 'item.completed' && ['command_execution', 'file_change', 'web_search'].includes(e.item?.type));
  const failure = violation ?? trace.failure ?? (finished && trace.invalidCalls.length && !trace.calls.length ? 'No valid tool call after validation errors' : undefined) ?? (escaped ? 'Native tool outside simulator' : undefined) ??
    (variant.mode === 'deferred' && deniesAvailableTool(text, tools) ? 'Denied an available tool instead of loading it' : undefined);
  const status = failure ? 'behavior' : infrastructureError || !finished || ['missing', 'call-limit'].includes(trace.terminal) ? 'incomplete' : 'behavior';
  const verdict = failure ? { pass: false, reason: failure } : status === 'behavior' ? evaluateRule(testCase.pass, transcript) :
    { pass: null, reason: trace.terminal === 'missing' ? 'Missing scenario fact' : 'Codex did not complete the simulated turn' };
  return { ...verdict, status, transcript, terminal: trace.terminal, attemptedCalls: trace.attemptedCalls, invalidCalls: trace.invalidCalls,
    searches: trace.searches, results: trace.results };
}
export function codexArgs(model, cwd, fixture, trace) {
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '-C', cwd, '-s', 'read-only', '-m', model, '--json'];
  for (const feature of ['shell_tool', 'apps', 'plugins', 'multi_agent', 'browser_use', 'image_generation', 'view_image', 'sleep_tool', 'hooks']) args.push('--disable', feature);
  for (const setting of ['web_search="disabled"', 'forced_login_method="chatgpt"', 'features.skip_host_skill_discovery=true',
    'features.mcp_tool_list_changed=true', 'features.tool_suggest=false', 'model_reasoning_effort="low"',
    'mcp_servers.replay.command="node"',
    `mcp_servers.replay.args=${JSON.stringify(['--import', 'tsx', join(ROOT, 'scripts/prompt-replay-stub.mjs'), fixture, trace])}`,
    `mcp_servers.replay.cwd=${JSON.stringify(ROOT)}`]) args.push('-c', setting);
  return [...args, '-'];
}
export async function executeSample({ source, testCase, variant, model, directory, seed = 1000, timeoutMs = 180000 }) {
  mkdirSync(directory, { recursive: true });
  const cwd = mkdtempSync(join(tmpdir(), 'beeline-codex-replay-'));
  const fixture = join(directory, 'fixture.json'), tracePath = join(directory, 'trace.json');
  const tools = toolsFor(source, testCase);
  const skills = Object.fromEntries(source.skills.beelineManagedSkills('source', { isReviewer: testCase.session?.reviewer === true })
    .map(s => [skillPath(s.name), s.content]));
  writeFileSync(fixture, JSON.stringify({ testCase, tools, skills, variant }));
  const prompt = nativePrompt(source, testCase, variant, tools, seed);
  writeFileSync(join(directory, 'prompt.txt'), prompt);
  const events = [], errors = [];
  let pending = '', exitCode, timedOut = false;
  const env = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY']) delete env[key];
  const child = spawn('codex', codexArgs(model, cwd, fixture, tracePath), { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
  child.stdout.on('data', chunk => {
    pending += chunk;
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines) { try { events.push(JSON.parse(line)); } catch { errors.push('Invalid Codex JSONL event'); } }
  });
  child.stderr.on('data', chunk => errors.push(String(chunk)));
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  try { exitCode = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done); }); }
  finally { clearTimeout(timer); rmSync(cwd, { recursive: true, force: true }); }
  writeFileSync(join(directory, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(directory, 'stderr.txt'), errors.join(''));
  const trace = existsSync(tracePath) ? JSON.parse(readFileSync(tracePath)) : { calls: [], attemptedCalls: [], invalidCalls: [], searches: [], results: [], terminal: null };
  const sample = gradeNative(testCase, trace, events, variant, tools);
  const usage = events.findLast(e => e.type === 'turn.completed')?.usage;
  const error = events.filter(e => ['error', 'turn.failed'].includes(e.type)).map(e => e.message ?? e.error?.message ?? JSON.stringify(e)).join('\n');
  const stopped = /usage limit|rate limit|quota|not supported|unsupported|does not exist|not available|not found|not authorized|access to.*model|insufficient/i.test(error);
  return { ...sample, seed, exitCode, timedOut, error: error || (timedOut ? 'Codex replay timeout' : undefined), modelStopped: stopped,
    inputTokens: usage?.input_tokens ?? null, cachedInputTokens: usage?.cached_input_tokens ?? null, outputTokens: usage?.output_tokens ?? null,
    toolCalls: trace.attemptedCalls.length, searchCalls: trace.searches.length,
    // Codex exposes aggregate turn usage, not the count of underlying model requests.
    modelRequests: null };
}
export function summarize(rows) {
  const scored = rows.filter(r => r.status === 'behavior'), inputs = rows.map(r => r.inputTokens).filter(Number.isFinite);
  return { passed: scored.filter(r => r.pass).length, scored: scored.length, unscored: rows.length - scored.length,
    passRate: scored.length ? scored.filter(r => r.pass).length / scored.length : null,
    medianInputTokens: median(inputs), p90InputTokens: p90(inputs), inputAccountingSamples: inputs.length,
    meanSearchCalls: rows.length ? rows.reduce((n, r) => n + r.searchCalls, 0) / rows.length : null };
}
export function frontier(variants) {
  const comparable = variants.filter(v => v.complete && !v.regressionModels.length);
  return comparable.filter(v => !comparable.some(o => o.meanPassRate > v.meanPassRate && o.medianInputTokens < v.medianInputTokens));
}
export async function runSubscription(args) {
  const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  const model = option('--model');
  if (!['gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.6-terra'].includes(model)) throw new Error('Select an assigned subscription model with --model');
  const partition = option('--partition', 'tune');
  if (!['tune', 'heldout'].includes(partition)) throw new Error('--partition must be tune or heldout');
  if (partition === 'heldout') {
    const selection = option('--selection');
    if (!selection) throw new Error('Held-out replay requires a frozen --selection file from the final tune frontier');
    const final = JSON.parse(readFileSync(resolve(selection), 'utf8'));
    const names = option('--variants', 'full,r0-deferred').split(',');
    if (final.phase !== 'final' || !names.every(name => final.variants.includes(name))) throw new Error('Variant is outside the frozen final selection');
  }
  const out = resolve(option('--out', '.beeline-proof/subscription-replay'));
  const all = loadCases(), split = loadSplit(all);
  const only = option('--only');
  if (only && partition !== 'tune') throw new Error('--only is restricted to tune-set smoke proofs');
  const cases = all.filter(c => split[partition].includes(c.id) && (!only || only.split(',').includes(c.id)));
  if (!cases.length) throw new Error('No cases selected');
  const variants = option('--variants', 'full,r0-deferred').split(',').map(name => {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid variant name');
    const variant = JSON.parse(readFileSync(join(CONFIGS, `${name}.json`), 'utf8'));
    if (variant.name !== name || !['full', 'deferred'].includes(variant.mode)) throw new Error('Invalid variant config');
    return variant;
  });
  if (variants.length > (partition === 'tune' ? 3 : 4)) throw new Error('Too many variants for this round');
  const source = await loadSource(ROOT);
  mkdirSync(out, { recursive: true });
  const result = { status: 'running', model, partition, splitSeed: split.seed, sampleSeed: split.caseSeed,
    seedLimitation: 'Codex exec has no provider seed flag; one fresh sample uses the same replay seed tag and fixed case partition/order for every variant.',
    usageNote: 'Codex harness instructions and tool definitions are included in all reported input tokens.',
    costUsd: 0, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    splitHash: createHash('sha256').update(JSON.stringify(split)).digest('hex'), expectedCases: cases.length,
    smokeOnly: Boolean(only), variants: Object.fromEntries(variants.map(v => [v.name, { config: v, rows: [] }])) };
  const save = () => { for (const v of Object.values(result.variants)) v.summary = summarize(v.rows); writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n'); };
  save();
  const terminal = signal => { result.status = 'killed'; result.error = signal; save(); process.exit(1); };
  process.once('SIGTERM', terminal); process.once('SIGINT', terminal);
  try {
    for (const testCase of cases) for (const variant of variants) {
      const directory = join(out, variant.name, testCase.id);
      const cached = join(directory, 'sample.json');
      let row;
      if (existsSync(cached)) {
        const saved = JSON.parse(readFileSync(cached));
        if (saved.configHash !== createHash('sha256').update(JSON.stringify(variant)).digest('hex') || saved.model !== model || saved.partition !== partition) throw new Error('Existing sample has a different model, partition or variant; use a fresh output directory');
        row = saved;
      } else {
        row = { id: testCase.id, model, partition, configHash: createHash('sha256').update(JSON.stringify(variant)).digest('hex'),
          ...await executeSample({ source, testCase, variant, model, directory, seed: split.caseSeed }) };
        writeFileSync(cached, JSON.stringify(row, null, 2) + '\n');
      }
      result.variants[variant.name].rows.push(row); save();
      console.log(JSON.stringify({ model, partition, variant: variant.name, id: row.id, pass: row.pass, status: row.status, inputTokens: row.inputTokens, error: row.error }));
      if (row.modelStopped) { result.error = row.error; result.status = 'model-stopped'; save(); return result; }
    }
    result.status = Object.values(result.variants).some(v => v.rows.some(r => r.status !== 'behavior')) ? 'incomplete' : 'complete';
  } catch (error) { result.status = 'failed'; result.error = error.message; }
  finally { process.off('SIGTERM', terminal); process.off('SIGINT', terminal); save(); }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runSubscription(process.argv.slice(2));
  if (result.status !== 'complete') process.exitCode = 1;
}
