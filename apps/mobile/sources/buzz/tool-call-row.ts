import type { TurnActivityAction } from './activity-timeline';

/**
 * What a tool call *is*, for the one-line tool ledger (tool-ledger.ts).
 *
 * The old expansion printed the same call three times — a summary phrase, the
 * harness title, a `Result:` restatement, then the command again in full —
 * and put the transport envelope (`[{"type":"terminal","terminalId":…}]`)
 * where the output should be. This module is the one place that decides what a
 * call *is*: the object it acted on (the command is the single source of
 * truth; the harness's own title is a last resort, because a harness happily
 * labels a directory listing "Reviewed the current changes"), its distilled
 * failure reason, and its cleaned output.
 */

/** The object column truncates in the MIDDLE: the flags at the end carry the meaning. */
export const TOOL_CALL_OBJECT_MAX = 56;
/** The ledger line's label cap (owner-approved tool-ledger design, 2026-08-24). */
const TOOL_CALL_LABEL_MAX = 40;
/** A duration is only worth a column when the call was slow enough to notice. */
export const TOOL_CALL_DURATION_FLOOR_MS = 1000;

/** ACP tool kinds (and the folded-summary verbs) -> the one-word verb column. */
const KIND_VERBS: Readonly<Record<string, string>> = {
  read: 'read',
  open: 'read',
  search: 'found',
  searched: 'found',
  grep: 'found',
  fetch: 'fetched',
  fetched: 'fetched',
  list: 'listed',
  listed: 'listed',
  inspected: 'read',
  edit: 'wrote',
  write: 'wrote',
  create: 'wrote',
  patch: 'wrote',
  move: 'moved',
  delete: 'deleted',
  execute: 'ran',
  ran: 'ran',
};

/** A folded rollup row from an older transcript: `reading 8` is 8 read calls. */
const PARTICIPLE_VERBS: Readonly<Record<string, string>> = {
  reading: 'read',
  searching: 'found',
  listing: 'listed',
  fetching: 'fetched',
  inspecting: 'read',
  querying: 'found',
  running: 'ran',
};

/** Verb words the harness leads its own titles with, stripped off the object. */
const TITLE_VERB =
  /^(?:read|ran|run|wrote|write|edited?|searched(?:\s+for)?|listed|fetched|inspected|reasoned\s+about|opened|updated|reviewed)\s+/i;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Keep the head AND the tail. `npm run test -- --coverage --reporter=json`
 * truncated at the end is just `npm run test --…`, which is every test command
 * in the repo; the flags are the half that says which one this was.
 */
export function middleTruncate(value: string, limit = TOOL_CALL_OBJECT_MAX): string {
  const clean = oneLine(value);
  if (clean.length <= limit) return clean;
  const keep = Math.max(2, limit - 1);
  const head = Math.ceil(keep / 2);
  return `${clean.slice(0, head).trimEnd()}…${clean.slice(clean.length - (keep - head)).trimStart()}`;
}

function basename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1) ?? path
  );
}

