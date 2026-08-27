import { describe, expect, it, vi } from 'vitest';
import {
  applyAgentModelSelection,
  advertisedChoiceId,
  assertModelConfigOptionAllowed,
  assertModelSelectionAdvertised,
  DisallowedModelConfigOptionError,
  filterAllowedModelConfigOptions,
  filterModelOptionsByCredentials,
  parseAdvertisedConfigOptions,
  ModelSelectionUnavailableError,
} from './model-config.js';
import type { AgentModelConfigOption } from '@beeline/buzz-client';
import { CODEX_ACP_SESSION_NEW_CONFIG_OPTIONS } from './fixtures/codex-acp-config-options.js';

/** A raw `session/new` result shaped like claude-agent-acp's advertised catalog (report §3.1). */
function claudeLikeRaw(): unknown {
  return {
    sessionId: 'sess-1',
    configOptions: [
      {
        id: 'model',
        category: 'model',
        currentValue: 'claude-fable-5[1m]',
        options: [
          { id: 'default', name: 'Default' },
          { id: 'sonnet', name: 'Sonnet' },
          { id: 'opus[1m]', name: 'Opus (1M)' },
        ],
      },
      {
        id: 'effort',
        category: 'effort',
        currentValue: 'default',
        options: [{ id: 'default' }, { id: 'low' }, { id: 'high' }],
      },
      {
        id: 'mode',
        category: 'mode',
        currentValue: 'default',
        options: [{ id: 'default' }, { id: 'acceptEdits' }, { id: 'bypassPermissions' }],
      },
    ],
  };
}

