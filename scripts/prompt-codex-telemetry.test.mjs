import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRollout, promptParts } from './prompt-codex-telemetry.mjs';

const prompt = 'Replay\n## System prompt\nRules\n## Turn\n\n````text\nA case\n````\n\n';
const context = { prompt, variant: { mode: 'full' }, tools: [{ name: 'read' }] };
const row = (type, payload) => ({ type, payload });
const message = (role, text) => row('response_item', { type: 'message', role, content: [{ text }] });
const serialize = rows => rows.map(r => JSON.stringify(r)).join('\n');
const modern = (id, input) => row('token_usage_record', { response_id: id, usage: { input_tokens: input, cached_input_tokens: 5, output_tokens: 2 } });

test('modern rollouts count each response once, preserve provider totals and classify initial blocks without counting metadata twice', () => {
  const trace = serialize([
    row('session_meta', { id: 'thread', cli_version: '0.165.0', base_instructions: { text: 'Codex base' } }),
    message('developer', 'Codex base'), message('developer', '<skills_instructions>Skills'), message('user', prompt),
    row('response_item', { type: 'additional_tools', tools: [{ name: 'functions', tools: [{ name: 'exec', description: 'Built-in' }] }] }),
    message('assistant', 'Must not count this response as input.'),
    modern('one', 50),
    row('response_item', { type: 'custom_tool_call_output', output: [{ text: JSON.stringify([{ name: 'mcp__replay__read', description: 'Read facts', inputSchema: {} }]) }] }),
    modern('two', 80), modern('two', 80),
    row('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 80 } } }),
  ]);
  const result = parseRollout(trace, context);
  assert.equal(result.modelRequests, 2);
  assert.equal(result.sumProviderInputTokens, 130);
  assert.equal(result.firstCallBlocks.filter(b => b.label === 'codexBaseInstructions').length, 1);
  assert.equal(result.firstCallBlocks.some(b => b.role === 'assistant'), false);
  assert.equal(result.firstCallTools[0].name, 'functions.exec');
  assert.equal(result.initialExposure, 'codex-deferred-replay-definitions');
  assert.ok(result.calls[1].beelineOwnedTokensPerCall > result.calls[0].beelineOwnedTokensPerCall);
});

test('token_count fallback deduplicates repeated aggregate notices and ignores rate-limit-only notices', () => {
  const notice = total => row('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: total },
    last_token_usage: { input_tokens: 40, cached_input_tokens: 10 } } });
  const result = parseRollout(serialize([message('user', prompt), notice(40), notice(40),
    row('event_msg', { type: 'token_count', info: null }), notice(80)]), context);
  assert.equal(result.modelRequests, 2);
  assert.equal(result.sumProviderInputTokens, 80);
  assert.equal(result.calls[0].cachedInputTokens, 10);
});

test('first-party operation schemas returned through app_tool also belong to Beeline definitions', () => {
  const result = parseRollout(serialize([message('user', prompt), modern('one', 40),
    row('response_item', { type: 'custom_tool_call_output', output: [{ text: JSON.stringify({ content: [{ text: JSON.stringify({
      app: 'beeline:onboarding', tools: [{ name: 'welcome', description: 'Welcome', inputSchema: { type: 'object' } }],
    }) }] }) }] }), modern('two', 80)]), context);
  assert.ok(result.calls[1].beelineDefinitionTokens > 0);
});

test('index belongs to tool axis, appended rules belong to instructions, and conversation size does not change either', () => {
  const variant = { appendRules: 'Stop after boundary.' };
  const indexed = prompt + '## Deferred tool index\nread: read recorded facts\n' + variant.appendRules;
  const a = promptParts(indexed, variant);
  const b = promptParts(indexed.replace('A case', 'A case '.repeat(1000)), variant);
  assert.ok(a.indexTokens > 0);
  assert.equal(a.systemTokens, b.systemTokens);
  assert.equal(a.indexTokens, b.indexTokens);
  assert.ok(b.conversationTokens > a.conversationTokens);
  assert.equal(parseRollout(serialize([message('user', prompt)]), context).status, 'missing');
});
