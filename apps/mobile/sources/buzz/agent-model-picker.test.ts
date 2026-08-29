import { describe, expect, it } from 'vitest';
import { filterAgentModelOptions } from './agent-model-picker';

describe('filterAgentModelOptions', () => {
  const options = [
    { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6' },
    { id: 'openai/gpt-5.6-codex', name: 'GPT-5.6 Codex' },
    { id: 'z-ai/glm-5.3-flash', name: 'GLM Flash' },
  ];

  it('uses token-AND substring matching across live IDs and labels', () => {
    expect(filterAgentModelOptions(options, 'open 5.6')).toEqual([options[1]]);
    expect(filterAgentModelOptions(options, 'claude opus')).toEqual([options[0]]);
    expect(filterAgentModelOptions(options, 'codex flash')).toEqual([]);
  });

  it('keeps every catalog option for an empty search', () => {
    expect(filterAgentModelOptions(options, '   ')).toEqual(options);
  });
});
