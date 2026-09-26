import { describe, expect, it } from 'vitest';
import { agentHarnessName, filterAgentModelOptions } from './agent-model-picker';

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

describe('agentHarnessName', () => {
  it('names each helper harness kind', () => {
    expect(agentHarnessName('claude')).toBe('Claude Code');
    expect(agentHarnessName('codex')).toBe('Codex');
    expect(agentHarnessName('cursor')).toBe('Cursor');
    expect(agentHarnessName('goose')).toBe('Goose');
    expect(agentHarnessName('grok')).toBe('Grok');
    expect(agentHarnessName('opencode')).toBe('OpenCode');
    expect(agentHarnessName('pi')).toBe('Pi');
  });

  it('names nothing for a kind that is not a runtime', () => {
    expect(agentHarnessName('reference')).toBeUndefined();
    expect(agentHarnessName('custom')).toBeUndefined();
    expect(agentHarnessName('hermes')).toBeUndefined();
    expect(agentHarnessName(undefined)).toBeUndefined();
  });
});
