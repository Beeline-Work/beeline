import { describe, expect, it, vi } from 'vitest';
import {
  applyAgentModelSelection,
  advertisedChoiceId,
  assertModelConfigOptionAllowed,
  DisallowedModelConfigOptionError,
  filterAllowedModelConfigOptions,
  filterModelOptionsByCredentials,
  parseAdvertisedConfigOptions,
  unadvertisedModelSelectionValues,
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
        options: [
          { id: 'default' },
          { id: 'low' },
          { id: 'high' },
        ],
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
    const warnings = unadvertisedModelSelectionValues(parsed, {
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    expect(warnings).toEqual([]);
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

  it('passes a CUSTOM model id through to the harness even though no option lists it', async () => {
    // A catalog miss is not evidence a model is unusable: pi accepts unknown
    // ids verbatim as custom model ids, so an unadvertised value must reach
    // `session/set_config_option` intact.
    const setConfigOption = vi.fn().mockResolvedValue({});
    await applyAgentModelSelection({ setConfigOption }, 'sess-1', raw, {
      model: 'openrouter/stealth/ox-alpha',
    });
    expect(setConfigOption).toHaveBeenCalledTimes(1);
    expect(setConfigOption).toHaveBeenCalledWith('sess-1', 'model', 'openrouter/stealth/ox-alpha');
  });

  it('keeps the effort axis alongside a custom model — both custom values applied', async () => {
    const setConfigOption = vi.fn().mockResolvedValue({});
    await applyAgentModelSelection({ setConfigOption }, 'sess-1', raw, {
      model: 'openrouter/stealth/ox-alpha',
      effort: 'xhigh',
    });
    expect(setConfigOption).toHaveBeenCalledWith('sess-1', 'model', 'openrouter/stealth/ox-alpha');
    expect(setConfigOption).toHaveBeenCalledWith('sess-1', 'effort', 'xhigh');
  });

  it('surfaces the harness refusal of a custom value, naming it and quoting the message', async () => {
    const setConfigOption = vi.fn().mockRejectedValue(new Error('unknown model id'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      applyAgentModelSelection({ setConfigOption }, 'sess-1', raw, {
        model: 'openrouter/nope/broken',
      }),
    ).resolves.toBeUndefined();
    const logged = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).toContain('openrouter/nope/broken');
    expect(logged).toContain('unknown model id');
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('logs a warning when a custom value is applied, so the pass-through is visible', async () => {
    const setConfigOption = vi.fn().mockResolvedValue({});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await applyAgentModelSelection({ setConfigOption }, 'sess-1', raw, {
      model: 'openrouter/stealth/ox-alpha',
    });
    const logged = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).toContain('custom model "openrouter/stealth/ox-alpha"');
    warnSpy.mockRestore();
  });

  it('never calls setConfigOption for a mode axis, even if a corrupted selection tried to target it', async () => {
    const setConfigOption = vi.fn().mockResolvedValue({});
    // No legitimate caller can populate `selection.model`/`selection.effort`
    // with a mode-shaped value that maps to the mode axis specifically,
    // since the target search is scoped to model/effort categories only —
    // this proves that scoping holds even given the full raw (unfiltered)
    // catalog including a mode axis. A mode-shaped model VALUE passes
    // through as a custom MODEL id (covered below); the mode configId
    // itself is unreachable by construction.
    await applyAgentModelSelection({ setConfigOption }, 'sess-1', raw, {
      model: 'bypassPermissions',
    });
    expect(setConfigOption).not.toHaveBeenCalledWith('sess-1', 'mode', expect.anything());
    expect(setConfigOption).not.toHaveBeenCalledWith('sess-1', 'fast-mode', expect.anything());
  });

  it('still refuses to SET a mode axis value even when that axis carries an unadvertised (custom-shaped) value', async () => {
    const setConfigOption = vi.fn().mockResolvedValue({});
    await applyAgentModelSelection({ setConfigOption }, 'sess-1', raw, {
      model: 'bypassPermissions',
    });
    // 'bypassPermissions' is not a model-axis choice here, so it passes
    // through as a custom MODEL id — the mode axis itself is never touched.
    expect(setConfigOption).toHaveBeenCalledWith('sess-1', 'model', 'bypassPermissions');
    expect(setConfigOption).not.toHaveBeenCalledWith('sess-1', 'mode', expect.anything());
  });

  it('logs and skips a selection whose axis category is missing entirely from the catalog', async () => {
    const setConfigOption = vi.fn().mockResolvedValue({});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const modelOnly = raw.filter((option) => option.category !== 'effort');
    await applyAgentModelSelection({ setConfigOption }, 'sess-1', modelOnly, { effort: 'high' });
    expect(setConfigOption).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain(
      'no selectable effort axis',
    );
    errorSpy.mockRestore();
  });

  it('is a no-op when there is no persisted selection', async () => {
    const setConfigOption = vi.fn().mockResolvedValue({});
    await applyAgentModelSelection({ setConfigOption }, 'sess-1', raw, {});
    expect(setConfigOption).not.toHaveBeenCalled();
  });
});

describe('unadvertisedModelSelectionValues — the pair-time check is advisory, never blocking', () => {
  const raw = parseAdvertisedConfigOptions(claudeLikeRaw());

  it('reports nothing for a fully advertised selection', () => {
    expect(
      unadvertisedModelSelectionValues(raw, { model: 'sonnet', effort: 'high' }),
    ).toEqual([]);
  });

  it('reports an unadvertised model as a custom id, with the axis present', () => {
    expect(unadvertisedModelSelectionValues(raw, { model: 'gpt-nonexistent' })).toEqual([
      { label: 'model', value: 'gpt-nonexistent', axisMissing: false },
    ]);
  });

  it('reports an unadvertised effort as a custom level', () => {
    expect(unadvertisedModelSelectionValues(raw, { effort: 'ultra' })).toEqual([
      { label: 'effort', value: 'ultra', axisMissing: false },
    ]);
  });

  it('flags a missing axis at all rather than inventing one', () => {
    const modelOnly = raw.filter((option) => option.category !== 'effort');
    expect(unadvertisedModelSelectionValues(modelOnly, { effort: 'high' })).toEqual([
      { label: 'effort', value: 'high', axisMissing: true },
    ]);
  });

  it('is empty when neither model nor effort was requested', () => {
    expect(unadvertisedModelSelectionValues(raw, {})).toEqual([]);
  });
});
