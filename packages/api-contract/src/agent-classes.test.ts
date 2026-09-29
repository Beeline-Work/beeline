import { describe, expect, it } from 'vitest';
import {
  agentTags,
  classifyModel,
  familyTag,
  harnessTag,
  normalizeCustomAgentTag,
  parseModelsDevRegistry,
  resolveRegistryModel,
  tierFromOutputPrice,
  type RegistryModel,
} from './agent-classes.js';

const registry: RegistryModel[] = [
  {
    provider: 'anthropic',
    modelId: 'claude-fable-5-1',
    name: 'Claude Fable 5.1',
    family: 'claude-fable',
    outputCost: 50,
  },
  {
    provider: 'anthropic',
    modelId: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    family: 'claude-opus',
    outputCost: 20,
  },
  {
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5 (latest)',
    family: 'claude-haiku',
    outputCost: 5,
  },
  { provider: 'openai', modelId: 'gpt-6-astra', name: 'GPT-6 Astra', family: 'gpt-astra', outputCost: 50 },
  { provider: 'openai', modelId: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', family: 'gpt-sol', outputCost: 10 },
  { provider: 'xai', modelId: 'grok-4.6', name: 'Grok 4.6', family: 'grok', outputCost: 6 },
  {
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    family: 'deepseek-flash',
    outputCost: 0.6,
  },
];

describe('tierFromOutputPrice', () => {
  it('classifies at the boundaries', () => {
    expect(tierFromOutputPrice(4.99)).toBe('light');
    expect(tierFromOutputPrice(5)).toBe('heavy');
    expect(tierFromOutputPrice(39.99)).toBe('heavy');
    expect(tierFromOutputPrice(40)).toBe('god');
    expect(tierFromOutputPrice(0)).toBe('light');
  });

  it("matches today's registry prices from the brief", () => {
    const tier = (provider: string, modelId: string) =>
      classifyModel({ model: registry.find((m) => m.provider === provider && m.modelId === modelId)! }, [])
        .tier;
    expect(tier('anthropic', 'claude-fable-5-1')).toBe('god');
    expect(tier('openai', 'gpt-6-astra')).toBe('god');
    expect(tier('anthropic', 'claude-opus-5-5')).toBe('heavy');
    expect(tier('openai', 'gpt-6.1-sol')).toBe('heavy');
    expect(tier('xai', 'grok-4.6')).toBe('heavy');
    expect(tier('deepseek', 'deepseek-v4-flash')).toBe('light');
  });
});

describe('classifyModel overrides', () => {
  const opus = registry.find((m) => m.modelId === 'claude-opus-5-5')!;

  it('uses price when no override applies', () => {
    expect(classifyModel({ model: opus }, [])).toMatchObject({
      tier: 'heavy',
      source: 'price',
      unclassified: false,
      family: 'opus',
      provider: 'anthropic',
      outputCost: 20,
    });
  });

  it('lets a family override win over price', () => {
    expect(
      classifyModel({ model: opus }, [{ scope: 'family', key: 'opus', tier: 'god' }]),
    ).toMatchObject({ tier: 'god', source: 'family-override' });
  });

  it('lets a model override win over a family override and price', () => {
    expect(
      classifyModel({ model: opus }, [
        { scope: 'family', key: 'opus', tier: 'god' },
        { scope: 'model', key: 'anthropic/claude-opus-5-5', tier: 'light' },
      ]),
    ).toMatchObject({ tier: 'light', source: 'model-override' });
  });

  it('ignores an override for a different model or family', () => {
    expect(
      classifyModel({ model: opus }, [
        { scope: 'model', key: 'anthropic/claude-fable-5-1', tier: 'light' },
        { scope: 'family', key: 'fable', tier: 'light' },
      ]),
    ).toMatchObject({ tier: 'heavy', source: 'price' });
  });
});

describe('unknown models', () => {
  it('gives an unlisted model light plus unclassified', () => {
    const model = resolveRegistryModel(
      { provider: 'openrouter', modelId: 'gemma-4-31b-it-fabled' },
      registry,
    );
    expect(model).toBeUndefined();
    const classification = classifyModel(
      { provider: 'openrouter', modelId: 'gemma-4-31b-it-fabled', model },
      [],
    );
    expect(classification).toMatchObject({ tier: 'light', unclassified: true, source: 'unlisted' });
    expect(classification.family).toBeUndefined();
    expect(agentTags({ classification, harness: 'goose' }).map((t) => t.tag)).toEqual([
      'light',
      'unclassified',
      'goose',
      'openrouter',
    ]);
  });

  it('never classifies by a name substring', () => {
    for (const modelId of ['gemma-4-31b-it-fabled', 'my-opus-finetune', 'fable']) {
      expect(resolveRegistryModel({ provider: 'anthropic', modelId }, registry)).toBeUndefined();
    }
  });

  it('lets an admin model override resolve an unclassified model', () => {
    expect(
      classifyModel({ provider: 'openrouter', modelId: 'gemma-4-31b-it-fabled' }, [
        { scope: 'model', key: 'openrouter/gemma-4-31b-it-fabled', tier: 'heavy' },
      ]),
    ).toMatchObject({ tier: 'heavy', unclassified: false, source: 'model-override' });
  });

  it('treats a listed model with no output price as unclassified', () => {
    expect(
      classifyModel(
        { model: { provider: 'xai', modelId: 'grok-image', name: 'Grok Image', family: 'grok', outputCost: null } },
        [],
      ),
    ).toMatchObject({ tier: 'light', unclassified: true });
  });
});

describe('resolveRegistryModel', () => {
  it('matches provider plus exact model id', () => {
    expect(
      resolveRegistryModel({ provider: 'anthropic', modelId: 'claude-opus-5-5' }, registry)?.modelId,
    ).toBe('claude-opus-5-5');
  });

  it('resolves an alias through its display name, exactly', () => {
    expect(
      resolveRegistryModel(
        { provider: 'anthropic', modelId: 'opus', displayName: 'Opus 5.5' },
        registry,
      )?.modelId,
    ).toBe('claude-opus-5-5');
    expect(
      resolveRegistryModel(
        { provider: 'anthropic', modelId: 'haiku', displayName: 'Haiku 4.5' },
        registry,
      )?.modelId,
    ).toBe('claude-haiku-4-5');
    expect(
      resolveRegistryModel({ provider: 'anthropic', modelId: 'opus', displayName: 'Opus' }, registry),
    ).toBeUndefined();
  });

  it('reads a provider/model id', () => {
    expect(resolveRegistryModel({ modelId: 'xai/grok-4.6' }, registry)?.provider).toBe('xai');
  });
});

describe('tags', () => {
  it('derives short family tags from the registry family field', () => {
    expect(familyTag('claude-opus')).toBe('opus');
    expect(familyTag('claude-fable')).toBe('fable');
    expect(familyTag('gpt-sol')).toBe('sol');
    expect(familyTag('gpt-astra')).toBe('astra');
    expect(familyTag('grok')).toBe('grok');
    expect(familyTag('deepseek-flash')).toBe('deepseek');
  });

  it('maps harness kinds', () => {
    expect(harnessTag('claude')).toBe('claude-code');
    expect(harnessTag('codex')).toBe('codex');
    expect(harnessTag('pi')).toBe('pi');
  });

  it('marks only custom tags removable', () => {
    const classification = classifyModel({ model: registry[1] }, []);
    expect(agentTags({ classification, harness: 'claude', custom: ['reviewer'] })).toEqual([
      { tag: 'heavy', kind: 'tier', removable: false },
      { tag: 'opus', kind: 'family', removable: false },
      { tag: 'claude-code', kind: 'harness', removable: false },
      { tag: 'anthropic', kind: 'provider', removable: false },
      { tag: 'reviewer', kind: 'custom', removable: true },
    ]);
  });

  it('refuses reserved and malformed custom tags', () => {
    expect(normalizeCustomAgentTag(' Reviewer ')).toBe('reviewer');
    expect(() => normalizeCustomAgentTag('heavy')).toThrow(/reserved/);
    expect(() => normalizeCustomAgentTag('unclassified')).toThrow(/reserved/);
    expect(() => normalizeCustomAgentTag('two words')).toThrow(/invalid/);
  });
});

describe('parseModelsDevRegistry', () => {
  it('reads provider -> models -> cost.output and skips malformed rows', () => {
    expect(
      parseModelsDevRegistry({
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-opus-5-5': {
              id: 'claude-opus-5-5',
              name: 'Claude Opus 5.5',
              family: 'claude-opus',
              cost: { input: 4, output: 20 },
            },
            broken: 'nope',
          },
        },
        junk: 7,
      }),
    ).toEqual([
      {
        provider: 'anthropic',
        modelId: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        family: 'claude-opus',
        outputCost: 20,
      },
    ]);
  });
});
