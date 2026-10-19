/**
 * The saved prompt behavior cases under `docs/prompts/cases/`: their shape and
 * the pass rule each one checks against a model's answer. `prompt-cases.ts`
 * replays them; this module stays free of I/O so its rules are unit tested.
 *
 * A pass rule reads tool calls and their arguments first. Rules on free text
 * are allowed but fragile; keep them to plain checks such as "no @ tag".
 */

export const PROMPT_CASE_PLACES = ['room', 'dm', 'code-corner', 'repo-less-corner'] as const;
export type PromptCasePlace = (typeof PROMPT_CASE_PLACES)[number];

/**
 * Tools outside Beeline's own surface that a case may add: the harness shell
 * and Trusty Squire's browser tools. The runner stubs their descriptions.
 */
export const NATIVE_TOOL_NAMES = ['Bash', 'operate_drive', 'operate_click', 'operate_navigate'] as const;

export type Matcher =
  | string
  | number
  | boolean
  | { readonly equals: unknown }
  | { readonly contains: string }
  | { readonly matches: string; readonly flags?: string }
  | { readonly not: Matcher };

export type Rule =
  | { readonly call: string; readonly args?: Readonly<Record<string, Matcher>> }
  | { readonly noCall: string; readonly args?: Readonly<Record<string, Matcher>> }
  | { readonly text: Matcher }
  | { readonly all: readonly Rule[] }
  | { readonly any: readonly Rule[] }
  | { readonly not: Rule };

export interface PromptCase {
  /** Equals the file name without `.json`. */
  readonly id: string;
  /** The prompt section whose rule this case defends, e.g. `core.tagging`. */
  readonly section: string;
  /** What the agent must do, in plain words. Never quote a report or name a person, Room or Workspace. */
  readonly summary: string;
  readonly place: PromptCasePlace;
  /** Extra `SessionPromptContext` fields (agentName, brief, machineHost, …). */
  readonly session?: Readonly<Record<string, unknown>>;
  /** Extra `TurnPromptContext` fields (task, members, memory, …). `task.body` is required. */
  readonly turn: Readonly<Record<string, unknown>> & { readonly task: { readonly body: string } };
  /** The Room or corner messages the agent saw, one rendered line each. */
  readonly messages?: readonly string[];
  /** Tools beyond the ordinary agent surface: `no_reply_needed` or a `NATIVE_TOOL_NAMES` entry. */
  readonly tools?: readonly string[];
  /** Stub results by tool name, returned when the model calls that tool. */
  readonly toolResults?: Readonly<Record<string, string>>;
  readonly pass: Rule;
}

export interface ToolCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** Everything the model did in one replayed turn. */
export interface Transcript {
  readonly calls: readonly ToolCall[];
  /** All assistant text of the turn, joined. */
  readonly text: string;
}

