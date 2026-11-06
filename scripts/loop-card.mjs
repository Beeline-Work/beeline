#!/usr/bin/env node
// Compile a small approval card into the existing human-gated workflow engine.
// No credentials, writes, model calls or production side effects.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function line(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value) || value.length > maximum)
    throw new Error(`${name} must be a nonempty line of at most ${maximum} characters`);
  return value;
}

export function buildLoopCard({ kind, date, sourceSha, releaseLine, tuples }) {
  if (!['morning', 'insight'].includes(kind)) throw new Error('unknown card kind');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('invalid date or deployed SHA');
  if (!Array.isArray(tuples)) throw new Error('tuples must be an array');
  if (kind === 'morning') line(releaseLine, 'releaseLine', 240);
  const seen = new Set();
  for (const tuple of tuples) {
    line(tuple.key, 'key', 120);
    if (seen.has(tuple.key)) throw new Error(`duplicate problem: ${tuple.key}`);
    seen.add(tuple.key);
    if (tuple.sourceSha !== sourceSha) throw new Error(`stale or unverified tuple: ${tuple.key}`);
    for (const field of ['problem', 'consequence', 'fix']) line(tuple[field], field, 100);
    if (tuple.problem.length + tuple.consequence.length + tuple.fix.length > 150)
      throw new Error(`tuple does not fit one screen: ${tuple.key}`);
    if (!['high', 'medium', 'low'].includes(tuple.confidence)) throw new Error('invalid confidence');
    if (typeof tuple.openQuestion !== 'boolean') throw new Error('openQuestion must be explicit');
    if (!/^https:\/\/\S+$/.test(tuple.evidence) && !/^#beeline\/\S+$/.test(tuple.evidence)) throw new Error('evidence link required');
  }
  const selected = tuples.slice(0, 3);
  const lines = kind === 'morning' ? [releaseLine] : [];
  selected.forEach((t, i) => lines.push(`${i+1}. ${t.openQuestion ? 'OPEN QUESTION: ' : ''}${t.problem} (${t.consequence}) → ${t.fix} · ${t.confidence} · [evidence](${t.evidence})`));
  if (!selected.length) lines.push('Nothing found.');
  const actionable = selected.map((t, i) => ({ ...t, number:i+1 })).filter(t => !t.openQuestion);
  let contract = null;
  if (actionable.length) {
    const digest = createHash('sha256').update(JSON.stringify({kind,date,sourceSha,selected})).digest('hex').slice(0,10);
    const handoffs = {
      done: { kind:'terminal', status:'done', does:'No more fix approvals in this card.' },
      failed: { kind:'terminal', status:'failed', does:'Fix dispatch needs attention; no remaining fix was approved.' },
    };
    const gate = mask => mask ? `choose_${mask}` : 'done';
    for (let mask=1; mask < (1 << actionable.length); mask++) {
      const on = {};
      actionable.forEach((tuple,i) => {
        if (!(mask & (1<<i))) return;
        const target = `open_${mask}_${tuple.number}`;
        on[`approve_${tuple.number}`] = target;
        handoffs[target] = {
          does: tuple.fix.slice(0,80), role:'curator', requires:['tupleKey','cornerAddress'],
          hint: `Read docs/loops/contract.md Cards. This human tap approves only tuple ${tuple.key}. Recheck freshness and the ledger. Reuse its existing corner on retries; never open twice. Open/order its fix corner with this exact spec, record its address, then advance opened with tupleKey and cornerAddress. If stale or already resolved advance stale with tupleKey and cornerAddress="none". Never merge or release from this tap. Tuple: ${JSON.stringify(tuple)}`,
          on: { opened:gate(mask & ~(1<<i)), stale:gate(mask & ~(1<<i)), timeout:'failed' }, timeoutSeconds:600,
        };
      });
      on.skip = 'done';
      handoffs[gate(mask)] = {
        kind:'gate', role:'curator', does:'Approve a proposed fix from the card above.', requires:['decision'],
        on, timeoutSeconds:8*3600, default:'skip',
      };
    }
    contract = { version:1, name:`loop-${kind}-${date}-${digest}`, description:'Approve daily loop fixes one at a time',
      summary:'Each approval opens that fix corner; Skip leaves remaining fixes unapproved.',
      roles:['curator'], start:gate((1<<actionable.length)-1), deadlineSeconds:8*3600, handoffs };
  }
  return { text:lines.join('\n'), contract, presentedKeys:selected.map(t=>t.key), deferredKeys:tuples.slice(3).map(t=>t.key) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.stdout.write(JSON.stringify(buildLoopCard(JSON.parse(readFileSync(0,'utf8'))),null,2)+'\n');