describe('parseAdvertisedConfigOptions', () => {
  it('captures every axis, unfiltered, from a raw session/new result', () => {
    const options = parseAdvertisedConfigOptions(claudeLikeRaw());
    expect(options.map((option) => option.id)).toEqual(['model', 'effort', 'mode']);
  });

  it('tolerates a raw result with no configOptions at all', () => {
    expect(parseAdvertisedConfigOptions({ sessionId: 'x' })).toEqual([]);
    expect(parseAdvertisedConfigOptions(undefined)).toEqual([]);
  });

  it('ingests Codex-acp choices spelled `value` instead of `id`', () => {
    // Requiring `choice.id` produced empty option lists for a real Codex
    // catalog, so the pair pickers loaded the catalog and then offered nothing.
    expect(advertisedChoiceId({ value: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' })).toBe('gpt-5.6-sol');
    expect(advertisedChoiceId({ id: 'sonnet', name: 'Sonnet' })).toBe('sonnet');
    expect(advertisedChoiceId({ name: 'orphan' })).toBeUndefined();

    const parsed = parseAdvertisedConfigOptions(CODEX_ACP_SESSION_NEW_CONFIG_OPTIONS);
    const model = parsed.find((option) => option.category === 'model');
    const effort = parsed.find((option) => option.category === 'thought_level');
    expect(model?.options.map((choice) => choice.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ]);
    expect(model?.options[0]?.name).toBe('GPT-5.6-Sol');
    expect(effort?.options.map((choice) => choice.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(filterAllowedModelConfigOptions(parsed).map((option) => option.category)).toEqual([
      'model',
      'thought_level',
    ]);
    expect(() =>
      assertModelSelectionAdvertised(parsed, { model: 'gpt-5.6-sol', effort: 'high' }),
    ).not.toThrow();
  });
});

describe('filterAllowedModelConfigOptions', () => {
  it('drops the mode axis and keeps model/effort', () => {
    const filtered = filterAllowedModelConfigOptions(parseAdvertisedConfigOptions(claudeLikeRaw()));
    expect(filtered.map((option) => option.category)).toEqual(['model', 'effort']);
  });
});

describe('filterModelOptionsByCredentials', () => {
  const options: AgentModelConfigOption[] = [
    {
      id: 'model',
      category: 'model',
      options: [
        { id: 'openai/gpt-5.5' },
        { id: 'openrouter/some-model' },
        { id: 'sonnet' }, // bare id — always passes through
      ],
    },
    {
      id: 'effort',
      category: 'effort',
      options: [{ id: 'low' }, { id: 'high' }],
    },
  ];

  it('keeps bare model ids and provider/model ids only for held credentials', () => {
    const filtered = filterModelOptionsByCredentials(options, { OPENAI_API_KEY: 'sk-test' });
    const modelAxis = filtered.find((option) => option.category === 'model')!;
    expect(modelAxis.options.map((choice) => choice.id)).toEqual(['openai/gpt-5.5', 'sonnet']);
  });

  it('never filters non-model axes', () => {
    const filtered = filterModelOptionsByCredentials(options, {});
    const effortAxis = filtered.find((option) => option.category === 'effort')!;
    expect(effortAxis.options).toEqual(options[1]!.options);
  });

  it('drops every provider-namespaced choice when no credentials are held', () => {
    const filtered = filterModelOptionsByCredentials(options, {});
    const modelAxis = filtered.find((option) => option.category === 'model')!;
    expect(modelAxis.options.map((choice) => choice.id)).toEqual(['sonnet']);
  });
});

describe('assertModelConfigOptionAllowed — the set path security gate', () => {
  const raw = parseAdvertisedConfigOptions(claudeLikeRaw());

  it('accepts a real model/effort axis+value pair', () => {
    expect(() => assertModelConfigOptionAllowed('model', 'sonnet', raw)).not.toThrow();
    expect(() => assertModelConfigOptionAllowed('effort', 'high', raw)).not.toThrow();
  });

  it('refuses a mode configId even though it is present in the raw advertised catalog', () => {
    expect(() => assertModelConfigOptionAllowed('mode', 'bypassPermissions', raw)).toThrow(
      DisallowedModelConfigOptionError,
    );
  });

  it('refuses an unknown configId', () => {
    expect(() => assertModelConfigOptionAllowed('fast-mode', 'on', raw)).toThrow(
      DisallowedModelConfigOptionError,
    );
  });

  it('refuses a value that is not one of the axis own advertised options', () => {
    expect(() => assertModelConfigOptionAllowed('model', 'gpt-5.4', raw)).toThrow(
      /not one of "model"/,
    );
  });
});

describe('applyAgentModelSelection — the set path', () => {
  const raw = parseAdvertisedConfigOptions(claudeLikeRaw());

  it('round-trips a persisted model+effort selection onto the live session', async () => {
    const setConfigOption = vi.fn().mockResolvedValue({});
    await applyAgentModelSelection({ setConfigOption }, 'sess-1', raw, {
      model: 'sonnet',
      effort: 'high',
    });
    expect(setConfigOption).toHaveBeenCalledTimes(2);
    expect(setConfigOption).toHaveBeenCalledWith('sess-1', 'model', 'sonnet');
    expect(setConfigOption).toHaveBeenCalledWith('sess-1', 'effort', 'high');
  });

  it('rejects an unknown or retired model before calling the harness setter', async () => {
    const setConfigOption = vi.fn().mockResolvedValue({});
    await expect(
      applyAgentModelSelection({ setConfigOption }, 'sess-1', raw, {
        model: 'openrouter/stealth/ox-alpha',
      }),
    ).rejects.toMatchObject({
      name: 'ModelSelectionUnavailableError',
      label: 'model',
      value: 'openrouter/stealth/ox-alpha',
      reason: 'not-advertised',
    });
    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it('rejects an unknown effort before applying either axis', async () => {
    const setConfigOption = vi.fn().mockResolvedValue({});
    await expect(
      applyAgentModelSelection({ setConfigOption }, 'sess-1', raw, {
        model: 'sonnet',
        effort: 'xhigh',
      }),
    ).rejects.toMatchObject({ label: 'effort', value: 'xhigh', reason: 'not-advertised' });
    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it('preserves provider retirement guidance when an advertised model is refused', async () => {
    const setConfigOption = vi
      .fn()
      .mockRejectedValue(new Error('Model retired; use z-ai/glm-5.3-flash instead.'));
    await expect(
      applyAgentModelSelection({ setConfigOption }, 'sess-1', raw, {
        model: 'sonnet',
      }),
    ).rejects.toMatchObject({
      label: 'model',
      value: 'sonnet',
      reason: 'provider-refused',
      guidance: 'Model retired; use z-ai/glm-5.3-flash instead.',
    });
  });

  it('never reaches a mode axis when a model-shaped value is invalid', async () => {
    const setConfigOption = vi.fn().mockResolvedValue({});
    await expect(
      applyAgentModelSelection({ setConfigOption }, 'sess-1', raw, {
        model: 'bypassPermissions',
      }),
    ).rejects.toBeInstanceOf(ModelSelectionUnavailableError);
    expect(setConfigOption).not.toHaveBeenCalledWith('sess-1', 'mode', expect.anything());
    expect(setConfigOption).not.toHaveBeenCalledWith('sess-1', 'fast-mode', expect.anything());
    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it('rejects a selection whose axis category is missing entirely from the catalog', async () => {
    const setConfigOption = vi.fn().mockResolvedValue({});
    const modelOnly = raw.filter((option) => option.category !== 'effort');
    await expect(
      applyAgentModelSelection({ setConfigOption }, 'sess-1', modelOnly, { effort: 'high' }),
    ).rejects.toMatchObject({ label: 'effort', reason: 'axis-missing' });
    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no persisted selection', async () => {
    const setConfigOption = vi.fn().mockResolvedValue({});
    await applyAgentModelSelection({ setConfigOption }, 'sess-1', raw, {});
    expect(setConfigOption).not.toHaveBeenCalled();
  });
});

describe('assertModelSelectionAdvertised — shared strict validation', () => {
  const raw = parseAdvertisedConfigOptions(claudeLikeRaw());

  it('accepts the exact advertised model and effort', () => {
    expect(() =>
      assertModelSelectionAdvertised(raw, { model: 'sonnet', effort: 'high' }),
    ).not.toThrow();
  });

  it('rejects an unadvertised model with its selected identifier', () => {
    expect(() => assertModelSelectionAdvertised(raw, { model: 'gpt-nonexistent' })).toThrow(
      /model "gpt-nonexistent" is unavailable/,
    );
  });

  it('rejects a missing axis rather than inventing one', () => {
    const modelOnly = raw.filter((option) => option.category !== 'effort');
    expect(() => assertModelSelectionAdvertised(modelOnly, { effort: 'high' })).toThrow(
      /does not advertise a selectable effort axis/,
    );
  });

  it('is a no-op when neither model nor effort was requested', () => {
    expect(() => assertModelSelectionAdvertised(raw, {})).not.toThrow();
  });
});
