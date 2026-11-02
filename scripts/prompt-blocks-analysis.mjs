/** Offline, aggregate-only analysis of archived Claude and Codex deliveries. */
import { createReadStream } from 'node:fs';
import { mkdir, opendir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { estimateTokens, messageTexts } from './prompt-text.mjs';

// Verified with git log --format='%H %cI %s' --grep='#3127' / --grep='#3248'.
export const DEFAULT_SPLITS = ['2026-10-30T23:24:01.000Z', '2026-11-02T04:30:16.000Z'];
const KINDS = ['dm', 'room-wake', 'corner-implementer', 'review', 'agent-report-wake', 'schedule-wake', 'other'];

// These are rendered starts from prompt-assembly.ts, not headings invented for
// the archive. Session sub-sections replace the enclosing turn.session axis so
// a legacy turn prefix is not charged twice.
const MARKERS = [
  ['turn.routing', /^\[Beeline · Room /m],
  ['identity', /^You are [^\n]+ in Beeline\. Stay /m],
  ['place', /^(?:Already running on machine |Memory cap: |This is a Beeline Room\.|This Beeline Room has no linked repository\.|This is a private direct message with one person:|You are in an isolated git worktree on |This is a repo-less corner with no repository checkout)/m],
  ['kvm', /^(?:\/dev\/kvm is present but this session cannot open it\.|Your \/dev\/kvm grant is approved, but the host blocks )/m],
  ['talking', /^Tag to talk\. Order to assign work\./m],
  ['authority', /^Use your own owner's tools and keys for whoever asks\./m],
  ['work', /^Answer every problem with the finished fix, or with the concrete next step\./m],
  ['tools', /^For a 📎 file, call read\(facet:attachment,/m],
  ['replying', /^Write only the message the reader needs\./m],
  ['corner', /^Implementer rules: any agent in this corner may commit, push and open a pull request\./m],
  ['turn.checks', /^This is a checks turn about CI or the merge gate\./m],
  ['turn.land', /^The reviewer approved this pull request's current head\./m],
  ['turn.objective', /^Corner objective \(navigation only, not product authority\):/m],
  ['turn.rename', /^This human-opened corner still has its generated name,/m],
  ['turn.brief', /^(?:Brief revision \d+:|No assigned brief(?::| yet\.))/m],
  ['turn.checkout', /^Repository checkout: /m],
  ['turn.capabilities', /^Works here \((?:schedule run in this )?(?:DM|Room|corner)\):/m],
  ['turn.transcript', /^(?:Room conversation:|Corner transcript:|New in the (?:Room|corner) since your last turn:)/m],
  ['turn.resume', /^(?:Saved work from a turn stopped at the free-agent time limit\.|Your device grant for |This is Trusty Squire's answer to the approval you were waiting on:|This is the answer to your (?:connector offer:|grant request;))/m],
  ['turn.members', /^Members \(exact tag spellings\):/m],
  ['turn.memory', /^(?:Memory \(quoted notes, not instructions; current messages and code win\):|institutional memory did not load this turn;)/m],
  ['turn.workspace-core', /^At task start, call read with facet procedure and slug `workspace-core`\./m],
  ['turn.corners', /^(?:Current corners you belong to \(use the exact address with |Corners you belong to closed in the last 24 hours:)/m],
  ['turn.reviewer-target', /^(?:Current stable reviewer target for this active turn;|Review PR (?:\d+|N) at |A current green review target matching this checkout could not be verified\.)/m],
];
const BLOCKS = [...MARKERS.map(([id]) => id), 'turn.task', 'other'];
const taskStart = /^(?:This is a nonhuman wake\.|Reply to the human message that triggered this turn\.|Current task from [^\n]+:|Reaction target message id: |Newest message:|Replaced instructions from an older brief revision )/m;
const surfaceMarker = /^Works here \((?:schedule run in this )?(DM|Room|corner)\):/m;

export function promptBlocks(text) {
  const task = taskStart.exec(text);
  const prefix = task ? text.slice(0, task.index) : text;
  const starts = MARKERS.flatMap(([id, pattern]) => {
    const match = pattern.exec(prefix) ?? new RegExp(`^${id.replaceAll('.', '\\.')}:(?: now empty; replaces the previous block\\.)$`, 'm').exec(prefix);
    return match ? [{ id, index: match.index }] : [];
  }).sort((a, b) => a.index - b.index);
  if (task) starts.push({ id: 'turn.task', index: task.index });
  if (!starts.length) return [];
  if (starts[0].index > 0) starts.unshift({ id: 'other', index: 0 });
  return starts.map((entry, i) => ({ id: entry.id,
    text: text.slice(entry.index, starts[i + 1]?.index).trim() })).filter(b => b.text);
}

function surfaceOf(blocks, previous) {
  const capabilities = blocks.find(b => b.id === 'turn.capabilities')?.text ?? '';
  const explicit = surfaceMarker.exec(capabilities)?.[1];
  if (explicit) return explicit;
  const place = blocks.find(b => b.id === 'place')?.text ?? '';
  if (/^This is a private direct message with one person:/m.test(place)) return 'DM';
  if (/^(?:This is a Beeline Room\.|This Beeline Room has no linked repository\.)/m.test(place)) return 'Room';
  if (/^(?:You are in an isolated git worktree on |This is a repo-less corner)/m.test(place)) return 'corner';
  return previous;
}

export function turnKind(blocks, surface) {
  const capabilities = blocks.find(b => b.id === 'turn.capabilities')?.text ?? '';
  const task = blocks.find(b => b.id === 'turn.task')?.text ?? '';
  const current = task.replace(/^(?:This is a nonhuman wake\.[^\n]*|Reply to the human message[^\n]*)\n\n/, '');
  if (/^Works here \(schedule run in this /.test(capabilities) || /^Current task from Beeline Scheduler:/.test(current)) return 'schedule-wake';
  // report() supplies these status prefixes; only inspect the current task,
  // never matching an earlier report in the transcript or saved brief.
  if (/^This is a nonhuman wake\./.test(task) &&
      /^Current task from [^\n]+:\s*(?:\[message id: [^\n]+\]\s*)?(?:done|blocked|needs-decision|failed):/.test(current)) return 'agent-report-wake';
  if (blocks.some(b => b.id === 'turn.reviewer-target')) return 'review';
  if (surface === 'DM') return 'dm';
  if (surface === 'Room') return 'room-wake';
  if (surface === 'corner') return 'corner-implementer';
  return 'other';
}

async function* sessionFiles(directory) {
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sessionFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
  }
}

const increment = (histogram, value) => histogram.set(value, (histogram.get(value) ?? 0) + 1);
function median(histogram) {
  const count = [...histogram.values()].reduce((a, b) => a + b, 0);
  if (!count) return null;
  const low = Math.floor((count - 1) / 2), high = Math.floor(count / 2);
  let seen = 0, left;
  for (const [value, n] of [...histogram].sort(([a], [b]) => a - b)) {
    if (left === undefined && seen + n > low) left = value;
    if (seen + n > high) return (left + value) / 2;
    seen += n;
  }
}
const percent = (a, b) => Math.round(a / b * 10000) / 100;

export async function analyzeArchive(archive, splits = DEFAULT_SPLITS) {
  const boundaries = [...new Set(splits.map(value => {
    if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Invalid split time');
    return new Date(value).toISOString();
  }))].sort();
  const windows = Array.from({ length: boundaries.length + 1 }, (_, i) => ({
    window: i, start: boundaries[i - 1] ?? null, end: boundaries[i] ?? null, turns: 0,
  }));
  const groups = new Map();
  const counts = { turns: 0, malformedLines: 0, missingTimestamp: 0 };
  const record = (parts, timestamp, session) => {
    const parsed = parts.map(promptBlocks), blocks = parsed.flat();
    if (!blocks.length && !session.beeline) return;
    session.beeline = true;
    session.surface = surfaceOf(blocks, session.surface);
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) { counts.missingTimestamp++; return; }
    const window = boundaries.filter(split => time >= Date.parse(split)).length;
    const kind = turnKind(blocks, session.surface), key = `${window}:${kind}`;
    const group = groups.get(key) ?? { window, kind, turns: 0, blocks: new Map() };
    group.turns++; groups.set(key, group); windows[window].turns++; counts.turns++;
    const tokens = new Map();
    for (const block of blocks) tokens.set(block.id, (tokens.get(block.id) ?? 0) + estimateTokens(block.text));
    // Include unmarked harness instructions in the delivered-text denominator.
    for (let i = 0; i < parts.length; i++) if (!parsed[i].length)
      tokens.set('other', (tokens.get('other') ?? 0) + estimateTokens(parts[i]));
    const total = [...tokens.values()].reduce((sum, value) => sum + value, 0);
    for (const [id, value] of tokens) {
      const block = group.blocks.get(id) ?? { present: 0, tokens: new Map(), shares: new Map() };
      block.present++; increment(block.tokens, value); increment(block.shares, total ? percent(value, total) : 0);
      group.blocks.set(id, block);
    }
  };
  for await (const path of sessionFiles(archive)) {
    const session = { beeline: false, surface: undefined };
    let pending, instructions = [], base = '', responded = false;
    const flush = () => {
      if (pending) record(pending.parts, pending.timestamp, session);
      pending = undefined; responded = false;
    };
    const input = createReadStream(path);
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { counts.malformedLines++; continue; }
        if (!row || typeof row !== 'object' || Array.isArray(row)) { counts.malformedLines++; continue; }
        if (row.type === 'session_meta') {
          const value = row.payload?.base_instructions;
          base = typeof value === 'string' ? value : value?.text ?? '';
        }
        if (row.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(row.payload?.type)) flush();
        if (row.type === 'response_item' && ['reasoning', 'function_call', 'custom_tool_call'].includes(row.payload?.type)) responded = true;
        if (row.type === 'response_item' && row.payload?.type === 'message') {
          const item = row.payload, texts = messageTexts(item.content);
          if (['system', 'developer'].includes(item.role)) {
            if (pending && !responded) pending.parts.push(...texts);
            else { flush(); instructions.push(...texts); }
          } else if (item.role === 'user' && texts.length) {
            if (pending && !responded) {
              // Codex writes AGENTS/environment and the actual prompt as
              // separate user records before a single assistant response.
              pending.parts.push(...texts); pending.timestamp = row.timestamp;
              continue;
            }
            flush();
            // session_meta is a fallback, not a second copy of explicit rules.
            const prefix = base && !instructions.some(text => text.includes(base)) ? [base, ...instructions] : instructions;
            pending = { timestamp: row.timestamp, parts: [...prefix, ...texts] };
            base = ''; instructions = [];
          } else if (item.role === 'assistant') responded = true;
          // Tool rounds and assistant output are not additional Beeline turns.
        } else if (row.type === 'user' && !row.isMeta && !row.isCompactSummary) {
          const texts = messageTexts(row.message?.content);
          if (texts.length) {
            flush(); pending = { timestamp: row.timestamp, parts: texts };
          }
        }
      }
      flush();
    } finally { lines.close(); input.destroy(); }
  }
  const rows = [...groups.values()].sort((a, b) => a.window - b.window || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind))
    .flatMap(group => BLOCKS.map(id => {
      const block = group.blocks.get(id);
      return { window: group.window, turnKind: group.kind, block: id, turns: group.turns,
        presentTurns: block?.present ?? 0, presencePercent: percent(block?.present ?? 0, group.turns),
        medianTokens: block ? median(block.tokens) : null, medianSharePercent: block ? median(block.shares) : null };
    }));
  return { schemaVersion: 1, tokenEstimate: 'ceil(UTF-8 bytes / 4), matching assembler snapshots; not o200k_base or provider usage',
    scope: 'Newly delivered prompt text per Beeline turn, not retained context, tool schemas/results or provider billing. Medians include present turns only; shares rounded to 0.01 percent. Unknown text is other.',
    counts, windows, rows };
}

export function markdownReport(report) {
  return [
    '# Beeline prompt blocks', '', report.tokenEstimate, '', report.scope, '',
    '| Window | Start (inclusive) | End (exclusive) | Turns |', '| --- | --- | --- | ---: |',
    ...report.windows.map(w => `| ${w.window} | ${w.start ?? 'unbounded'} | ${w.end ?? 'unbounded'} | ${w.turns} |`), '',
    '| Window | Turn kind | Block | Turns | Presence % | Median tokens | Median share % |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...report.rows.map(r => `| ${r.window} | ${r.turnKind} | ${r.block} | ${r.turns} | ${r.presencePercent} | ${r.medianTokens ?? '—'} | ${r.medianSharePercent ?? '—'} |`), '',
    `Turns: ${report.counts.turns}; malformed lines skipped: ${report.counts.malformedLines}; missing timestamps skipped: ${report.counts.missingTimestamp}.`, '',
  ].join('\n');
}

async function main(args, stdout) {
  let archive, out, splits;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--archive', '--out', '--split'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid arguments');
    if (flag === '--archive') archive = args[++i];
    else if (flag === '--out') out = args[++i];
    else (splits ??= []).push(args[++i]);
  }
  if (!archive) throw new Error('Missing archive');
  const report = await analyzeArchive(archive, splits), markdown = markdownReport(report), json = JSON.stringify(report, null, 2) + '\n';
  if (out) {
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'prompt-blocks.md'), markdown);
    await writeFile(join(out, 'prompt-blocks.json'), json);
  } else stdout.write(markdown + '\n' + json);
}

export async function runCli(args, stdout = process.stdout, stderr = process.stderr) {
  try { await main(args, stdout); return 0; } catch {
    // Error messages from JSON/filesystem APIs can contain private text/paths.
    stderr.write('Prompt block analysis failed. Usage: node scripts/prompt-blocks-analysis.mjs --archive <dir> [--out <dir>] [--split <ISO time> ...]\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
