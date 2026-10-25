import { expect, it } from 'vitest';
import { agentPostText } from './agent-post-text.js';

it.each(['think', 'thinking', 'THINK', 'THINKING'])(
  'R-REASONING-POST: removes leading %s while preserving the final reply', (tag) => {
    const reply = 'Final **reply**.\n\nKeep this paragraph.';
    expect(agentPostText(` <${tag}>Private\nreasoning.</${tag}>\n\n${reply} `)).toBe(reply);
    expect(agentPostText(`<${tag}>Private only.</${tag}>`)).toBe('');
    expect(agentPostText(`<${tag}>Unfinished reasoning`)).toBe('');
  },
);

it('R-REASONING-POST: removes repeated blocks but preserves quoted examples and ordinary replies', () => {
  expect(agentPostText('<think>First</think>\n<thinking>Second</thinking>Final.')).toBe('Final.');
  for (const reply of ['Final **reply**.\n\nUnchanged.', 'Use <think>example</think> in XML.',
    '```xml\n<thinking>example</thinking>\n```', '<thinking-about>Visible XML</thinking-about>']) {
    expect(agentPostText(reply)).toBe(reply);
  }
});
