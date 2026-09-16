import { describe, expect, it } from 'vitest';
import { agentMessageJsonMarkdown } from './agent-message-json';

describe('agentMessageJsonMarkdown', () => {
  it.each([
    ['object', '{\n    "answer": {\n        "value": 42\n    }\n}'],
    ['array', '[\n  {"id": 1},\n  {"id": 2}\n]'],
  ])('wraps a valid JSON %s while preserving its indentation', (_kind, json) => {
    expect(agentMessageJsonMarkdown(`  ${json}\n`)).toBe(`\`\`\`json\n${json}\n\`\`\``);
  });

  it.each([
    'The result is {"answer": 42}',
    '{answer: 42}',
    '"plain JSON string"',
    '42',
    'true',
    'null',
    '```json\n{"answer": 42}\n```',
  ])('leaves non-container or already-formatted text alone: %s', (text) => {
    expect(agentMessageJsonMarkdown(text)).toBeNull();
  });
});
