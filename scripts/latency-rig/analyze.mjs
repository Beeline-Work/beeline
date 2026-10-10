#!/usr/bin/env node
/** Analyze correlated device/proxy/server spans. All durations are measured, never inferred. */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const BUDGET_MS = Object.freeze({ route: 450, tap: 150 });

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error(`${label} must be a nonnegative finite number`);
  return value;
}

export function serialDepth(intervals) {
  const sorted = [...intervals].sort((a, b) => a.endMs - b.endMs || a.startMs - b.startMs);
  const depth = [];
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    let value = 1;
    for (let j = 0; j < i; j++)
      if (sorted[j].endMs <= current.startMs) value = Math.max(value, depth[j] + 1);
    depth.push(value);
  }
  return Math.max(0, ...depth);
}

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function validateSpan(span, label) {
  if (!span || typeof span !== 'object') throw new Error(`${label} must be an object`);
  const startMs = finite(span.startMs, `${label}.startMs`);
  const endMs = finite(span.endMs, `${label}.endMs`);
  if (endMs < startMs) throw new Error(`${label} ends before it starts`);
  return { ...span, startMs, endMs };
}

export function summarizeSample(sample) {
  if (!sample || !['route', 'tap'].includes(sample.kind) ||
      typeof sample.name !== 'string' || !sample.name ||
      typeof sample.variant !== 'string' || !sample.variant)
    throw new Error('sample needs kind, name and variant');
  const startMs = finite(sample.startMs, 'sample.startMs');
  const paintMs = finite(sample.paintMs, 'sample.paintMs');
  if (paintMs < startMs) throw new Error('paint precedes action');
  if (sample.canonicalMs !== undefined && finite(sample.canonicalMs, 'canonicalMs') < startMs)
    throw new Error('canonical settlement precedes action');
  const http = (sample.http ?? []).map((span, i) => validateSpan(span, `http[${i}]`));
  const ws = (sample.ws ?? []).map((span, i) => validateSpan(span, `ws[${i}]`));
  const sql = (sample.sql ?? []).map((span, i) => validateSpan(span, `sql[${i}]`));
  for (const [kind, spans] of [['http', http], ['ws', ws], ['sql', sql]])
    for (const [index, span] of spans.entries()) {
      if (span.requestBytes !== undefined) finite(span.requestBytes, `${kind}[${index}].requestBytes`);
      if (span.responseBytes !== undefined) finite(span.responseBytes, `${kind}[${index}].responseBytes`);
      if (span.bytes !== undefined) finite(span.bytes, `${kind}[${index}].bytes`);
      if (span.poolWaitMs !== undefined) finite(span.poolWaitMs, `${kind}[${index}].poolWaitMs`);
    }
  const prepaint = http.filter((span) => span.startMs >= startMs && span.startMs < paintMs);
  const writes = http.filter((span) => span.method && !['GET', 'HEAD', 'OPTIONS'].includes(span.method));
  const followupReads = http.filter((span) => span.method === 'GET' &&
    writes.some((write) => span.startMs >= write.endMs));
  const sqlByOperation = Object.groupBy(sql, (span) => span.operation ?? 'unknown');
  return {
    kind: sample.kind, name: sample.name, variant: sample.variant,
    fixture: sample.fixture ?? '',
    paintMs: paintMs - startMs,
    canonicalMs: sample.canonicalMs === undefined ? null : finite(sample.canonicalMs, 'canonicalMs') - startMs,
    prepaintHttpCount: prepaint.length,
    prepaintHttpDepth: serialDepth(prepaint),
    prepaintCompletedRoundTrips: prepaint.filter((span) => span.endMs <= paintMs).length,
    writeCount: writes.length, followupReadCount: followupReads.length,
    httpCount: http.length,
    httpRequestBytes: http.reduce((sum, span) => sum + (span.requestBytes ?? 0), 0),
    httpResponseBytes: http.reduce((sum, span) => sum + (span.responseBytes ?? 0), 0),
    wsFrames: ws.filter((span) => span.granularity === 'frame').length,
    wsMessages: ws.filter((span) => span.granularity !== 'frame').length,
    wsBytes: ws.reduce((sum, span) => sum + (span.bytes ?? 0), 0),
    sqlStatements: sql.length,
    sqlDepth: serialDepth(sql),
    sqlPoolWaitMs: sql.reduce((sum, span) => sum + (span.poolWaitMs ?? 0), 0),
    sqlOperations: Object.fromEntries(Object.entries(sqlByOperation).map(([operation, spans]) => [operation, {
      count: spans.length, depth: serialDepth(spans),
      poolWaitMs: spans.reduce((sum, span) => sum + (span.poolWaitMs ?? 0), 0),
    }])),
  };
}

