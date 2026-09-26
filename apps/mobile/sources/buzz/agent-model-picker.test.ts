import { describe, expect, it } from 'vitest';
import {
  effortConfigAxis,
  fastModeConfigAxis,
  filterAgentModelOptions,
} from './agent-model-picker';

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

describe('effortConfigAxis', () => {
  const model = { id: 'model', category: 'model', options: [{ id: 'gpt-5.6' }] };
  const fast = {
    id: 'fast-mode',
    category: 'model_config',
    options: [{ id: 'off' }, { id: 'on' }],
  };
  const reasoning = { id: 'reasoning_effort', category: 'reasoning_effort', options: [] };
  const depth = { id: 'depth', category: 'thinking_depth', options: [] };

  it('prefers a known effort category over an earlier axis', () => {
    expect(effortConfigAxis([model, fast, depth, reasoning])).toBe(reasoning);
  });

  it('falls back to the first axis that is neither the model nor Fast mode', () => {
    expect(effortConfigAxis([model, fast, depth])).toBe(depth);
    expect(effortConfigAxis([model, fast])).toBeUndefined();
  });
});

describe('fastModeConfigAxis', () => {
  it('admits only the exact Fast mode axis offering both on and off', () => {
    const fast = {
      id: 'fast-mode',
      category: 'model_config',
      options: [{ id: 'off' }, { id: 'on' }],
    };
    expect(fastModeConfigAxis([fast])).toBe(fast);
    expect(fastModeConfigAxis([{ ...fast, options: [{ id: 'on' }] }])).toBeUndefined();
    expect(fastModeConfigAxis([{ ...fast, category: 'mode' }])).toBeUndefined();
  });
});
