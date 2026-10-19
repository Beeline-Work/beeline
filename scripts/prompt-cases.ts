/**
 * Replays the saved prompt behavior cases in `docs/prompts/cases/` against a
 * real model. Run with `node --import tsx scripts/prompt-cases.ts`.
 *
 *   --check                 offline: validate every case, assemble its prompt,
 *                           and require one case per prompt section; no model.
 *   --baseline-root <dir>   a checkout of the target branch. A case that fails
 *                           here and is unchanged there is replayed against that
 *                           checkout's prompt; failing there too, it is reported
 *                           as already failing instead of as a regression.
 *   --only <id,id>          replay only these cases.
 *   --samples <n>           samples per case (default 3).
 *   --need <n>              passing samples a case needs (default 2).
 *
 * Each case builds the session and turn prompt with the real assembler
 * (`apps/body/src/prompt-assembly.ts`) and the real tool descriptions
 * (`apps/body/src/minimal-tool-surface.ts`), sends the turn to the model
 * through OpenRouter, answers tool calls with stub results for up to four
 * steps, and evaluates the case's pass rule on every call and all text.
 *
 * Environment: OPENROUTER_API_KEY (required unless --check),
 * PROMPT_CASES_MODEL (default anthropic/claude-sonnet-5.5),
 * PROMPT_CASES_BASE_URL (default https://openrouter.ai/api/v1).
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as Assembly from '../apps/body/src/prompt-assembly.js';
import type * as ToolSurface from '../apps/body/src/minimal-tool-surface.js';
import {
  NATIVE_TOOL_NAMES,
  caseOutcome,
  evaluateRule,
  parsePromptCase,
  type PromptCase,
  type ToolCall,
  type Transcript,
} from './prompt-case-rules.js';

// Root CommonJS scripts have no import.meta; this file always runs by path.
const repoRoot = resolve(dirname(process.argv[1]!), '..');
const casesDir = join(repoRoot, 'docs', 'prompts', 'cases');
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const SAMPLES = Number(option('--samples') ?? 3);
const NEED = Number(option('--need') ?? 2);
const MAX_STEPS = 4;
const CONCURRENCY = 6;
const MODEL = process.env.PROMPT_CASES_MODEL || 'anthropic/claude-sonnet-5.5';
const BASE_URL = (process.env.PROMPT_CASES_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const SILENT_TOOL_NAME = 'no_reply_needed';
// Fixed so a case's prompt does not change with the runner's own host.
const FIXED_MEMORY_MAX_BYTES = 32 * 1024 ** 3;

type ToolDefinition = ToolSurface.ToolDefinition;

interface PromptSource {
  readonly label: string;
  readonly assembly: typeof Assembly;
  readonly tools: typeof ToolSurface;
}

async function loadSource(root: string, label: string): Promise<PromptSource> {
  const load = (file: string) => import(pathToFileURL(join(root, 'apps', 'body', 'src', file)).href);
  return { label, assembly: await load('prompt-assembly.ts'), tools: await load('minimal-tool-surface.ts') };
}

const NATIVE_TOOLS: Record<(typeof NATIVE_TOOL_NAMES)[number], ToolDefinition> = {
  Bash: {
    name: 'Bash',
    description: 'Executes a bash command on this machine and returns its output.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command to execute' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
  operate_drive: {
    name: 'operate_drive',
    description: 'Trusty Squire: drive a real browser toward a multi-step goal (signup, checkout, provisioning) from a start URL, using the given facts. Hands back low_confidence or needs_value when it needs help.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, goal: { type: 'string' }, facts: { type: 'object' }, session_id: { type: 'string' } },
      required: ['goal'],
    },
  },
  operate_click: {
    name: 'operate_click',
    description: 'Trusty Squire: click one element in the current browser session.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, target: { type: 'string' } }, required: ['target'] },
  },
  operate_navigate: {
    name: 'operate_navigate',
    description: 'Trusty Squire: open a URL in a browser session.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, url: { type: 'string' } }, required: ['url'] },
  },
};

/** The ordinary agent surface (`agentToolsFor` with a command runner and proven native I/O), plus the case's extras. */
function toolsFor(source: PromptSource, testCase: PromptCase): ToolDefinition[] {
  const extras = testCase.tools ?? [];
  return [
    ...source.tools.minimalTools(testCase.place.endsWith('corner')),
    source.tools.RUNNER_TOOL,
    ...(extras.includes(SILENT_TOOL_NAME) ? [source.tools.SILENT_TOOL] : []),
    ...NATIVE_TOOL_NAMES.filter((name) => extras.includes(name)).map((name) => NATIVE_TOOLS[name]),
  ];
}

