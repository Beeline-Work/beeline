/**
 * The saved prompt behavior cases in `docs/prompts/cases/`. Run with
 * `node --import tsx scripts/prompt-cases.ts`; it never calls a model.
 *
 *   (no flag)            validate every case, build its prompt with the real
 *                        assembler (`apps/body/src/prompt-assembly.ts`) and
 *                        tool descriptions (`apps/body/src/minimal-tool-surface.ts`),
 *                        and require one case per prompt section. CI runs this.
 *   --export <dir>       write one self-contained replay prompt per case. An
 *                        agent replays them with its own model (see
 *                        docs/prompts/cases/README.md).
 *   --grade <dir>        grade the recorded answers `<id>.<n>.json` against
 *                        each case's pass rule and print a pass/fail table.
 *   --only <id,id>       limit export or grading to these cases.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const SAMPLES = 3;
const NEED = 2;
const MAX_STEPS = 6;
const SILENT_TOOL_NAME = 'no_reply_needed';
// Fixed so a case's prompt does not change with the runner's own host.
const FIXED_MEMORY_MAX_BYTES = 32 * 1024 ** 3;

type ToolDefinition = ToolSurface.ToolDefinition;

interface PromptSource {
  readonly assembly: typeof Assembly;
  readonly tools: typeof ToolSurface;
}

async function loadSource(root: string): Promise<PromptSource> {
  const load = (file: string) => import(pathToFileURL(join(root, 'apps', 'body', 'src', file)).href);
  return { assembly: await load('prompt-assembly.ts'), tools: await load('minimal-tool-surface.ts') };
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

/**
 * One self-contained replay prompt. The replaying agent hands it to a fresh
 * session of its own model, which answers with the calls and text it would
 * produce on that turn.
 */
function replayPrompt(source: PromptSource, testCase: PromptCase): string {
  const prompt = assemble(source, testCase);
  const tools = toolsFor(source, testCase).map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
  return [
    `# Prompt case replay: ${testCase.id}`,
    '',
    'You are the agent described below, on exactly one turn. Do not run anything. Decide what you would do on this turn with the tools listed.',
    testCase.toolResults
      ? `Tool calls return these stub results by tool name: ${JSON.stringify(testCase.toolResults)}. Any other call returns {"ok":true}.`
      : 'Every tool call returns {"ok":true}.',
    `Continue for up to ${MAX_STEPS} rounds of tool calls, as you would after those results.`,
    'Reply with only one JSON object and nothing else:',
    '{"calls":[{"name":"<tool name>","args":{...}}],"text":"<everything you would post as your reply, or an empty string>"}',
    '',
    '## System prompt',
    '',
    '````text',
    prompt.system || '(none: the session rules ride in the turn below)',
    '````',
    '',
    '## Tools',
    '',
    '````json',
    JSON.stringify(tools),
    '````',
    '',
    '## Turn',
    '',
    '````text',
    prompt.user,
    '````',
    '',
  ].join('\n');
}

/**
 * Models wrap the JSON answer in prose or code fences, and sometimes add a
 * stray closing brace; grade the longest object from the first `{` that parses.
 */
function parseAnswer(raw: string): Partial<Transcript> {
  const start = raw.indexOf('{');
  for (let end = raw.lastIndexOf('}'); start !== -1 && end > start; end = raw.lastIndexOf('}', end - 1)) {
    try {
      return JSON.parse(raw.slice(start, end + 1)) as Partial<Transcript>;
    } catch {
      // Try the next shorter candidate.
    }
  }
  throw new Error('no JSON object in the answer');
}

interface CaseResult {
  readonly id: string;
  readonly section: string;
  readonly outcome: 'pass' | 'fail' | 'needs samples' | 'missing';
  readonly passed: number;
  readonly sampled: number;
  readonly reason: string;
}

