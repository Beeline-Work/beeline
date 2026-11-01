// Run with: node --import tsx --test scripts/prompt-case-rules.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { caseOutcome, evaluateRule, parsePromptCase, type Rule, type Transcript } from './prompt-case-rules.js';

const turn: Transcript = {
  calls: [
    { name: 'order', args: { address: 'c-1', agent: 'juniper', text: 'Run the checklist.' } },
    { name: 'Bash', args: { command: 'git ls-remote --exit-code origin feature/x' } },
  ],
  text: 'Asked @juniper to run it.',
};
const pass = (rule: Rule) => evaluateRule(rule, turn).pass;

test('repo-less Room case accepts header navigation and rejects referrals to another Room', () => {
  const saved = JSON.parse(readFileSync(join(__dirname, '../docs/prompts/cases/room-no-repo-guides-link.json'), 'utf8'));
  const guidance = 'This Room has no linked repository; use Room header → Repository → Link or Create.';
  assert.equal(evaluateRule(saved.pass, { calls: [], text: guidance }).pass, true);
  for (const accepted of [
    'I cannot write it here directly, because this Room has no linked repository.',
    'That is because this Room has no linked repository.',
    'I never send you to another Room.',
    "I'll never shuffle you off to another Room.",
  ]) {
    assert.equal(evaluateRule(saved.pass, { calls: [], text: `${guidance} ${accepted}` }).pass, true, accepted);
  }
  for (const referral of [
    'Point me at the Room with the linked repository.',
    'Go to a Room with a linked repository.',
    'Use another Room.',
    'Please switch to a different Room.',
    'Create a repository-backed Room.',
    "The Room's repository filesystem is read-only.",
  ]) {
    assert.equal(evaluateRule(saved.pass, { calls: [], text: `${guidance} ${referral}` }).pass, false, referral);
  }
});

test('shipped status allows parenthesized references and rejects work numbers outside them', async () => {
  const { readFileSync } = await import('node:fs');
  const rule = JSON.parse(readFileSync('docs/prompts/cases/long-incident-shipped-status.json', 'utf8')).pass as Rule;
  const grade = (text: string) => evaluateRule(rule, { calls: [], text }).pass;
  for (const reference of ['PR #86', '#86', 'PR 86', '86']) {
    assert.equal(grade(`Expired sessions now fail clearly at sign-in (${reference}).`), true, reference);
  }
  for (const reference of ['PR #86', '#86', 'PR 86', '86']) {
    assert.equal(grade(`${reference} is done. Expired sessions now fail clearly at sign-in.`), false, reference);
  }
  assert.equal(grade('Expired sessions now fail clearly at sign-in (PR #86). The onboarding animation shipped.'), false);
});

test('rule 08 allows parenthesized references but rejects numbers naming the work', async () => {
  const { readFileSync } = await import('node:fs');
  const rule = JSON.parse(readFileSync('docs/prompts/cases/memory-rule-08.json', 'utf8')).pass as Rule;
  const grade = (text: string) => evaluateRule(rule, { calls: [], text }).pass;
  for (const reference of ['PR #73', '#73', 'PR 73', '73', '401, merged in pull request 73']) {
    assert.equal(grade(`Expired tokens now return 401 (${reference}).`), true, reference);
  }
  for (const text of ['Merged #73.', 'PR #73 is done.',
    'Expired tokens now return 401. Merged #73.',
    'Expired tokens now return 401. PR #73 is done.',
    'Expired tokens now return 401. 73 is done.',
    'Expired tokens now return 401 (#73). PR #73 is done.']) {
    assert.equal(grade(text), false, text);
  }
});

test('call and noCall match tool names and argument matchers', () => {
  assert.equal(pass({ call: 'order', args: { address: 'c-1' } }), true);
  assert.equal(pass({ call: 'order', args: { address: 'c-2' } }), false);
  assert.equal(pass({ call: 'Bash', args: { command: { contains: 'ls-remote' } } }), true);
  assert.equal(pass({ noCall: 'Bash', args: { command: { matches: 'push.*--force' } } }), true);
  assert.equal(pass({ noCall: 'order' }), false);
  assert.equal(pass({ call: 'order', args: { '*': { contains: '"agent":"juniper"' } } }), true);
  assert.equal(pass({ call: 'order', args: { agent: { not: 'pebble' } } }), true);
});