function briefFrom(value: unknown): Assembly.SessionPromptContext['brief'] {
  if (!value || typeof value !== 'object') return undefined;
  return {
    id: 'case-corner',
    revision: 1,
    authorId: 'case-author',
    sourceRoomId: 'case-room',
    attachments: [],
    ...(value as object),
  } as unknown as Assembly.SessionPromptContext['brief'];
}

function assemble(source: PromptSource, testCase: PromptCase) {
  const brief = briefFrom(testCase.session?.brief);
  const session = source.assembly.assembleSessionPrompt({
    agentName: 'Ruby',
    agentCommand: 'claude-agent-acp',
    memoryMaxBytes: FIXED_MEMORY_MAX_BYTES,
    ...testCase.session,
    brief,
    surface: testCase.place,
  } as Assembly.SessionPromptContext);
  const turnBrief = testCase.turn.brief as { fileLines?: string[]; missingRequiredFile?: boolean } | undefined;
  const turn = source.assembly.assembleTurnPrompt({
    ...testCase.turn,
    surface: testCase.place,
    sessionPrefix: session.turnPrefix,
    brief: brief
      ? { brief, fileLines: turnBrief?.fileLines ?? [], missingRequiredFile: turnBrief?.missingRequiredFile ?? false }
      : undefined,
    transcript: testCase.messages?.length ? { lines: testCase.messages, sinceLastTurn: false } : undefined,
  } as Assembly.TurnPromptContext);
  return {
    system: session.systemPrompt && !session.turnPrefix ? session.systemPrompt : '',
    user: turn.text,
    sections: [...session.report, ...turn.report].map((section) => section.id),
  };
}

function loadCases(): PromptCase[] {
  const known = [SILENT_TOOL_NAME, ...NATIVE_TOOL_NAMES];
  return readdirSync(casesDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => parsePromptCase(JSON.parse(readFileSync(join(casesDir, file), 'utf8')), file.replace(/\.json$/, ''), known));
}

function check(source: PromptSource, cases: readonly PromptCase[]): string[] {
  const problems: string[] = [];
  const sectionIds = [...source.assembly.SESSION_SECTIONS, ...source.assembly.TURN_SECTIONS].map((section) => section.id);
  for (const id of sectionIds) {
    if (!cases.some((testCase) => testCase.section === id)) problems.push(`section ${id} has no saved case`);
  }
  for (const testCase of cases) {
    if (!sectionIds.includes(testCase.section)) {
      problems.push(`case ${testCase.id}: section ${testCase.section} does not exist`);
      continue;
    }
    try {
      const prompt = assemble(source, testCase);
      if (!prompt.sections.includes(testCase.section)) {
        problems.push(`case ${testCase.id}: its prompt does not render section ${testCase.section}`);
      }
    } catch (error) {
      problems.push(`case ${testCase.id}: ${(error as Error).message}`);
    }
  }
  return problems;
}

type ChatMessage = Record<string, unknown>;

async function chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<{ content: string; calls: Array<{ id: string; name: string; args: string }> }> {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 2_000,
    messages,
    tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
  });
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(180_000),
    }).catch((error: Error) => ({ ok: false, status: 0, text: async () => error.message }) as const);
    const text = await response.text();
    if (response.ok) {
      const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>; error?: { message?: string } };
      const message = parsed.choices?.[0]?.message;
      if (message) {
        return {
          content: message.content ?? '',
          calls: (message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, args: call.function.arguments || '{}' })),
        };
      }
      if (attempt >= 4) throw new Error(`model returned no message: ${text.slice(0, 300)}`);
    } else if (attempt >= 4 || ![0, 408, 429, 500, 502, 503, 504, 529].includes(response.status)) {
      throw new Error(`model request failed (${response.status}): ${text.slice(0, 300)}`);
    }
    await new Promise((done) => setTimeout(done, 2_000 * 2 ** attempt));
  }
}

async function replay(source: PromptSource, testCase: PromptCase): Promise<Transcript> {
  const prompt = assemble(source, testCase);
  const tools = toolsFor(source, testCase);
  const messages: ChatMessage[] = [
    ...(prompt.system ? [{ role: 'system', content: prompt.system }] : []),
    { role: 'user', content: prompt.user },
  ];
  const calls: ToolCall[] = [];
  const text: string[] = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const answer = await chat(messages, tools);
    if (answer.content.trim()) text.push(answer.content.trim());
    if (!answer.calls.length) break;
    messages.push({
      role: 'assistant',
      content: answer.content || null,
      tool_calls: answer.calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.args } })),
    });
    for (const call of answer.calls) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(call.args) as Record<string, unknown>;
      } catch {
        parsed = { unparsed: call.args };
      }
      calls.push({ name: call.name, args: parsed });
      messages.push({ role: 'tool', tool_call_id: call.id, content: testCase.toolResults?.[call.name] ?? '{"ok":true}' });
    }
    if (answer.calls.some((call) => call.name === SILENT_TOOL_NAME)) break;
  }
  return { calls, text: text.join('\n\n') };
}