/**
 * Grades `<id>.<n>.json` answers in `dir`. One passing sample passes a case;
 * a failing case needs two more samples and passes at 2 of 3.
 */
function grade(dir: string, cases: readonly PromptCase[]): CaseResult[] {
  const files = readdirSync(dir);
  return cases.map((testCase) => {
    const samples = files
      .filter((file) => new RegExp(`^${testCase.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.json$`).test(file))
      .sort();
    const verdicts = samples.map((file) => {
      try {
        const answer = parseAnswer(readFileSync(join(dir, file), 'utf8'));
        const calls: ToolCall[] = Array.isArray(answer.calls)
          ? answer.calls.map((call) => ({ name: String(call?.name ?? ''), args: (call?.args ?? {}) as Record<string, unknown> }))
          : [];
        return evaluateRule(testCase.pass, { calls, text: typeof answer.text === 'string' ? answer.text : '' });
      } catch (error) {
        return { pass: false, reason: `${file}: ${(error as Error).message}` };
      }
    });
    const passes = verdicts.map((verdict) => verdict.pass);
    const passed = passes.filter(Boolean).length;
    const reason = verdicts.find((verdict) => !verdict.pass)?.reason ?? '';
    const base = { id: testCase.id, section: testCase.section, passed, sampled: passes.length, reason };
    if (!passes.length) return { ...base, outcome: 'missing', reason: 'no answer recorded' };
    if (passed === passes.length) return { ...base, outcome: 'pass' };
    const outcome = caseOutcome(passes, SAMPLES, NEED);
    return { ...base, outcome: outcome === 'open' ? 'needs samples' : outcome };
  });
}

function summarize(lines: string[]): void {
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

async function main(): Promise<number> {
  const head = await loadSource(repoRoot);
  const only = option('--only')?.split(',').map((id) => id.trim()).filter(Boolean);
  const all = loadCases();
  const problems = check(head, all);
  if (problems.length) {
    summarize(['## Prompt cases: invalid case library', ...problems.map((problem) => `- ${problem}`)]);
    return 1;
  }
  const cases = only ? all.filter((testCase) => only.includes(testCase.id)) : all;
  if (only && cases.length !== only.length) {
    console.error(`unknown case id in --only: ${only.filter((id) => !cases.some((testCase) => testCase.id === id)).join(', ')}`);
    return 1;
  }
  const exportDir = option('--export');
  if (exportDir) {
    mkdirSync(exportDir, { recursive: true });
    for (const testCase of cases) writeFileSync(join(exportDir, `${testCase.id}.prompt.md`), replayPrompt(head, testCase));
    console.log(`Wrote ${cases.length} replay prompts to ${exportDir}. Save each answer as <id>.1.json there, then run --grade ${exportDir}.`);
    return 0;
  }
  const gradeDir = option('--grade');
  if (gradeDir) {
    // Without --only, grade the cases that were exported to this directory.
    const exported = new Set(readdirSync(gradeDir).flatMap((file) => file.match(/^(.+)\.prompt\.md$/)?.[1] ?? []));
    const results = grade(gradeDir, only ? cases : cases.filter((testCase) => exported.has(testCase.id)));
    const blocking = results.filter((result) => result.outcome !== 'pass');
    summarize([
      `**Prompt case replay:** ${results.length - blocking.length}/${results.length} passed.`,
      '',
      '| Case | Section | Result | Samples passed |',
      '| --- | --- | --- | --- |',
      ...results.map((result) =>
        `| \`${result.id}\` | \`${result.section}\` | ${result.outcome.toUpperCase()}${result.reason && result.outcome !== 'pass' ? `: ${result.reason.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 240)}` : ''} | ${result.passed}/${result.sampled} |`),
    ]);
    return blocking.length ? 1 : 0;
  }
  console.log(`${all.length} prompt cases valid; every prompt section has a case and every case renders its section.`);
  return 0;
}

void main().then((code) => {
  process.exitCode = code;
});
