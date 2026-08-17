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
 * Deliberately narrow — every pattern here is a literal prefix or a shape no
 * ordinary sentence takes. Prose that merely *mentions* git is not matched;
 * only output git itself produced is.
 */
const MACHINE_LINE_PATTERNS: readonly RegExp[] = [
  /^(?:hint|error|fatal|warning|remote|usage|note):/i,
  /^\s*!\s*\[[a-z ]+\]/i,
  /^\s*\*\s*\[new (?:branch|tag)\]/i,
  /^To (?:https?:\/\/|git@|ssh:\/\/|\/)/,
  /^\s*[0-9a-f]{7,40}\.\.\.?[0-9a-f]{7,40}\b/,
  /\brefs\/(?:heads|remotes|tags)\//,
  /^(?:Everything up-to-date|Already up to date|Updates were rejected)/i,
  /^(?:Enumerating|Counting|Compressing|Writing|Resolving) (?:objects|deltas)\b/,
  /^Total \d+ \(delta \d+\)/,
  /^npm (?:ERR|WARN)!/,
  /^\s*at\s+\S+\s*\(.+:\d+:\d+\)\s*$/,
  /^\s*\$\s+\S/,
  /^[A-Za-z]*Error:\s/,
  /^\s*\d+\s*\|\s/,
];

/** A trailing progress readout: `remote: Counting objects: 100% (5/5), done.` */
const PROGRESS_LINE = /\(\d+\/\d+\)|\bdone\.\s*$/;

function isMachineLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (MACHINE_LINE_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  return PROGRESS_LINE.test(trimmed) && /^[a-z]+:/i.test(trimmed);
}

/** Minimum lines before a run is even considered a wall rather than a remark. */
const MACHINE_BLOCK_MIN_LINES = 3;
/** Same, inside a fence — a fence already declares itself as machine text. */
const MACHINE_FENCE_MIN_LINES = 2;
/** How much of a block must be machine output before the whole block is. */
const MACHINE_BLOCK_RATIO = 0.5;

function isMachineBlock(block: string, minLines: number): boolean {
  const lines = block.split('\n').filter((line) => line.trim());
  if (lines.length < minLines) return false;
  const machine = lines.filter(isMachineLine).length;
  return machine / lines.length >= MACHINE_BLOCK_RATIO;
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
 * Blank lines and fences are the block boundaries, so a paragraph of real prose
 * is never partially eaten: a block is collapsed whole or kept whole.
 */
export function splitLedgerText(text: string): LedgerText {
  if (!text.includes('\n')) return { prose: text, machineLines: 0 };

  const prose: string[] = [];
  const machine: string[] = [];
  const lines = text.split('\n');

  let block: string[] = [];
  /** The verbatim opening fence (```ts and friends), or null outside a fence. */
  let openFence: string | null = null;

  const flushProse = () => {
    if (!block.length) return;
    const joined = block.join('\n');
    if (isMachineBlock(joined, MACHINE_BLOCK_MIN_LINES)) machine.push(joined.trim());
    else prose.push(joined);
    block = [];
  };

  /** A fence body is judged on its own, then either collapsed or re-fenced. */
  const flushFence = (fence: string) => {
    const body = block.join('\n');
    if (isMachineBlock(body, MACHINE_FENCE_MIN_LINES)) machine.push(body.trim());
    else prose.push([fence, ...block, '```'].join('\n'));
    block = [];
  };

  for (const line of lines) {
    if (FENCE.test(line.trim())) {
      if (openFence !== null) {
        flushFence(openFence);
        openFence = null;
        continue;
      }
      flushProse();
      openFence = line;
      continue;
    }
    if (openFence === null && !line.trim()) {
      flushProse();
      prose.push('');
      continue;
    }
    block.push(line);
  }
  // An unterminated fence is still a fence's worth of evidence.
  if (openFence !== null) flushFence(openFence);
  else flushProse();

  if (!machine.length) return { prose: text, machineLines: 0 };
  const collapsed = machine.join('\n\n');
  return {
    prose: prose.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    machine: collapsed,
    machineLines: collapsed.split('\n').filter((line) => line.trim()).length,
  };
}