export interface Verdict {
  readonly pass: boolean;
  readonly reason: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function checkMatcher(matcher: unknown, where: string): void {
  if (['string', 'number', 'boolean'].includes(typeof matcher)) return;
  if (!isObject(matcher)) throw new Error(`${where}: matcher must be a value or an object`);
  const keys = Object.keys(matcher);
  if ('equals' in matcher && keys.length === 1) return;
  if ('contains' in matcher && keys.length === 1 && typeof matcher.contains === 'string') return;
  if ('not' in matcher && keys.length === 1) return checkMatcher(matcher.not, `${where}.not`);
  if ('matches' in matcher && typeof matcher.matches === 'string' && keys.every((key) => key === 'matches' || key === 'flags')) {
    new RegExp(matcher.matches, typeof matcher.flags === 'string' ? matcher.flags : undefined);
    return;
  }
  throw new Error(`${where}: unknown matcher ${JSON.stringify(matcher)}`);
}

function checkRule(rule: unknown, where: string): void {
  if (!isObject(rule)) throw new Error(`${where}: rule must be an object`);
  const keys = Object.keys(rule);
  const only = (...allowed: string[]) => {
    const extra = keys.filter((key) => !allowed.includes(key));
    if (extra.length) throw new Error(`${where}: unknown rule keys ${extra.join(', ')}`);
  };
  if ('call' in rule || 'noCall' in rule) {
    const kind = 'call' in rule ? 'call' : 'noCall';
    only(kind, 'args');
    if (typeof rule[kind] !== 'string') throw new Error(`${where}.${kind} must be a tool name`);
    if (rule.args !== undefined) {
      if (!isObject(rule.args)) throw new Error(`${where}.args must be an object`);
      for (const [key, matcher] of Object.entries(rule.args)) checkMatcher(matcher, `${where}.args.${key}`);
    }
    return;
  }
  if ('text' in rule) {
    only('text');
    return checkMatcher(rule.text, `${where}.text`);
  }
  if ('all' in rule || 'any' in rule) {
    const kind = 'all' in rule ? 'all' : 'any';
    only(kind);
    const list = rule[kind];
    if (!Array.isArray(list) || !list.length) throw new Error(`${where}.${kind} must be a non-empty list`);
    list.forEach((child, index) => checkRule(child, `${where}.${kind}[${index}]`));
    return;
  }
  if ('not' in rule) {
    only('not');
    return checkRule(rule.not, `${where}.not`);
  }
  throw new Error(`${where}: unknown rule ${JSON.stringify(rule)}`);
}

/** Parses one case file's JSON and refuses anything the runner would misread. */
export function parsePromptCase(raw: unknown, fileId: string, knownTools: readonly string[]): PromptCase {
  const where = `case ${fileId}`;
  if (!isObject(raw)) throw new Error(`${where}: must be a JSON object`);
  const allowed = ['id', 'section', 'summary', 'place', 'session', 'turn', 'messages', 'tools', 'toolResults', 'pass'];
  const extra = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${where}: unknown keys ${extra.join(', ')}`);
  if (raw.id !== fileId) throw new Error(`${where}: id must equal the file name`);
  if (typeof raw.section !== 'string' || !raw.section) throw new Error(`${where}: section is required`);
  if (typeof raw.summary !== 'string' || !raw.summary) throw new Error(`${where}: summary is required`);
  if (!PROMPT_CASE_PLACES.includes(raw.place as PromptCasePlace)) {
    throw new Error(`${where}: place must be one of ${PROMPT_CASE_PLACES.join(', ')}`);
  }
  if (raw.session !== undefined && !isObject(raw.session)) throw new Error(`${where}: session must be an object`);
  if (isObject(raw.session) && 'surface' in raw.session) throw new Error(`${where}: set place, not session.surface`);
  if (!isObject(raw.turn) || !isObject(raw.turn.task) || typeof raw.turn.task.body !== 'string') {
    throw new Error(`${where}: turn.task.body is required`);
  }
  if ('surface' in raw.turn || 'transcript' in raw.turn) {
    throw new Error(`${where}: set place and messages, not turn.surface or turn.transcript`);
  }
  if (raw.messages !== undefined && (!Array.isArray(raw.messages) || raw.messages.some((line) => typeof line !== 'string'))) {
    throw new Error(`${where}: messages must be a list of strings`);
  }
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) throw new Error(`${where}: tools must be a list`);
    for (const name of raw.tools) {
      if (typeof name !== 'string' || !knownTools.includes(name)) throw new Error(`${where}: unknown tool ${String(name)}`);
    }
  }
  if (raw.toolResults !== undefined) {
    if (!isObject(raw.toolResults) || Object.values(raw.toolResults).some((value) => typeof value !== 'string')) {
      throw new Error(`${where}: toolResults must map tool names to strings`);
    }
  }
  checkRule(raw.pass, `${where}.pass`);
  return raw as unknown as PromptCase;
}

function valueAt(args: Readonly<Record<string, unknown>>, path: string): unknown {
  if (path === '*') return JSON.stringify(args);
  let value: unknown = args;
  for (const part of path.split('.')) {
    if (!isObject(value)) return undefined;
    value = value[part];
  }
  return value;
}

function matches(matcher: Matcher, value: unknown): boolean {
  if (typeof matcher !== 'object') return value === matcher;
  if ('not' in matcher) return !matches(matcher.not, value);
  if ('equals' in matcher) return JSON.stringify(value) === JSON.stringify(matcher.equals);
  const text = typeof value === 'string' ? value : value === undefined ? undefined : JSON.stringify(value);
  if (text === undefined) return false;
  if ('contains' in matcher) return text.includes(matcher.contains);
  return new RegExp(matcher.matches, matcher.flags).test(text);
}

function callMatches(call: ToolCall, name: string, args?: Readonly<Record<string, Matcher>>): boolean {
  if (call.name !== name) return false;
  return Object.entries(args ?? {}).every(([path, matcher]) => matches(matcher, valueAt(call.args, path)));
}

const describeCalls = (calls: readonly ToolCall[]) =>
  calls.length ? calls.map((call) => `${call.name}(${JSON.stringify(call.args).slice(0, 200)})`).join(', ') : 'no tool calls';

export function evaluateRule(rule: Rule, transcript: Transcript): Verdict {
  if ('call' in rule) {
    const pass = transcript.calls.some((call) => callMatches(call, rule.call, rule.args));
    return { pass, reason: pass ? `called ${rule.call}` : `expected ${rule.call}${rule.args ? ` with ${JSON.stringify(rule.args)}` : ''}; saw ${describeCalls(transcript.calls)}` };
  }
  if ('noCall' in rule) {
    const hit = transcript.calls.find((call) => callMatches(call, rule.noCall, rule.args));
    return { pass: !hit, reason: hit ? `forbidden call ${describeCalls([hit])}` : `did not call ${rule.noCall}` };
  }
  if ('text' in rule) {
    const pass = matches(rule.text, transcript.text);
    return { pass, reason: pass ? 'text matched' : `text did not match ${JSON.stringify(rule.text)}: ${JSON.stringify(transcript.text.slice(0, 300))}` };
  }
  if ('all' in rule) {
    for (const child of rule.all) {
      const verdict = evaluateRule(child, transcript);
      if (!verdict.pass) return verdict;
    }
    return { pass: true, reason: 'all rules passed' };
  }
  if ('any' in rule) {
    const verdicts = rule.any.map((child) => evaluateRule(child, transcript));
    const passed = verdicts.find((verdict) => verdict.pass);
    return passed ?? { pass: false, reason: `no alternative passed: ${verdicts.map((verdict) => verdict.reason).join(' | ')}` };
  }
  const inner = evaluateRule(rule.not, transcript);
  return { pass: !inner.pass, reason: inner.pass ? `negated rule held: ${inner.reason}` : 'negated rule did not hold' };
}

/**
 * A case passes when `need` of `total` samples pass. `open` means more samples
 * could still change the outcome, so the runner stops sampling once it is not.
 */
export function caseOutcome(samples: readonly boolean[], total: number, need: number): 'pass' | 'fail' | 'open' {
  const passed = samples.filter(Boolean).length;
  if (passed >= need) return 'pass';
  if (samples.length - passed > total - need) return 'fail';
  return 'open';
}
