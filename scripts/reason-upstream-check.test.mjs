import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TITLE_PREFIX, portIssue, readUpstream, upstreamChanges } from './reason-upstream-check.mjs';

const recorded = readUpstream();
const fixture = JSON.parse(readFileSync(new URL('./fixtures/reason-upstream-compare.json', import.meta.url), 'utf8'));

test('a change to a ported adapter file opens a port issue naming each file', () => {
  const result = upstreamChanges(recorded, fixture);
  assert.equal(result.changed, true);
  assert.equal(result.head, '2222222222222222222222222222222222222222');
  // Reason's relays and README are not ported; a renamed adapter still counts.
  assert.deepEqual(result.files.map(f => f.filename), ['src/claude.rs', 'src/setup/opencode.rs']);
  const issue = portIssue(recorded, result);
  assert.ok(issue.title.startsWith(`${TITLE_PREFIX} ${recorded.commit.slice(0, 12)}..222222222222`));
  assert.match(issue.body, /`src\/claude\.rs` modified \(\+12 −3\)/);
  assert.match(issue.body, /was `src\/opencode-plugin\.ts`/);
  assert.match(issue.body, new RegExp(`compare/${recorded.commit}\\.\\.\\.2222222222222222222222222222222222222222`));
});

test('upstream changes outside the ported files open nothing', () => {
  const quiet = { ...fixture, files: fixture.files.filter(f => ['src/relays.rs', 'README.md'].includes(f.filename)) };
  assert.equal(upstreamChanges(recorded, quiet).changed, false);
  assert.equal(upstreamChanges(recorded, { files: [] }).changed, false);
});

test('the recorded upstream names the copied commit and every ported adapter', () => {
  assert.match(recorded.commit, /^[0-9a-f]{40}$/);
  for (const file of ['src/claude.rs', 'src/hook.rs', 'src/codex.rs', 'src/opencode-plugin.ts', 'src/pi-extension.ts', 'src/antigravity.rs',
    'src/setup/antigravity.rs', 'src/daemon/antigravity.rs', 'src/setup/gemini.rs', 'src/setup/hermes.rs', 'src/setup/zcode.rs', 'src/daemon/sessions.rs'])
    assert.ok(recorded.files.includes(file), file);
});
