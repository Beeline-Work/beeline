import { describe, expect, it, vi } from 'vitest';
import {
  applyAgentModelSelection,
  assertModelConfigOptionAllowed,
  assertModelSelectionAdvertised,
  DisallowedModelConfigOptionError,
  filterAllowedModelConfigOptions,
  filterModelOptionsByCredentials,
  parseAdvertisedConfigOptions,
} from './model-config.js';
import type { AgentModelConfigOption } from '@beeline/buzz-client';

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

  it('never calls setConfigOption for a mode axis, even if a corrupted selection tried to target it', async () => {
    const setConfigOption = vi.fn().mockResolvedValue({});
    // No legitimate caller can populate `selection.model`/`selection.effort`
    // with a mode-shaped value that maps to the mode axis specifically,
    // since the target search is scoped to model/effort categories only —
    // this proves that scoping holds even given the full raw (unfiltered)
    // catalog including a mode axis.
    await applyAgentModelSelection({ setConfigOption }, 'sess-1', raw, {
      model: 'bypassPermissions',
    });
    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it('skips a selection value that no longer matches any advertised option, without throwing', async () => {
    const setConfigOption = vi.fn().mockResolvedValue({});
    await expect(
      applyAgentModelSelection({ setConfigOption }, 'sess-1', raw, { model: 'retired-model' }),
    ).resolves.toBeUndefined();
    expect(setConfigOption).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no persisted selection', async () => {
    const setConfigOption = vi.fn().mockResolvedValue({});
    await applyAgentModelSelection({ setConfigOption }, 'sess-1', raw, {});
    expect(setConfigOption).not.toHaveBeenCalled();
  });
});

describe('assertModelSelectionAdvertised — the pair-time validation gate', () => {
  const raw = parseAdvertisedConfigOptions(claudeLikeRaw());

  it('accepts a model/effort pair that is genuinely advertised', () => {
    expect(() =>
      assertModelSelectionAdvertised(raw, { model: 'sonnet', effort: 'high' }),
    ).not.toThrow();
  });

  it('throws a clear error for a model the agent does not advertise', () => {
    expect(() => assertModelSelectionAdvertised(raw, { model: 'gpt-nonexistent' })).toThrow(
      /not one of "model"'s advertised options/,
    );
  });

  it('throws a clear error for an effort the agent does not advertise', () => {
    expect(() => assertModelSelectionAdvertised(raw, { effort: 'ultra' })).toThrow(
      /not one of "effort"'s advertised options/,
    );
  });

  it('throws when the agent advertises no selectable axis for the requested field at all', () => {
    const modelOnly = raw.filter((option) => option.category !== 'effort');
    expect(() => assertModelSelectionAdvertised(modelOnly, { effort: 'high' })).toThrow(
      /does not advertise a selectable effort/,
    );
  });

  it('never accepts a mode-shaped value even though mode is in the raw catalog', () => {
    expect(() => assertModelSelectionAdvertised(raw, { model: 'bypassPermissions' })).toThrow(
      /not one of "model"'s advertised options/,
    );
  });

  it('is a no-op when neither model nor effort was requested', () => {
    expect(() => assertModelSelectionAdvertised(raw, {})).not.toThrow();
  });
});