/** `env A=b bash -lc 'npm test'` -> `npm test`. */
function bareCommand(command: string): string {
  return oneLine(command)
    .replace(/^(?:env\s+\S+=\S+\s+)*/, '')
    .replace(/^(?:bash|sh|zsh)\s+-[lc]+\s+['"]?/, '')
    .replace(/['"]$/, '');
}

/** `mcp__squire__list_credentials` -> `{ server: 'squire', tool: 'list_credentials' }`. */
function mcpParts(value: string | undefined): { server: string; tool: string } | undefined {
  const match = value?.match(/\bmcp__([\w.-]+)__([\w.-]+)/);
  return match?.[1] && match[2] ? { server: match[1], tool: match[2] } : undefined;
}

function parsed(value: string | undefined): unknown {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function field(value: unknown, keys: readonly string[]): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return undefined;
}

function searchPattern(step: TurnActivityAction): string | undefined {
  const fromInput = field(parsed(step.input), ['pattern', 'query', 'regex', 'q', 'search']);
  if (fromInput) return fromInput;
  if (step.input && !step.input.trim().startsWith('{')) return step.input;
  return undefined;
}

/** `12 matches` in the tool's own result — never a count the client invented. */
function hitCount(output: readonly string[]): string | undefined {
  for (const line of output) {
    const hits = line.match(/\b(\d+)\s+(?:matches?|results?|hits?)\b/i);
    if (hits) return `${hits[1]} hits`;
  }
  return undefined;
}

const TEXT_KEYS = [
  'formatted_output',
  'stdout',
  'stderr',
  'output',
  'text',
  'content',
  'message',
  'result',
] as const;

function textLeaves(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(textLeaves);
  if (value && typeof value === 'object') {
    return TEXT_KEYS.flatMap((key) =>
      key in (value as Record<string, unknown>)
        ? textLeaves((value as Record<string, unknown>)[key])
        : [],
    );
  }
  return [];
}

/** Older rows could be cut in the middle of a JSON string. Recover only the
 * known output field, stopping at its closing quote or the end of the row. */
function legacyTruncatedText(raw: string): string | undefined {
  const match =
    /"(?:formatted_output|stdout|stderr|output|text|content|message|result)"\s*:\s*"/.exec(raw);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  let encoded = '';
  for (let index = start; index < raw.length; index++) {
    const char = raw[index]!;
    if (char === '"') break;
    if (char === '\\' && index + 1 < raw.length) {
      encoded += char + raw[++index];
    } else {
      encoded += char;
    }
  }
  // Decode a complete escape at a time. A dangling escape or partial unicode
  // escape remains literal instead of making the entire legacy row disappear.
  return encoded.replace(/\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (escape) => {
    try {
      return JSON.parse(`"${escape}"`) as string;
    } catch {
      return escape;
    }
  });
}

/**
 * The call's real output, or nothing.
 *
 * A terminal-backed execute returns `[{"type":"terminal","terminalId":"exec-…"}]`
 * — a machine identifier the reader can do nothing with. Showing nothing is the
 * honest rendering of "we were handed a handle, not a result".
 */
export function toolCallOutput(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const envelope = parsed(raw);
  const text =
    envelope === undefined ? (legacyTruncatedText(raw) ?? raw) : textLeaves(envelope).join('\n');
  if (!text.trim()) return [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trimEnd());
  return lines;
}

/** `1.4s`, `2m 05s` — tabular, and only ever shown above the floor. */
export function formatToolCallDuration(ms: number | undefined): string | undefined {
  if (!ms || ms < TOOL_CALL_DURATION_FLOOR_MS) return undefined;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

function verbAndObject(step: TurnActivityAction, output: readonly string[]) {
  const kind = step.toolKind?.toLowerCase();
  const mcp = mcpParts(step.title) ?? mcpParts(step.command);
  const file =
    step.files?.[0]?.path ?? field(parsed(step.input), ['path', 'file_path', 'filename']);

  if (step.command) {
    const command = bareCommand(step.command);
    const git = command.match(/^git\s+(.+)$/i);
    if (git) return { verb: 'git', object: git[1] ?? command };
    if (mcp) {
      return {
        verb: mcp.tool,
        object: command.replace(/^mcp__[\w.-]+__[\w.-]+\s*/, '') || mcp.server,
      };
    }
    return { verb: 'ran', object: command };
  }
  if (mcp) return { verb: mcp.tool, object: oneLine(step.input ?? '') || mcp.server };
  if (kind === 'search' || kind === 'searched' || kind === 'grep') {
    const pattern = searchPattern(step);
    const hits = hitCount(output);
    const object = [pattern, hits].filter(Boolean).join(' · ');
    return { verb: 'found', object: object || titleObject(step) };
  }
  if (kind && KIND_VERBS[kind] && file) return { verb: KIND_VERBS[kind], object: basename(file) };
  if (file) return { verb: KIND_VERBS[kind ?? ''] ?? 'read', object: basename(file) };

  const rollup = oneLine(step.title).match(/^(\w+ing)\s+(\d+)$/i);
  if (rollup) {
    const participle = rollup[1]?.toLowerCase() ?? '';
    return {
      verb: PARTICIPLE_VERBS[participle] ?? KIND_VERBS[kind ?? ''] ?? 'ran',
      object: `${rollup[2]} calls`,
    };
  }
  return { verb: KIND_VERBS[kind ?? ''] ?? 'ran', object: titleObject(step) };
}

/** The harness title, stripped of the verb the column already carries. */
function titleObject(step: TurnActivityAction): string {
  const title = oneLine(step.title)
    .replace(/^#+\s*/, '')
    .replace(/^\*\*|\*\*$/g, '');
  return title.replace(TITLE_VERB, '') || title;
}

/**
 * The ledger line's label (owner-approved tool-ledger design, 2026-08-24): the
 * call's object — the command, the file, the search pattern with its hit
 * count — cut to the label cap. The leading glyph carries the family
 * (tool-ledger.ts), so a generic verb (`ran`, `read`, `wrote`) is dropped: the
 * design's `>_ npm run typecheck`, not `ran npm run typecheck`. A verb that IS
 * information (an MCP tool's own name, `git`) stays.
 */
export function toolCallLabel(step: TurnActivityAction): string {
  const output = toolCallOutput(step.output);
  const { verb, object } = verbAndObject(step, output);
  const generic = verb === 'git' || Object.values(KIND_VERBS).includes(verb);
  const label = generic ? object : `${verb} ${object}`;
  return middleTruncate(oneLine(label) || 'tool call', TOOL_CALL_LABEL_MAX);
}
