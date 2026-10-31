import test from 'node:test';
import assert from 'node:assert/strict';
import { ownedAccounting } from './prompt-token-audit.mjs';

test('the prompt axis excludes conversation growth and shrinks with deferred definitions', () => {
  const tools = Array.from({ length: 10 }, (_, i) => ({ name: `tool_${i}`, description: 'Read recorded scenario facts. '.repeat(20), inputSchema: { type: 'object' } }));
  const prompt = body => `Replay instructions\n## System prompt\nKeep facts exact.\n## Turn\n\n\`\`\`\`text\n${body}\n\`\`\`\`\n\n`;
  const full = { testCase: {}, skills: {}, tools, variant: { mode: 'full' } };
  const a = ownedAccounting(prompt('Hello'), full);
  const b = ownedAccounting(prompt('Hello '.repeat(1000)), full);
  assert.equal(a.beelineOwnedTokensPerInitialCall, b.beelineOwnedTokensPerInitialCall);
  assert.ok(b.conversationTokens > a.conversationTokens);
  const deferred = ownedAccounting(prompt('Hello'), { ...full, variant: { mode: 'deferred', core: ['tool_0'] } });
  assert.ok(deferred.beelineOwnedTokensPerInitialCall < a.beelineOwnedTokensPerInitialCall);
  assert.equal(a.modelCalls, null);
  assert.equal(a.codexHarnessTokensPerCall, null);
});