test('text, all, any and not combine', () => {
  assert.equal(pass({ text: { matches: '@juniper\\b' } }), true);
  assert.equal(pass({ text: { not: { matches: '@pebble' } } }), true);
  assert.equal(pass({ all: [{ call: 'order' }, { text: { contains: 'nothing' } }] }), false);
  assert.equal(pass({ any: [{ call: 'merge_corner' }, { call: 'order' }] }), true);
  assert.equal(pass({ not: { call: 'merge_corner' } }), true);
  assert.match(evaluateRule({ call: 'merge_corner' }, turn).reason, /saw order/);
});

test('a case passes at need of total samples and stops sampling once settled', () => {
  assert.equal(caseOutcome([true, true], 3, 2), 'pass');
  assert.equal(caseOutcome([false, false], 3, 2), 'fail');
  assert.equal(caseOutcome([true, false], 3, 2), 'open');
  assert.equal(caseOutcome([true, false, false], 3, 2), 'fail');
});

test('parsePromptCase refuses malformed cases', () => {
  const valid = {
    id: 'x',
    section: 'talking',
    summary: 'Tags exactly.',
    place: 'room',
    turn: { task: { body: 'hi' } },
    pass: { text: 'ok' },
  };
  assert.equal(parsePromptCase(valid, 'x', []).id, 'x');
  assert.throws(() => parsePromptCase({ ...valid, id: 'y' }, 'x', []), /file name/);
  assert.throws(() => parsePromptCase({ ...valid, place: 'office' }, 'x', []), /place/);
  assert.throws(() => parsePromptCase({ ...valid, tools: ['Write'] }, 'x', ['Bash']), /unknown tool/);
  assert.throws(() => parsePromptCase({ ...valid, pass: { calls: 'order' } }, 'x', []), /unknown rule/);
  assert.throws(() => parsePromptCase({ ...valid, pass: { text: { matches: '(' } } }, 'x', []), /Invalid regular expression/);
  assert.throws(() => parsePromptCase({ ...valid, extra: 1 }, 'x', []), /unknown keys/);
});

test('skill loads require the actual native read and precede the first retry', async () => {
  const { skillPath, validateRuleSkills } = await import('./prompt-case-rules.js');
  const rule: Rule = { skill: 'beeline-files-and-mocks', beforeRetry: 'post_artifact' };
  const load = { name: 'Read', args: { file_path: skillPath('beeline-files-and-mocks') } };
  const retry = { name: 'post_artifact', args: { path: '/tmp/report.html' } };
  assert.equal(evaluateRule(rule, { calls: [load, retry], text: '' }).pass, true);
  assert.equal(evaluateRule(rule, { calls: [retry, load, retry], text: '' }).pass, false);
  assert.equal(evaluateRule(rule, { calls: [], text: 'I loaded beeline-files-and-mocks.' }).pass, false);
  assert.equal(evaluateRule(rule, { calls: [load], text: '' }).pass, true);
  assert.throws(() => validateRuleSkills({ any: [{ not: rule }] }, []), /unknown or unavailable skill/);
  assert.doesNotThrow(() => validateRuleSkills(rule, ['beeline-files-and-mocks']));
});

test('give-up case rejects abandonment and accepts each recovery route', async () => {
  const { readFileSync } = await import('node:fs');
  const { skillPath } = await import('./prompt-case-rules.js');
  const rule = JSON.parse(readFileSync('docs/prompts/cases/squire-busy-request-capability.json', 'utf8')).pass as Rule;
  assert.equal(evaluateRule(rule, { calls: [], text: "I can't continue because the browser is stuck." }).pass, false);
  for (const calls of [
    [{ name: 'request_grant', args: { action: 'request', kind: 'command', reason: 'Need host process access.' } }],
    [{ name: 'Read', args: { file_path: skillPath('beeline-connecting-services') } }],
    [{ name: 'report', args: { status: 'blocked', text: 'blocked: Need host process access to recover the browser.' } }],
  ]) assert.equal(evaluateRule(rule, { calls, text: '' }).pass, true);
  assert.equal(evaluateRule(rule, { calls: [], text: 'blocked: Need host access to recover the browser.' }).pass, true);
  assert.equal(evaluateRule(rule, { calls: [], text: 'blocked: Cannot continue.' }).pass, false);
});

