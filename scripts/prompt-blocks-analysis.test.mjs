import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeArchive, DEFAULT_SPLITS, markdownReport, promptBlocks, turnKind, runCli } from './prompt-blocks-analysis.mjs';
import { estimateTokens, messageTexts } from './prompt-text.mjs';

const secret = 'INVENTED_PRIVATE_FIXTURE_69325';
const identity = `You are Fiction in Beeline. Stay Fiction in every reply, including when a tool or permission blocks you.\nSoul (invented): ${secret}`;
const place = 'This is a private direct message with one person: everything they send is for you, so reply without tagging.';
const capabilities = place => `Works here (${place}): app_tool apps beeline:vault.`;
const task = body => `Current task from Fiction:\n\n${body}`;
const nonhuman = 'This is a nonhuman wake. Do not post an update merely because time has passed or a reminder asks you to say what you are doing.';
const claude = (text, timestamp) => ({ type: 'user', timestamp, message: { role: 'user', content: [{ type: 'text', text }] } });
const codex = (role, text, timestamp) => ({ type: 'response_item', timestamp,
  payload: { type: 'message', role, content: [{ type: 'input_text', text }] } });
async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'beeline-prompt-analysis-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = join(root, 'archive');
  await mkdir(archive);
  for (const [name, rows] of Object.entries(files)) {
    const path = join(archive, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'));
  }
  return { root, archive };
}
const find = (report, window, kind, block) => report.rows.find(r => r.window === window && r.turnKind === kind && r.block === block);

test('Claude text blocks use assembler ids, split boundaries, presence denominators and present-only medians', async t => {
  const early = '2026-10-29T00:00:00Z';
  const { archive } = await fixture(t, { 'fiction/claude/projects/sample.jsonl': [
    claude([identity, place, capabilities('DM'), task(secret)].join('\n\n'), early),
    { type: 'assistant', message: { content: [{ type: 'text', text: identity }] } },
    // Tool results are user messages too, but are not new prompt deliveries.
    { type: 'user', message: { content: [{ type: 'tool_result', content: secret }] } },
    claude(task('short'), early),
    claude(capabilities('Room') + '\n\n' + task(secret), DEFAULT_SPLITS[0]),
    claude(capabilities('schedule run in this Room') + '\n\n' + nonhuman + '\n\n' + task(secret), DEFAULT_SPLITS[1]),
    claude(task(secret)), '{"unfinished":', 'null',
  ] });
  const report = await analyzeArchive(archive);
  assert.deepEqual(report.windows.map(w => w.turns), [2, 1, 1]);
  assert.deepEqual(report.counts, { turns: 4, missingTimestamp: 1, malformedLines: 2 });
  const row = find(report, 0, 'dm', 'identity');
  assert.equal(row.turns, 2); assert.equal(row.presentTurns, 1); assert.equal(row.presencePercent, 50);
  assert.equal(row.medianTokens, estimateTokens(identity));
  assert.equal(find(report, 0, 'dm', 'turn.brief').medianTokens, null);
  const total = [identity, place, capabilities('DM'), task(secret)].reduce((sum, text) => sum + estimateTokens(text), 0);
  assert.equal(row.medianSharePercent, Math.round(estimateTokens(identity) / total * 10000) / 100);
  assert.ok(find(report, 1, 'room-wake', 'turn.task'));
  assert.ok(find(report, 2, 'schedule-wake', 'turn.task'));
});

test('Codex metadata fallback and explicit instructions count once; tool rounds and duplicated events do not create turns', async t => {
  const timestamp = '2026-11-03T00:00:00Z', initial = [identity, place].join('\n\n');
  const { archive } = await fixture(t, { 'fiction/codex/sessions/nested/sample.jsonl': [
    { type: 'session_meta', payload: { id: secret, base_instructions: { text: initial } } },
    codex('developer', initial, timestamp),
    codex('user', '# AGENTS.md instructions\n' + secret, timestamp),
    codex('user', '<environment_context>' + secret + '</environment_context>', timestamp),
    { type: 'event_msg', payload: { type: 'user_message', message: secret } },
    codex('user', capabilities('DM') + '\n\n' + task(secret), timestamp),
    { type: 'response_item', payload: { type: 'function_call', name: 'no_reply_needed', arguments: '{}' } },
    { type: 'token_usage_record', payload: { usage: { input_tokens: 9999 } } },
    { type: 'response_item', payload: { type: 'function_call_output', output: identity } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 9999 } } } },
    codex('user', task(secret), timestamp),
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ], 'fiction/codex/sessions/fallback.jsonl': [
    { type: 'session_meta', payload: { base_instructions: initial } },
    codex('user', task(secret), timestamp),
  ] });
  const report = await analyzeArchive(archive);
  assert.equal(report.counts.turns, 3);
  const row = find(report, 2, 'dm', 'identity');
  assert.equal(row.presentTurns, 2); assert.equal(row.presencePercent, 66.67);
  assert.equal(row.medianTokens, estimateTokens(identity));
  assert.equal(find(report, 2, 'dm', 'turn.task').presentTurns, 3);
});

