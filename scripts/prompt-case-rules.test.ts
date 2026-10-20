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
  for (const referral of [
    'Point me at the Room with the linked repository.',
    'Go to a Room with a linked repository.',
    'Use another Room.',
    'Create a repository-backed Room.',
    "The Room's repository filesystem is read-only.",
  ]) {
    assert.equal(evaluateRule(saved.pass, { calls: [], text: `${guidance} ${referral}` }).pass, false, referral);
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
