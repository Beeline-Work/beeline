/**
 * What the ledger does to raw text before inscribing it.
 *
 * Two independent jobs, both about the same thing: the slab shows the meaning,
 * never the transport. Percent escapes are transport. A wall of tool output is
 * transport. Neither belongs in the flowing column.
 */

/**
 * One or more consecutive percent escapes, decoded as a unit so multi-byte
 * UTF-8 sequences (`%E2%9C%93`) survive.
 */
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

/**
 * Render `%3F` as `?`.
 *
 * Message text reaches the transcript having crossed a URL-shaped boundary
 * somewhere upstream, and the escapes were arriving on screen literally. This
 * decodes only what is unambiguously an escape run and leaves everything else
 * exactly as written: a bare `100%`, a stray `%zz`, and a truncated `%3` all
 * pass through untouched, and a run that is not valid UTF-8 keeps its literal
 * form rather than throwing.
 *
 * The cost is that a message *about* percent-encoding renders the decoded
 * character instead of the escape it was discussing. That is the deliberate
 * trade: literal escapes on screen were the reported defect, and a message
 * discussing them is far rarer than one carrying them by accident.
 */
export function decodePercentEncoding(text: string): string {
  if (!text.includes('%')) return text;
  return text.replace(PERCENT_RUN, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * Lines that are a machine talking to a machine.
 *
 * Deliberately literal — every pattern is a fixed prefix or a shape no ordinary
 * sentence takes. Prose that merely *mentions* git is never matched; only output
 * git, npm, or a runtime actually produced is. Widening this list is the right
 * way to catch a new tool's wall; loosening it into "looks technical" is not.
 */
const MACHINE_LINE_PATTERNS: readonly RegExp[] = [
  // Tool-prefixed diagnostics.
  /^(?:hint|error|fatal|warning|remote|usage|note|debug|trace|info):/i,
  /^npm (?:ERR|WARN|notice)!?/,
  /^(?:yarn|pnpm) (?:ERR|WARN)/i,
  /^[A-Za-z][A-Za-z0-9_]*(?:Error|Exception):\s/,
  // git push / fetch refspec reporting.
  /^\s*[!*+=-]\s*\[[a-z ._-]+\]/i,
  /^To (?:https?:\/\/|git@|ssh:\/\/|\/|[\w.-]+:)/,
  /^From (?:https?:\/\/|git@|ssh:\/\/|[\w.-]+[:/])/,
  /^\s*[0-9a-f]{7,40}\.\.\.?[0-9a-f]{7,40}\b/,
  /\brefs\/(?:heads|remotes|tags)\//,
  /\S\s+->\s+\S+\s*(?:\([^)]*\))?\s*$/,
  /\((?:fetch first|non-fast-forward|forced update|unpacked|new branch|new tag)\)\s*$/i,
  // git progress and porcelain.
  /^(?:Enumerating|Counting|Compressing|Writing|Resolving|Receiving) (?:objects|deltas)\b/,
  /^Total \d+ \(delta \d+\)/,
  /^(?:Everything up-to-date|Already up to date|Updates were rejected|Aborting)/i,
  /^(?:On branch|Your branch|Switched to|nothing to commit|Auto-merging|CONFLICT|Merge branch)\b/,
  /^\s*\d+ files? changed(?:,|$)/,
  /^\s*(?:create|delete) mode \d{6}\b/,
  // Stack frames and compiler carets.
  /^\s*at\s+\S+\s*\(.+:\d+:\d+\)\s*$/,
  /^\s*at\s+.+:\d+:\d+\s*$/,
  /^\s*\d+\s*\|\s/,
  /^\s*\^+\s*$/,
  /^\s*File "[^"]+", line \d+/,
  // A shell echo of the command itself.
  /^\s*[$#>]\s+\S/,
  /^\s*(?:git|npm|npx|yarn|pnpm|node|docker|kubectl|cargo|go|python3?|pip3?)\s+[a-z-]/,
];

/** A trailing progress readout: `remote: Counting objects: 100% (5/5), done.` */
const PROGRESS_LINE = /\(\d+\/\d+\)|\bdone\.\s*$/;

function isMachineLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (MACHINE_LINE_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  return PROGRESS_LINE.test(trimmed) && /^[a-z]+:/i.test(trimmed);
}

/**
 * Minimum consecutive machine lines before a run counts as a wall.
 *
 * Two would catch an agent quoting a single `error:` line mid-sentence, which
 * is prose about the error and belongs on the slab. Three is a dump.
 */
const MACHINE_RUN_MIN_LINES = 3;
/** Same, inside a fence — a fence already declares itself as machine text. */
const MACHINE_FENCE_MIN_LINES = 2;
/** How much of a fenced block must be machine output before the whole block is. */
const MACHINE_FENCE_RATIO = 0.5;

function isMachineFence(body: string): boolean {
  const lines = body.split('\n').filter((line) => line.trim());
  if (lines.length < MACHINE_FENCE_MIN_LINES) return false;
  return lines.filter(isMachineLine).length / lines.length >= MACHINE_FENCE_RATIO;
}

export type LedgerText = {
  /** The prose that survives, ready for the flowing column. */
  prose: string;
  /**
   * Everything that was lifted out, joined — the body behind the ghost line's
   * disclosure. `undefined` when nothing was collapsed.
   */
  machine?: string;
  /** How many lines the ghost line stands in for. */
  machineLines: number;
};

const FENCE = /^```/;

/**
 * Split an agent turn into prose and the machine noise it dragged along.
 *
 * A `git push` rejection dump, a stack trace, an npm error wall: the agent
 * pastes these into its own narration, and they print down the slab as a wall
 * the reader has to scroll past. They collapse to one ghost line instead
 * (`DESIGN.md`, "Machine noise"), while the sentences around them stay exactly
 * as written.
 *
 * The unit is a **run of consecutive machine lines**, not a blank-line-delimited
 * block. That distinction is the whole reason this works on real agent prose: a
 * dump is very often written directly under the sentence introducing it with no
 * blank line between them, and a block-level rule would either swallow that
 * sentence along with the dump or, if it demanded a majority, miss the dump
 * entirely. A run is bounded by the first line that is not machine output, so
 * the prose on either side is untouched by construction.
 *
 * Blank lines *inside* a run are kept — tool output is full of them, and ending
 * a run on one would split a single dump into fragments too short to qualify.
 */
export function splitLedgerText(text: string): LedgerText {
  if (!text.includes('\n')) return { prose: text, machineLines: 0 };

  const prose: string[] = [];
  const machine: string[] = [];
  const lines = text.split('\n');

  /** The run being accumulated, and the trailing blanks not yet claimed by it. */
  let run: string[] = [];
  let pendingBlanks: string[] = [];
  let fence: { open: string; body: string[] } | null = null;

  const flushRun = () => {
    if (run.length >= MACHINE_RUN_MIN_LINES) machine.push(run.join('\n').trim());
    else prose.push(...run);
    run = [];
  };

  for (const line of lines) {
    if (FENCE.test(line.trim())) {
      if (fence) {
        const body = fence.body.join('\n');
        if (isMachineFence(body)) machine.push(body.trim());
        else prose.push([fence.open, ...fence.body, '```'].join('\n'));
        fence = null;
        continue;
      }
      flushRun();
      prose.push(...pendingBlanks);
      pendingBlanks = [];
      fence = { open: line, body: [] };
      continue;
    }
    if (fence) {
      fence.body.push(line);
      continue;
    }
    if (isMachineLine(line)) {
      // A blank line only belongs to the run once the run continues past it.
      run.push(...pendingBlanks, line);
      pendingBlanks = [];
      continue;
    }
    if (!line.trim() && run.length) {
      pendingBlanks.push(line);
      continue;
    }
    flushRun();
    prose.push(...pendingBlanks, line);
    pendingBlanks = [];
  }
  if (fence) {
    const body = fence.body.join('\n');
    if (isMachineFence(body)) machine.push(body.trim());
    else prose.push([fence.open, ...fence.body].join('\n'));
  }
  flushRun();
  prose.push(...pendingBlanks);

  if (!machine.length) return { prose: text, machineLines: 0 };
  const collapsed = machine.join('\n\n');
  return {
    prose: prose.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    machine: collapsed,
    machineLines: collapsed.split('\n').filter((line) => line.trim()).length,
  };
}