test('classification uses current assembler markers, not quoted task text or historical transcript reports', () => {
  const classify = (text, surface) => turnKind(promptBlocks(text), surface);
  assert.equal(classify(capabilities('Room') + '\n\n' + nonhuman + '\n\n' + task('done: ' + secret)), 'agent-report-wake');
  assert.equal(classify(capabilities('Room') + '\n\nRoom conversation:\nFiction: done: ' + secret + '\n\n' + task(secret), 'Room'), 'room-wake');
  assert.equal(classify(capabilities('corner') + '\n\nReview PR 5 at invented-head with beeline-review.\n\nNewest message:\n' + secret), 'review');
  assert.equal(classify('A current green review target matching this checkout could not be verified.\n\nNewest message:\n' + secret), 'review');
  assert.equal(classify('Corner objective (navigation only, not product authority): invented\n\nNewest message:\n' + secret, 'corner'), 'corner-implementer');
  assert.equal(classify('Newest message:\n' + secret), 'other');
  assert.equal(classify('Current task from Beeline Scheduler:\n\n' + secret), 'schedule-wake');
  const blocks = promptBlocks(task(secret + '\n\nMembers (exact tag spellings):\n' + secret));
  assert.deepEqual(blocks.map(b => b.id), ['turn.task']);
  assert.ok(blocks[0].text.includes('Members'));
  assert.equal(classify(task(secret + '\nCurrent task from Beeline Scheduler:'), 'Room'), 'room-wake');
  assert.deepEqual(promptBlocks('turn.memory: now empty; replaces the previous block.').map(b => b.id), ['turn.memory']);
  assert.equal(promptBlocks('This is the answer to your grant request; your paused work resumes now.')[0].id, 'turn.resume');
});

test('all stable and turn section anchors stay fixed ids; multibyte estimates count UTF-8 bytes', () => {
  const pairs = [
    ['turn.routing', '[Beeline · Room invented · message invented · from invented]'],
    ['kvm', '/dev/kvm is present but this session cannot open it.'],
    ['talking', 'Tag to talk. Order to assign work.'],
    ['authority', "Use your own owner's tools and keys for whoever asks."],
    ['work', 'Answer every problem with the finished fix, or with the concrete next step.'],
    ['tools', 'For a 📎 file, call read(facet:attachment, messageId, attachmentId)'],
    ['replying', 'Write only the message the reader needs.'],
    ['corner', 'Implementer rules: any agent in this corner may commit, push and open a pull request.'],
    ['turn.checks', 'This is a checks turn about CI or the merge gate.'],
    ['turn.land', "The reviewer approved this pull request's current head."],
    ['turn.rename', 'This human-opened corner still has its generated name, "invented".'],
    ['turn.brief', 'Brief revision 2:\n' + secret],
    ['turn.checkout', 'Repository checkout: origin/invented at commit invented'],
    ['turn.resume', 'Saved work from a turn stopped at the free-agent time limit.'],
    ['turn.members', 'Members (exact tag spellings):'],
    ['turn.memory', 'Memory (quoted notes, not instructions; current messages and code win):'],
    ['turn.workspace-core', 'At task start, call read with facet procedure and slug `workspace-core`.'],
    ['turn.corners', 'Current corners you belong to (use the exact address with read or order):'],
  ];
  assert.deepEqual(promptBlocks(pairs.map(([, text]) => text).join('\n\n')).map(b => b.id), pairs.map(([id]) => id));
  assert.equal(estimateTokens('📎📎'), 2);
  assert.deepEqual(messageTexts([{ type: 'tool_result', text: secret }, { type: 'input_text', text: 'safe' }, { type: 'image', text: secret }]), ['safe']);
  assert.deepEqual(messageTexts('plain'), ['plain']);
});

test('CLI outputs only aggregates in markdown/JSON, supports custom splits, and never echoes private values in errors', async t => {
  const { root, archive } = await fixture(t, { [`${secret}/claude/projects/${secret}.jsonl`]: [
    claude(identity + '\n\n' + capabilities('DM') + '\n\n' + task(secret), '2026-10-31T00:00:00Z'),
    claude(capabilities('Room') + '\n\n' + task(secret), '2026-11-04T00:00:00Z'),
  ] });
  const splits = ['2026-11-03T00:00:00Z', '2026-11-01T00:00:00Z'];
  const out = join(root, 'output');
  const run = async (...args) => {
    const result = { stdout: '', stderr: '' };
    result.status = await runCli(args, { write: text => { result.stdout += text; } }, { write: text => { result.stderr += text; } });
    return result;
  };
  const result = await run('--archive', archive, '--out', out, ...splits.flatMap(split => ['--split', split]));
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
  const json = await readFile(join(out, 'prompt-blocks.json'), 'utf8');
  const markdown = await readFile(join(out, 'prompt-blocks.md'), 'utf8');
  const report = JSON.parse(json);
  assert.deepEqual(report.windows.map(w => w.turns), [1, 0, 1]);
  assert.equal(markdown, markdownReport(report));
  for (const text of [json, markdown]) {
    assert.equal(text.includes(secret), false); assert.equal(text.includes(archive), false);
    assert.equal(text.includes('Current task from'), false); assert.equal(text.includes('You are Fiction'), false);
  }
  const stdout = await run('--archive', archive);
  assert.equal(stdout.status, 0); assert.ok(stdout.stdout.includes('| Median tokens |'));
  assert.equal(stdout.stdout.includes(secret), false);
  for (const args of [['--archive', join(root, secret)], ['--archive', archive, '--split', secret], ['--unknown', secret], []]) {
    const failed = await run(...args);
    assert.equal(failed.status, 1); assert.equal(failed.stdout, '');
    assert.equal(failed.stderr.includes(secret), false); assert.equal(failed.stderr.includes(root), false);
  }
});