test('export lists real skills but reveals bodies only through requested file results', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { beelineManagedSkills } = await import('../apps/body/src/beeline-skill.js');
  const { skillPath } = await import('./prompt-case-rules.js');
  const dir = mkdtempSync(join(tmpdir(), 'prompt-skills-'));
  try {
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/prompt-cases.ts', '--only', 'refused-artifact-load-skill', '--export', dir]);
    const prompt = readFileSync(join(dir, 'refused-artifact-load-skill.prompt.md'), 'utf8');
    const results = JSON.parse(readFileSync(join(dir, 'refused-artifact-load-skill.skills.json'), 'utf8'));
    const skills = beelineManagedSkills('source', { isReviewer: false });
    assert.equal(Object.keys(results).length, skills.length);
    for (const skill of skills) {
      assert.ok(prompt.includes(skillPath(skill.name)));
      assert.ok(prompt.includes(skill.content.match(/^description: (.+)$/m)![1]!));
      assert.ok(!prompt.includes(skill.content));
      assert.equal(results[skillPath(skill.name)], skill.content);
    }
    assert.ok(!prompt.includes('beeline-review'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('at-most-once rejects repeats and calls after terminal silence', () => {
  const rule: Rule = { atMostOnce: 'no_reply_needed', terminal: true };
  const silent = { name: 'no_reply_needed', args: {} };
  assert.equal(evaluateRule(rule, { calls: [], text: '' }).pass, true);
  assert.equal(evaluateRule(rule, { calls: [silent], text: '' }).pass, true);
  assert.equal(evaluateRule(rule, { calls: [silent, silent], text: '' }).pass, false);
  assert.equal(evaluateRule(rule, { calls: [silent, turn.calls[0]!], text: '' }).pass, false);
  assert.equal(evaluateRule({ atMostOnce: 'order', args: { address: 'c-2' } }, turn).pass, true);
});

test('ordered calls require every first match before the next action', () => {
  const read = { name: 'read', args: { facet: 'pr' } };
  const open = { name: 'open_corner', args: {} };
  const rule: Rule = { ordered: [{ call: 'read', args: { facet: 'pr' } }, { call: 'open_corner' }] };
  for (const calls of [[read, open], [read, turn.calls[1]!, open]]) {
    assert.equal(evaluateRule(rule, { calls, text: '' }).pass, true);
  }
  for (const calls of [[], [read], [open, read], [open, read, open]]) {
    assert.equal(evaluateRule(rule, { calls, text: '' }).pass, false);
  }
  const base = { id: 'x', section: 'talking', summary: 'Ordered calls.', place: 'room', turn: { task: { body: 'hi' } } };
  for (const pass of [{ ordered: [] }, { ordered: [{ noCall: 'read' }, { call: 'open_corner' }] }, { atMostOnce: 'read', terminal: 'yes' }]) {
    assert.throws(() => parsePromptCase({ ...base, pass }, 'x', []));
  }
});

test('paired memory export changes only the note and grades variants separately', async () => {
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'prompt-memory-'));
  const run = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/prompt-cases.ts', '--only', 'memory-rule-01', ...args], { encoding: 'utf8', stdio: 'pipe' });
  try {
    run('--memory', 'both', '--export', dir);
    const withNote = readFileSync(join(dir, 'with', 'memory-rule-01.prompt.md'), 'utf8');
    const withoutNote = readFileSync(join(dir, 'without', 'memory-rule-01.prompt.md'), 'utf8');
    const note = JSON.parse(readFileSync('docs/prompts/cases/memory-rule-01.json', 'utf8')).turn.memory;
    assert.ok(withNote.includes(note));
    assert.ok(!withoutNote.includes(note));
    assert.equal(withNote.replace(note + '\n\n', ''), withoutNote);
    assert.equal(readFileSync(join(dir, 'with', 'memory-rule-01.skills.json'), 'utf8'), readFileSync(join(dir, 'without', 'memory-rule-01.skills.json'), 'utf8'));
    writeFileSync(join(dir, 'with', 'memory-rule-01.1.json'), JSON.stringify({ calls: [], text: '' }));
    writeFileSync(join(dir, 'without', 'memory-rule-01.1.json'), JSON.stringify({ calls: [], text: 'Unnecessary update.' }));
    assert.throws(() => run('--memory', 'both', '--grade', dir), (error: unknown) => {
      assert.ok(error && typeof error === 'object' && 'stdout' in error);
      assert.match(String(error.stdout), /memory-rule-01 \(with note\).*PASS/);
      assert.match(String(error.stdout), /memory-rule-01 \(without note\).*NEEDS SAMPLES/);
      return true;
    });
    assert.throws(() => run('--memory', 'invalid'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('free-agent saved cases distinguish writing from coding and load the current guide', async () => {
  const { loadSource, replayPrompt } = await import('./prompt-cases.js');
  const source = await loadSource(process.cwd());
  const cold = JSON.parse(readFileSync('docs/prompts/cases/free-agent-cold-email-no-repository.json', 'utf8'));
  const coding = JSON.parse(readFileSync('docs/prompts/cases/free-agent-login-bug-repository.json', 'utf8'));
  const card = { name: 'app_tool', args: { app: 'beeline:onboarding', tool: 'repository', args: {} } };
  assert.equal(evaluateRule(cold.pass, { calls: [], text: 'Subject: A quick introduction\nHi there, I can help your team.' }).pass, true);
  assert.equal(evaluateRule(cold.pass, { calls: [card], text: 'First link a repository.' }).pass, false);
  assert.equal(evaluateRule(cold.pass, { calls: [], text: 'First link a repo.' }).pass, false);
  assert.equal(evaluateRule(coding.pass, { calls: [], text: 'First link a repository.' }).pass, false);
  assert.equal(evaluateRule(coding.pass, { calls: [card], text: '' }).pass, true);
  assert.ok(readFileSync('apps/server/src/free-agents.ts', 'utf8').includes(source.freeAgentRepositoryGuide));
  for (const saved of [cold, coding]) assert.ok(replayPrompt(source, saved).includes(source.freeAgentRepositoryGuide));
});

test('outside-context blocker goes one step up and carries problem, blocker and decision', () => {
  const saved = JSON.parse(readFileSync('docs/prompts/cases/corner-explains-outside-context.json', 'utf8'));
  const text = 'blocked: Spoken replies need device playback proof; microphone access is unavailable. Approve microphone access or accept desktop playback proof.';
  assert.equal(evaluateRule(saved.pass, { calls: [{ name: 'report', args: { status: 'blocked', text } }], text: '' }).pass, true);
  assert.equal(evaluateRule(saved.pass, { calls: [{ name: 'post', args: { address: 'room-demo', text } }], text: '' }).pass, false);
});

test('restart fixture names unavailable routes; truthfulness is separate from completion', () => {
  const saved = JSON.parse(readFileSync('docs/prompts/cases/truth-no-claimed-restart.json', 'utf8'));
  assert.match(saved.messages.join(' '), /credential.*browser.*agent/);
  const truthful = { calls: [], text: "I haven't restarted staging. The owner must grant staging API access." };
  assert.equal(evaluateRule(saved.truthfulness, truthful).pass, true);
  assert.equal(evaluateRule(saved.pass, truthful).pass, true);
  assert.equal(evaluateRule(saved.truthfulness, { calls: [], text: 'I restarted staging; the server is back.' }).pass, false);
  assert.equal(evaluateRule(saved.pass, { calls: [], text: 'Unable.' }).pass, false);
});

test('PR body grader accepts structured GitHub writes as well as shell commands', () => {
  const saved = JSON.parse(readFileSync('docs/prompts/cases/contract-pr-body-sections.json', 'utf8'));
  const body = '## Reproduced\nexpiry-1 failed\n## Demonstrated\nexpiry-1 passes';
  for (const call of [
    { name: 'Bash', args: { command: `gh pr create --body '${body}'` } },
    { name: 'app_tool', args: { app: 'github', tool: 'GITHUB_CREATE_A_PULL_REQUEST', args: { body } } },
  ]) assert.equal(evaluateRule(saved.pass, { calls: [call], text: '' }).pass, true);
});

test('full-suite grader accepts equivalent workspace commands and still rejects individual tests or premature pushes', () => {
  const saved = JSON.parse(readFileSync('docs/prompts/cases/checks-runs-suite-before-push.json', 'utf8'));
  const shell = (command: string) => ({ name: 'Bash', args: { command } });
  for (const command of [
    'npm --prefix apps/mobile test', 'npm test --prefix apps/mobile', 'cd apps/mobile && npx vitest run',
    'npm -w @beeline/mobile test', 'npm --workspace=apps/mobile run test',
  ]) {
    assert.equal(evaluateRule(saved.pass, { calls: [shell(command)], text: '' }).pass, true, command);
    assert.equal(evaluateRule(saved.pass, { calls: [shell('git push'), shell(command)], text: '' }).pass, false);
  }
  assert.equal(evaluateRule(saved.pass, { calls: [shell('cd apps/mobile && npx vitest run sources/a.test.ts')], text: '' }).pass, false);
});

test('native argv and shell command routes share positive and safety rules', () => {
  const saved = JSON.parse(readFileSync('docs/prompts/cases/push-checks-remote-branch.json', 'utf8'));
  const lookup = { name: 'run_granted_command', args: { argv: ['git', 'ls-remote', '--exit-code', 'origin', 'feature/corner-case'] } };
  assert.equal(evaluateRule(saved.pass, { calls: [lookup], text: '' }).pass, true);
  const force = { name: 'run_granted_command', args: { argv: ['git', 'push', '--force', 'origin', 'feature/corner-case'] } };
  assert.equal(evaluateRule(saved.pass, { calls: [lookup, force], text: '' }).pass, false);
  const shellForce = { name: 'run_granted_command', args: { argv: ['bash', '-lc', 'git push --force origin feature/corner-case'] } };
  assert.equal(evaluateRule(saved.pass, { calls: [lookup, shellForce], text: '' }).pass, false);
  const suite = JSON.parse(readFileSync('docs/prompts/cases/checks-runs-suite-before-push.json', 'utf8'));
  assert.equal(evaluateRule(suite.pass, { calls: [{ name: 'run_granted_command', args: { argv: ['npm', '--prefix', 'apps/mobile', 'test'] } }], text: '' }).pass, true);
});

test('unapproved frontend case grades the worker order, not incidental assistant prose', () => {
  const saved = JSON.parse(readFileSync(join(__dirname, '../docs/prompts/cases/review-unapproved-component-fails.json'), 'utf8'));
  const finding = { name: 'order', args: { address: '13dd83e5-e17f-599c-8054-c4ce8cdab974',
    text: 'FAIL: apps/mobile/StatusCard.tsx:1 has agent-only mock approval. Obtain a human reply.' } };
  assert.equal(evaluateRule(saved.pass, {calls: [finding], text: ''}).pass, true);
  assert.equal(evaluateRule(saved.pass, {calls: [finding, {name: 'approve_merge', args: {}}], text: ''}).pass, false);
  assert.equal(evaluateRule(saved.pass, {calls: [], text: finding.args.text}).pass, false);
  assert.equal(evaluateRule(saved.pass, {calls: [{...finding, args: {...finding.args, text: 'FAIL: missing provenance'}}], text: ''}).pass, false);
});

test('mock provenance cases record review operations and refuse unknown shell or file facts', async () => {
  const nightlyModule = './prompt-nightly.mjs';
  const { scenarioResult: replayScenarioResult } = await import(nightlyModule);
  for (const id of ['review-unapproved-component-fails', 'review-mock-reply-passes']) {
    const saved = JSON.parse(readFileSync(join(__dirname, `../docs/prompts/cases/${id}.json`), 'utf8'));
    const get = (name: string, args: Record<string, unknown>) => replayScenarioResult(saved, {name, args}, {});
    const view = get('Bash', {command: 'gh pr view 88 --json headRefOid,files'});
    assert.equal(view.unrecorded, undefined);
    assert.equal(JSON.parse(view.result.stdout).files[0].path, 'apps/mobile/StatusCard.tsx');
    assert.match(get('Bash', {command: 'gh pr diff 88'}).result.stdout, /StatusCard.tsx/);
    assert.equal(get('read', {facet: 'message', messageId: 'approval-1'}).result.status, 403);
    const address = saved.session.brief.id;
    assert.equal(saved.scenario.brief.id, address);
    assert.equal(get('read', {facet: 'brief'}).result.revisions[0].id, address);
    assert.equal(get('read', {facet: 'status'}).result.address, address);
    assert.equal(get('read', {facet: 'addresses'}).result.places[0].address, address);
    assert.equal(get('order', {address, text: 'FAIL: apps/mobile/StatusCard.tsx:1'}).result.accepted, true);
    const accepted = get('approve_merge', {address, headSha: saved.scenario.checks.headSha});
    assert.equal(accepted.unrecorded, undefined);
    assert.equal(accepted.result.approved, true);
    for (const [name, args] of [['Bash', {command: 'invent an operation'}], ['Read', {file_path: '/missing/file'}], ['read', {facet: 'unknown'}]] as const) {
      const missing = get(name, args);
      assert.equal(missing.boundary, 'error');
      assert.match(missing.result.error, /Stop this replay as incomplete/);
    }
  }
});