interface CaseResult {
  readonly id: string;
  readonly outcome: 'pass' | 'fail' | 'error';
  readonly passed: number;
  readonly sampled: number;
  readonly reasons: readonly string[];
}

async function runCase(source: PromptSource, testCase: PromptCase): Promise<CaseResult> {
  const samples: boolean[] = [];
  const reasons: string[] = [];
  try {
    while (caseOutcome(samples, SAMPLES, NEED) === 'open') {
      const verdict = evaluateRule(testCase.pass, await replay(source, testCase));
      samples.push(verdict.pass);
      if (!verdict.pass) reasons.push(verdict.reason);
    }
  } catch (error) {
    return { id: testCase.id, outcome: 'error', passed: samples.filter(Boolean).length, sampled: samples.length, reasons: [...reasons, (error as Error).message] };
  }
  const outcome = caseOutcome(samples, SAMPLES, NEED) === 'pass' ? 'pass' : 'fail';
  return { id: testCase.id, outcome, passed: samples.filter(Boolean).length, sampled: samples.length, reasons };
}

async function runAll(source: PromptSource, cases: readonly PromptCase[]): Promise<CaseResult[]> {
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, cases.length) }, async () => {
      while (next < cases.length) {
        const index = next++;
        const result = await runCase(source, cases[index]!);
        results[index] = result;
        console.log(`${result.outcome.toUpperCase().padEnd(5)} ${result.id} (${result.passed}/${result.sampled}, ${source.label})${result.outcome === 'pass' ? '' : `\n      ${result.reasons.join('\n      ')}`}`);
      }
    }),
  );
  return results;
}

function summarize(lines: string[]): void {
  console.log(`\n${lines.join('\n')}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

async function main(): Promise<number> {
  const head = await loadSource(repoRoot, 'head');
  const only = option('--only')?.split(',').map((id) => id.trim()).filter(Boolean);
  const all = loadCases();
  const problems = check(head, all);
  if (problems.length) {
    summarize(['## Prompt cases: invalid case library', ...problems.map((problem) => `- ${problem}`)]);
    return 1;
  }
  if (flag('--check')) {
    console.log(`${all.length} prompt cases valid; every prompt section has a case.`);
    return 0;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    summarize(['## Prompt cases', 'OPENROUTER_API_KEY is not set, so no case was replayed.']);
    return 1;
  }
  const cases = only ? all.filter((testCase) => only.includes(testCase.id)) : all;
  if (only && cases.length !== only.length) {
    console.error(`unknown case id in --only: ${only.filter((id) => !cases.some((testCase) => testCase.id === id)).join(', ')}`);
    return 1;
  }
  console.log(`Replaying ${cases.length} cases on ${MODEL}: ${SAMPLES} samples, ${NEED} must pass.`);
  const results = await runAll(head, cases);

  // A failing case that is unchanged on the target branch is replayed there.
  const baselineRoot = option('--baseline-root');
  const alreadyFailing = new Set<string>();
  if (baselineRoot) {
    const unchanged = cases.filter((testCase) => {
      const result = results.find((entry) => entry.id === testCase.id)!;
      const baselineFile = join(baselineRoot, 'docs', 'prompts', 'cases', `${testCase.id}.json`);
      return result.outcome === 'fail' && existsSync(baselineFile) &&
        readFileSync(baselineFile, 'utf8') === readFileSync(join(casesDir, `${testCase.id}.json`), 'utf8');
    });
    if (unchanged.length) {
      console.log(`\nReplaying ${unchanged.length} failing unchanged cases against the target branch prompt.`);
      const base = await loadSource(resolve(baselineRoot), 'target');
      for (const result of await runAll(base, unchanged)) {
        if (result.outcome === 'fail') alreadyFailing.add(result.id);
      }
    }
  }

  const failed = results.filter((result) => result.outcome === 'fail' && !alreadyFailing.has(result.id));
  const errored = results.filter((result) => result.outcome === 'error');
  const row = (result: CaseResult) => `- \`${result.id}\` ${result.passed}/${result.sampled}: ${result.reasons[0] ?? ''}`.slice(0, 600);
  summarize([
    '## Prompt cases',
    `${results.filter((result) => result.outcome === 'pass').length}/${results.length} cases passed on ${MODEL} (${NEED} of ${SAMPLES} samples).`,
    ...(failed.length ? ['', '### Failing (regressed, new or changed)', ...failed.map(row)] : []),
    ...(alreadyFailing.size ? ['', '### Already failing on the target branch (not blocking)', ...results.filter((result) => alreadyFailing.has(result.id)).map(row)] : []),
    ...(errored.length ? ['', '### Model errors', ...errored.map(row)] : []),
  ]);
  return failed.length || errored.length ? 1 : 0;
}

void main().then((code) => {
  process.exitCode = code;
});