export function summarize(samples, routes = [], interactions = []) {
  const grouped = new Map();
  for (const raw of samples) {
    const sample = summarizeSample(raw);
    const key = `${sample.kind}\u0000${sample.name}\u0000${sample.variant}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(sample);
  }
  const routeBudget = new Map(routes.map((route) => [route.path, route]));
  const rows = [...grouped.values()].map((items) => {
    const first = items[0];
    const budget = first.kind === 'route' ? routeBudget.get(first.name) : undefined;
    const maxRequests = first.kind === 'route'
      ? (first.variant === 'warm' ? 0 : budget?.coldHttpMax ?? 1) : 1;
    const maxDepth = first.kind === 'route'
      ? (first.variant === 'warm' ? 0 : budget?.coldDepthMax ?? 1) : 1;
    const maxObserved = (key) => Math.max(...items.map((item) => item[key]));
    const p95 = percentile(items.map((item) => item.paintMs), .95);
    return {
      kind: first.kind, name: first.name, variant: first.variant, samples: items.length,
      p50Ms: percentile(items.map((item) => item.paintMs), .5), p95Ms: p95,
      p99Ms: percentile(items.map((item) => item.paintMs), .99),
      worstMs: maxObserved('paintMs'),
      maxPrepaintHttpCount: maxObserved('prepaintHttpCount'),
      maxPrepaintHttpDepth: maxObserved('prepaintHttpDepth'),
      maxPrepaintCompletedRoundTrips: maxObserved('prepaintCompletedRoundTrips'),
      maxWrites: maxObserved('writeCount'), maxFollowupReads: maxObserved('followupReadCount'),
      maxHttpBytes: Math.max(...items.map((item) => item.httpRequestBytes + item.httpResponseBytes)),
      maxWsFrames: maxObserved('wsFrames'), maxWsMessages: maxObserved('wsMessages'),
      maxWsBytes: maxObserved('wsBytes'),
      maxSqlStatements: maxObserved('sqlStatements'), maxSqlDepth: maxObserved('sqlDepth'),
      maxSqlPoolWaitMs: maxObserved('sqlPoolWaitMs'),
      budgetMs: BUDGET_MS[first.kind], maxRequests, maxDepth,
      timingPass: p95 < BUDGET_MS[first.kind],
      requestPass: maxObserved('prepaintHttpCount') <= maxRequests &&
        maxObserved('prepaintHttpDepth') <= maxDepth &&
        (first.kind !== 'tap' || items.every((item) => item.writeCount === 1 &&
          item.followupReadCount === 0 && item.prepaintCompletedRoundTrips === 0)),
    };
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.variant.localeCompare(b.variant));
  const missingRoutes = routes.map((route) => route.path)
    .filter((path) => !rows.some((row) => row.kind === 'route' && row.name === path));
  const missingRouteVariants = routes.flatMap((route) => ['cold', 'warm'].filter((variant) =>
    !rows.some((row) => row.kind === 'route' && row.name === route.path && row.variant === variant))
    .map((variant) => ({ path: route.path, variant, coldHttpMax: route.coldHttpMax,
      coldDepthMax: route.coldDepthMax })));
  const missingInteractions = interactions.filter((name) =>
    !rows.some((row) => row.kind === 'tap' && row.name === name));
  return { rows, missingRoutes, missingRouteVariants, missingInteractions,
    complete: missingRouteVariants.length === 0 && missingInteractions.length === 0,
    timingPass: rows.every((row) => row.timingPass),
    requestPass: rows.every((row) => row.requestPass) };
}

export function markdown(report, metadata = {}) {
  const ms = (value) => `${Math.round(value)} ms`;
  const lines = [
    '# Beeline latency rig report', '',
    `- Commit: ${metadata.commit ?? 'unknown'}`,
    `- Device: ${metadata.device ?? 'unknown'}`,
    `- Network: ${metadata.network ?? 'unknown'}`,
    `- Samples: ${report.rows.reduce((sum, row) => sum + row.samples, 0)}`, '',
    ...(metadata.note ? [metadata.note, ''] : []),
    '| Kind | Screen or action | Variant | n | p50 | p95 | p99 | Budget | Prepaint HTTP max/depth | WS frames/messages | Payload bytes max | SQL max/depth/wait | Result |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const row of report.rows) lines.push(
    `| ${row.kind} | ${row.name} | ${row.variant} | ${row.samples} | ${ms(row.p50Ms)} | ${ms(row.p95Ms)} | ${ms(row.p99Ms)} | <${row.budgetMs} ms | ${row.maxPrepaintHttpCount}/${row.maxPrepaintHttpDepth} (≤${row.maxRequests}/≤${row.maxDepth}) | ${row.maxWsFrames}/${row.maxWsMessages} | ${row.maxHttpBytes + row.maxWsBytes} | ${row.maxSqlStatements}/${row.maxSqlDepth}/${row.maxSqlPoolWaitMs} ms | ${row.timingPass && row.requestPass ? 'PASS' : 'FAIL'} |`,
  );
  for (const route of report.missingRouteVariants)
    lines.push(`| route | ${route.path} | ${route.variant} | 0 | — | — | — | <450 ms | ${route.variant === 'cold' ? `≤${route.coldHttpMax}/≤${route.coldDepthMax}` : '0/0'} | — | — | — | UNMEASURED |`);
  for (const name of report.missingInteractions)
    lines.push(`| tap | ${name} | — | 0 | — | — | — | <150 ms | 1 write, 0 follow-up GET | — | — | — | UNMEASURED |`);
  if (report.missingRouteVariants.length) lines.push('',
    `Unmeasured route variants: ${report.missingRouteVariants.map((item) => `${item.path} (${item.variant})`).join(', ')}`);
  if (report.missingInteractions.length) lines.push('',
    `Unmeasured interactions: ${report.missingInteractions.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const input = option('--input');
  if (!input || input.startsWith('--')) throw new Error('usage: analyze.mjs --input samples.ndjson --routes routes.json [--out report.md] [--check]');
  const raw = await readFile(input, 'utf8');
  const samples = raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`invalid JSON on input line ${index + 1}`); }
  });
  const routes = args.includes('--routes') ? JSON.parse(await readFile(option('--routes'), 'utf8')) : [];
  const interactions = args.includes('--interactions')
    ? JSON.parse(await readFile(option('--interactions'), 'utf8')) : [];
  const report = summarize(samples, routes, interactions);
  const output = markdown(report, {
    commit: option('--commit') ?? 'unknown',
    device: option('--device') ?? 'unknown',
    network: option('--network') ?? 'unknown',
    note: option('--note'),
  });
  if (args.includes('--out')) await writeFile(option('--out'), output);
  else process.stdout.write(output);
  if (args.includes('--check') && (!report.complete || !report.timingPass || !report.requestPass))
    process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
