import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const APPS = ['beeline-server', 'beeline-free-agents', 'beeline-voice-livekit'];
const GAP = 10 * 60 * 1000;
const iso = value => new Date(value).toISOString();
const sorted = map => [...map.values()].sort((a, b) => b.count - a.count);
const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

// Fly text and JSON envelopes both occur in collector output. Ignore Fly's
// level: application errors are often wrapped in an info envelope.
function decode(line) {
  let message = line;
  try {
    const envelope = JSON.parse(line);
    message = envelope.message ?? envelope.msg ?? line;
    if (typeof message !== 'string') message = JSON.stringify(message);
    return { time: Date.parse(envelope.timestamp ?? envelope.time), message };
  } catch {
    return { time: Date.parse(line.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/)?.[0] ?? ''), message };
  }
}
function pattern(message) {
  return message.replace(/^.*?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\s*/, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{24,}\b/gi, '<id>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>').slice(0, 400);
}

export async function walk({ raw, state, out, hours = 24, now = Date.now() }) {
  const start = now - hours * 3600000;
  const patterns = new Map(), identities = new Map(), routes = new Map(), jobs = new Map(), clocks = new Map();
  const coverage = [];
  let ignoredLines = 0;
  for (const app of APPS) {
    const times = new Set();
    let lines = 0;
    let files = [];
    try { files = await readdir(join(raw, app)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const file of files.sort()) {
      if (!/^\d{4}-\d\d-\d\d\.log$/.test(file)) continue;
      const day = Date.parse(file.slice(0, 10));
      if (day > now || day + 86400000 < start) continue;
      const input = createInterface({ input: createReadStream(join(raw, app, file)), crlfDelay: Infinity });
      for await (const line of input) {
        const { time, message } = decode(line);
        if (!Number.isFinite(time)) { ignoredLines++; continue; }
        if (time < start || time > now) continue;
        lines++;
        // A minute bucket bounds coverage memory even for very busy apps.
        times.add(Math.floor(time / 60000) * 60000);
        const key = `${app}: ${pattern(message)}`;
        const row = patterns.get(key) ?? { pattern: key, count: 0, error: false };
        row.count++;
        row.error ||= /error|exception|refus|denied|failed|failure|timeout|timed out|status[=: ]+[45]\d\d|\b[45]\d\d\s+(?:GET|POST)/i.test(message);
        patterns.set(key, row);
        const identity = message.match(/identity(?:Id)?[=: ]+([\w-]+)/)?.[1];
        if (identity) {
          increment(identities, identity);
          const clockKey = `${identity}: ${key}`;
          const clock = clocks.get(clockKey) ?? { identity, pattern: key, count: 0, first: time, last: time, intervals: 0, sum: 0, squares: 0 };
          // Collector files are chronological. Duplicate/reordered lines do not
          // count as intervals when deciding whether a pattern runs on a clock.
          if (time > clock.last) {
            const delta = time - clock.last;
            clock.intervals++; clock.sum += delta; clock.squares += delta * delta;
          }
          clock.count++; clock.last = Math.max(time, clock.last); clocks.set(clockKey, clock);
        }
        const route = message.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s?]+)/);
        if (route) increment(routes, `${route[1]} ${route[2]}`);
        const job = message.match(/\[(?:job|background)[^\]]*\]|\bjob[=: ]+[\w-]+/i)?.[0];
        if (job) increment(jobs, job);
      }
    }
    const ordered = [...times].sort((a, b) => a - b);
    const gaps = [];
    const edges = [start, ...ordered.map(t => Math.max(start, t)), now];
    for (let i = 1; i < edges.length; i++) {
      if (edges[i] - edges[i - 1] > GAP) gaps.push({ from: iso(edges[i - 1]), to: iso(edges[i]), minutes: (edges[i] - edges[i - 1]) / 60000, edge: i === 1 ? 'head' : i === edges.length - 1 ? 'tail' : 'interior' });
    }
    coverage.push({ app, lines, gaps, complete: gaps.length === 0 });
  }
  let previous = null;
  await mkdir(state, { recursive: true });
  // Exclude today so repeated dispatches compare with the prior day's walk.
  const today = iso(now).slice(0, 10);
  const candidates = (await readdir(state)).filter(name => /^\d{4}-\d\d-\d\d\.json$/.test(name) && name < `${today}.json`).sort();
  if (candidates.length) previous = JSON.parse(await readFile(join(state, candidates.at(-1)), 'utf8'));
  const prior = new Map((previous?.patterns ?? []).map(row => [row.pattern, row.count]));
  const all = sorted(patterns);
  const loops = [...clocks.values()].filter(row => {
    const mean = row.sum / row.intervals;
    return row.intervals >= 4 && mean >= 1000 && Math.sqrt(Math.max(0, row.squares / row.intervals - mean * mean)) / mean < 0.2;
  }).map(row => ({ identity: row.identity, pattern: row.pattern, count: row.count, seconds: row.sum / row.intervals / 1000 }));
  const report = {
    generatedAt: iso(now), window: { from: iso(start), to: iso(now), hours }, baseline: previous?.generatedAt ?? null,
    coverage, ignoredLines, patterns: all, errors: all.filter(row => row.error),
    newOrUp: all.filter(row => !prior.has(row.pattern) || row.count > prior.get(row.pattern) * 1.5).map(row => ({ ...row, previous: prior.get(row.pattern) ?? 0 })),
    gone: [...prior].filter(([key]) => !patterns.has(key)).map(([pattern, count]) => ({ pattern, count })),
    loops, identities: [...identities].sort((a, b) => b[1] - a[1]), routes: [...routes].sort((a, b) => b[1] - a[1]), jobs: [...jobs].sort((a, b) => b[1] - a[1]),
    limitations: ['Coverage is inferred from log traffic; silence needs operator confirmation, especially suspended free agents.', 'Untimestamped lines cannot be assigned to the window.', 'Patterns and loops are heuristic flags; dedupe against the problem log and trace to code.', 'Gone patterns are meaningful only when both windows have complete coverage.'],
  };
  const section = (title, data) => `\n## ${title}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
  const markdown = `# Production log walk\n\n${report.window.from} to ${report.window.to}\n\nBaseline: ${report.baseline ?? 'unavailable — first run'}\n`
    + section('Coverage (check before interpreting findings)', coverage)
    + section('Errors and refusals', report.errors.slice(0, 100))
    + section('New or up vs baseline', report.newOrUp.slice(0, 100))
    + section('Gone', report.gone.slice(0, 100)) + section('Loops', loops.slice(0, 100))
    + section('Heaviest identities (private)', report.identities.slice(0, 30))
    + section('Busiest routes', report.routes.slice(0, 30)) + section('Background job counts', report.jobs)
    + section('Logging gaps and limitations', { ignoredLines, limitations: report.limitations });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(out, 'report.md'), markdown);
  const baselineFile = join(state, `${today}.json`);
  await writeFile(`${baselineFile}.tmp`, JSON.stringify({ generatedAt: report.generatedAt, patterns: all }));
  await rename(`${baselineFile}.tmp`, baselineFile);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { raw: { type: 'string' }, state: { type: 'string' }, out: { type: 'string' }, hours: { type: 'string', default: '24' }, now: { type: 'string' } } });
  const hours = Number(values.hours), now = values.now ? Date.parse(values.now) : Date.now();
  if (!values.raw || !values.state || !values.out || !Number.isFinite(hours) || hours <= 0 || hours > 192 || !Number.isFinite(now)) throw new Error('Provide --raw --state --out and a valid --hours (up to 192) / --now');
  await walk({ ...values, hours, now });
}
