import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEIGHT_TIER_RULES,
  agentMatchesClass,
  agentTagSet,
  isAgentIdentityReference,
  isClassOrTagReference,
  isCustomTag,
  isWeightTierRule,
  readCustomTags,
  readWeightTierRules,
  resolveProviderTag,
  resolveWeightTier,
} from './agent-classes.js';

describe('resolveWeightTier', () => {
  it('classifies the captain-specified defaults', () => {
    expect(resolveWeightTier('astra-2', DEFAULT_WEIGHT_TIER_RULES)).toEqual({
      tier: 'god',
      unclassified: false,
    });
    expect(resolveWeightTier('fable-5-1', DEFAULT_WEIGHT_TIER_RULES)).toEqual({
      tier: 'god',
      unclassified: false,
    });
    expect(resolveWeightTier('grok-4', DEFAULT_WEIGHT_TIER_RULES)).toEqual({
      tier: 'heavy',
      unclassified: false,
    });
    expect(resolveWeightTier('gpt-5-sol', DEFAULT_WEIGHT_TIER_RULES)).toEqual({
      tier: 'heavy',
      unclassified: false,
    });
    // The "opus*" default is a prefix pattern on the model's own id, e.g. as a
    // harness like OpenRouter would report it — not the "claude-opus-..." form.
    expect(resolveWeightTier('opus-4-5', DEFAULT_WEIGHT_TIER_RULES)).toEqual({
      tier: 'heavy',
      unclassified: false,
    });
    expect(resolveWeightTier('claude-sonnet-5-5', DEFAULT_WEIGHT_TIER_RULES)).toEqual({
      tier: 'light',
      unclassified: true,
    });
  });

  it('inherits a family match for a future version string never seen before', () => {
    // The whole point of family patterns over exact names: a future release
    // classifies correctly with no map update.
    expect(resolveWeightTier('opus-7', DEFAULT_WEIGHT_TIER_RULES)).toEqual({
      tier: 'heavy',
      unclassified: false,
    });
    expect(resolveWeightTier('gpt-6-sol-mini', DEFAULT_WEIGHT_TIER_RULES)).toEqual({
      tier: 'heavy',
      unclassified: false,
    });
    expect(resolveWeightTier('astra-9-ultra', DEFAULT_WEIGHT_TIER_RULES)).toEqual({
      tier: 'god',
      unclassified: false,
    });
  });

  it('is case-insensitive', () => {
    expect(resolveWeightTier('OPUS-4', DEFAULT_WEIGHT_TIER_RULES).tier).toBe('heavy');
  });

  it('marks an unrecognized model light and unclassified', () => {
    expect(resolveWeightTier('some-random-model-9', DEFAULT_WEIGHT_TIER_RULES)).toEqual({
      tier: 'light',
      unclassified: true,
    });
  });

  it('is not unclassified when no model is selected yet', () => {
    expect(resolveWeightTier(null, DEFAULT_WEIGHT_TIER_RULES)).toEqual({
      tier: 'light',
      unclassified: false,
    });
    expect(resolveWeightTier(undefined, DEFAULT_WEIGHT_TIER_RULES)).toEqual({
      tier: 'light',
      unclassified: false,
    });
  });

  it('first matching rule wins, so custom order controls precedence', () => {
    const rules = [
      { pattern: 'opus-mini*', tier: 'light' as const },
      { pattern: 'opus*', tier: 'heavy' as const },
    ];
    expect(resolveWeightTier('opus-mini-1', rules).tier).toBe('light');
    expect(resolveWeightTier('opus-2', rules).tier).toBe('heavy');
  });

  it('falls back to defaults for a NULL or invalid rule set', () => {
    expect(readWeightTierRules(null)).toEqual(DEFAULT_WEIGHT_TIER_RULES);
    expect(readWeightTierRules(undefined)).toEqual(DEFAULT_WEIGHT_TIER_RULES);
    expect(readWeightTierRules([{ pattern: 'x', tier: 'bogus' }])).toEqual(DEFAULT_WEIGHT_TIER_RULES);
    expect(readWeightTierRules('not-an-array')).toEqual(DEFAULT_WEIGHT_TIER_RULES);
  });

  it('accepts a valid admin-supplied rule set verbatim, in order', () => {
    const rules = [
      { pattern: 'astra*', tier: 'god' as const },
      { pattern: 'night-shift*', tier: 'heavy' as const },
    ];
    expect(readWeightTierRules(rules)).toEqual(rules);
  });

  it('rejects a rule set beyond the count cap', () => {
    const tooMany = Array.from({ length: 65 }, (_, index) => ({
      pattern: `p${index}`,
      tier: 'light' as const,
    }));
    expect(readWeightTierRules(tooMany)).toEqual(DEFAULT_WEIGHT_TIER_RULES);
  });
});

describe('isWeightTierRule', () => {
  it('accepts only a two-key {pattern, tier} shape with a real tier', () => {
    expect(isWeightTierRule({ pattern: 'astra*', tier: 'god' })).toBe(true);
    expect(isWeightTierRule({ pattern: 'astra*', tier: 'bogus' })).toBe(false);
    expect(isWeightTierRule({ pattern: 'astra*', tier: 'god', extra: 1 })).toBe(false);
    expect(isWeightTierRule({ tier: 'god' })).toBe(false);
    expect(isWeightTierRule(null)).toBe(false);
    expect(isWeightTierRule('astra*')).toBe(false);
  });
});

describe('resolveProviderTag', () => {
  it('uses the harness-native provider when the harness has one', () => {
    expect(resolveProviderTag('claude', 'claude-opus-4-5')).toBe('anthropic');
    expect(resolveProviderTag('codex', 'gpt-5')).toBe('openai');
    expect(resolveProviderTag('grok', 'grok-4')).toBe('xai');
  });

  it('infers the provider from the model prefix for a proxying harness', () => {
    expect(resolveProviderTag('pi', 'claude-sonnet-5-5')).toBe('anthropic');
    expect(resolveProviderTag('pi', 'gemini-2-5-pro')).toBe('google');
    expect(resolveProviderTag('cursor', 'gpt-5')).toBe('openai');
    expect(resolveProviderTag('goose', 'some-oss-model')).toBe('openrouter');
  });

  it('is unknown with no harness and no recognizable model prefix', () => {
    expect(resolveProviderTag(null, null)).toBe('unknown');
    expect(resolveProviderTag(null, 'some-oss-model')).toBe('unknown');
  });
});

describe('custom tags', () => {
  it('accepts a lowercase hyphenated tag under the length cap', () => {
    expect(isCustomTag('night-shift')).toBe(true);
    expect(isCustomTag('a')).toBe(true);
  });

  it('rejects uppercase, leading digits, spaces, and over-length tags', () => {
    expect(isCustomTag('Night-Shift')).toBe(false);
    expect(isCustomTag('1night')).toBe(false);
    expect(isCustomTag('night shift')).toBe(false);
    expect(isCustomTag('a'.repeat(33))).toBe(false);
  });

  it('readCustomTags drops invalid entries, dedupes, and caps the count', () => {
    expect(readCustomTags(['night-shift', 'Bad Tag', 'night-shift', 'trusted'])).toEqual([
      'night-shift',
      'trusted',
    ]);
    expect(readCustomTags(Array.from({ length: 20 }, (_, i) => `tag-${i}`))).toHaveLength(16);
    expect(readCustomTags(null)).toEqual([]);
    expect(readCustomTags('not-an-array')).toEqual([]);
  });
});

describe('identity vs. class/tag disambiguation', () => {
  const IDENTITY_ID = 'a'.repeat(64);

  it('a 64-lowercase-hex string is always an identity reference, never a class', () => {
    expect(isAgentIdentityReference(IDENTITY_ID)).toBe(true);
    expect(isClassOrTagReference(IDENTITY_ID)).toBe(false);
  });

  it('a tier name, harness name, or model id is a class/tag reference', () => {
    expect(isClassOrTagReference('heavy')).toBe(true);
    expect(isClassOrTagReference('claude')).toBe(true);
    expect(isClassOrTagReference('claude-opus-4-5')).toBe(true);
    expect(isClassOrTagReference('night-shift')).toBe(true);
  });

  it('rejects an empty, over-length, or malformed reference', () => {
    expect(isClassOrTagReference('')).toBe(false);
    expect(isClassOrTagReference('a'.repeat(129))).toBe(false);
    expect(isClassOrTagReference('has spaces')).toBe(false);
    expect(isClassOrTagReference(42)).toBe(false);
  });
});

describe('agentTagSet / agentMatchesClass', () => {
  it('a role/reviewer class reference matches any axis: model, harness, provider, tier, or a custom tag', () => {
    const facts = {
      model: 'claude-opus-4-5',
      harness: 'claude' as const,
      weightTier: 'heavy' as const,
      provider: 'anthropic',
      customTags: ['night-shift'],
    };
    const tags = agentTagSet(facts);
    expect(tags).toEqual(new Set(['night-shift', 'claude-opus-4-5', 'claude', 'anthropic', 'heavy']));
    expect(agentMatchesClass(facts, 'heavy')).toBe(true);
    expect(agentMatchesClass(facts, 'claude')).toBe(true);
    expect(agentMatchesClass(facts, 'anthropic')).toBe(true);
    expect(agentMatchesClass(facts, 'claude-opus-4-5')).toBe(true);
    expect(agentMatchesClass(facts, 'night-shift')).toBe(true);
    expect(agentMatchesClass(facts, 'light')).toBe(false);
    expect(agentMatchesClass(facts, 'god')).toBe(false);
  });

  it('an agent with no model/harness only carries its provider, tier, and custom tags', () => {
    const facts = {
      model: null,
      harness: null,
      weightTier: 'light' as const,
      provider: 'unknown',
      customTags: [],
    };
    expect(agentTagSet(facts)).toEqual(new Set(['unknown', 'light']));
  });
});
