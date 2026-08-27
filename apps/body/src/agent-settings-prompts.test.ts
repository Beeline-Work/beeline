import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACCESS_AUTO_RESPONSE, DEFAULT_ACCESS_POLICY } from './access-policy.js';
import { resolveAccessSettings } from './agent-settings-prompts.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@clack/prompts');
  vi.doUnmock('./model-catalog.js');
  vi.resetModules();
});

describe('resolveAccessSettings — flag/prompt skip logic', () => {
  it('never re-prompts for access itself when --access is given, regardless of TTY', async () => {
    const pickAccess = vi.fn();

    const result = await resolveAccessSettings(
      { access: 'creator', autoResponse: 'flag text', interactiveUi: true },
      { pickAccess, pickAutoResponse: vi.fn() },
    );

    expect(result.access).toBe('creator');
    expect(pickAccess).not.toHaveBeenCalled();
  });

  it('falls back to DEFAULT_ACCESS_POLICY non-interactively with no flag', async () => {
    const pickAccess = vi.fn();

    const result = await resolveAccessSettings(
      { interactiveUi: false },
      { pickAccess, pickAutoResponse: vi.fn() },
    );

    expect(result.access).toBe(DEFAULT_ACCESS_POLICY);
    expect(pickAccess).not.toHaveBeenCalled();
  });

  it('prompts for access interactively when no flag was given', async () => {
    const pickAccess = vi.fn().mockResolvedValue('creator');
    const pickAutoResponse = vi.fn().mockResolvedValue(undefined);

    const result = await resolveAccessSettings(
      { interactiveUi: true },
      { pickAccess, pickAutoResponse },
    );

    expect(pickAccess).toHaveBeenCalledTimes(1);
    expect(result.access).toBe('creator');
    // Access resolved to creator via the picker, so the auto-response
    // prompt runs too (no --auto-response flag given).
    expect(pickAutoResponse).toHaveBeenCalledTimes(1);
  });

  it('never offers the auto-response prompt when access resolves to everyone', async () => {
    const pickAccess = vi.fn().mockResolvedValue('everyone');
    const pickAutoResponse = vi.fn();

    const result = await resolveAccessSettings(
      { interactiveUi: true },
      { pickAccess, pickAutoResponse },
    );

    expect(result.access).toBe('everyone');
    expect(pickAutoResponse).not.toHaveBeenCalled();
  });

  it('never prompts for auto-response when --auto-response is given', async () => {
    const pickAutoResponse = vi.fn();

    const result = await resolveAccessSettings(
      { access: 'creator', autoResponse: 'custom line', interactiveUi: true },
      { pickAccess: vi.fn(), pickAutoResponse },
    );

    expect(result.autoResponse).toBe('custom line');
    expect(pickAutoResponse).not.toHaveBeenCalled();
  });

  it('offers the auto-response prompt when access is creator (already set by flag) and no --auto-response flag was given', async () => {
    const pickAutoResponse = vi.fn().mockResolvedValue('a custom refusal');

    const result = await resolveAccessSettings(
      { access: 'creator', interactiveUi: true },
      { pickAccess: vi.fn(), pickAutoResponse },
    );

    expect(pickAutoResponse).toHaveBeenCalledTimes(1);
    expect(result.autoResponse).toBe('a custom refusal');
  });

  it('never prompts (either axis) on a non-TTY run, even with neither flag — this must never block', async () => {
    const pickAccess = vi.fn();
    const pickAutoResponse = vi.fn();

    const result = await resolveAccessSettings(
      { interactiveUi: false },
      { pickAccess, pickAutoResponse },
    );

    expect(pickAccess).not.toHaveBeenCalled();
    expect(pickAutoResponse).not.toHaveBeenCalled();
    expect(result).toEqual({ access: DEFAULT_ACCESS_POLICY });
  });
});

describe('pickAccessPolicy / pickAutoResponse — real clack wiring', () => {
  it('offers everyone/creator with everyone pre-selected, and cancels cleanly on Ctrl-C', async () => {
    const select = vi.fn().mockResolvedValue(Symbol('cancel'));
    vi.doMock('@clack/prompts', () => ({
      select,
      text: vi.fn(),
      spinner: vi.fn(),
      log: { warn: vi.fn() },
      isCancel: (value: unknown) => typeof value === 'symbol',
      cancel: vi.fn(),
    }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    const { pickAccessPolicy } = await import('./agent-settings-prompts.js');
    await expect(pickAccessPolicy()).rejects.toThrow('process.exit(1)');

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Who may address this agent?'),
        initialValue: DEFAULT_ACCESS_POLICY,
        options: [
          expect.objectContaining({ value: 'everyone' }),
          expect.objectContaining({ value: 'creator' }),
        ],
      }),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('reports no override when the auto-response prompt is answered with the default text (Enter)', async () => {
    const text = vi.fn().mockResolvedValue(DEFAULT_ACCESS_AUTO_RESPONSE);
    vi.doMock('@clack/prompts', () => ({
      select: vi.fn(),
      text,
      spinner: vi.fn(),
      log: { warn: vi.fn() },
      isCancel: () => false,
      cancel: vi.fn(),
    }));

    const { pickAutoResponse } = await import('./agent-settings-prompts.js');
    const result = await pickAutoResponse();

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ defaultValue: DEFAULT_ACCESS_AUTO_RESPONSE }),
    );
    expect(result).toBeUndefined();
  });

  it('reports the custom text as an override when it differs from the default', async () => {
    vi.doMock('@clack/prompts', () => ({
      select: vi.fn(),
      text: vi.fn().mockResolvedValue('a bespoke refusal line'),
      spinner: vi.fn(),
      log: { warn: vi.fn() },
      isCancel: () => false,
      cancel: vi.fn(),
    }));

    const { pickAutoResponse } = await import('./agent-settings-prompts.js');
    const result = await pickAutoResponse();

    expect(result).toBe('a bespoke refusal line');
  });
});

describe('pickModelAndEffort — per-harness catalog pickers', () => {
  const agent = { kind: 'codex' as const, command: 'codex-acp', args: [] };
  const catalog = {
    catalog: [
      {
        id: 'model',
        category: 'model',
        currentValue: 'gpt-5.6-sol',
        options: [
          { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
          { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
        ],
      },
      {
        id: 'reasoning_effort',
        category: 'thought_level',
        currentValue: 'high',
        options: [
          { id: 'low', name: 'Low' },
          { id: 'high', name: 'High' },
        ],
      },
    ],
    raw: [],
  };

  function mockCatalogAndClack(
    select: ReturnType<typeof vi.fn>,
    autocomplete: ReturnType<typeof vi.fn> = vi.fn(),
  ) {
    vi.doMock('./model-catalog.js', () => ({
      fetchAgentModelCatalog: vi.fn(async () => catalog),
    }));
    vi.doMock('@clack/prompts', () => ({
      select,
      autocomplete,
      text: vi.fn(),
      spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
      log: { warn: vi.fn() },
      isCancel: () => false,
      cancel: vi.fn(),
    }));
  }

  /** The dynamic options getter clack re-invokes per keystroke with the live prompt as `this`. */
  function optionsFromAutocompleteCall(
    autocomplete: ReturnType<typeof vi.fn>,
  ): (this: { userInput: string }) => Array<{ value: string; label: string; hint?: string }> {
    expect(autocomplete).toHaveBeenCalled();
    const options = autocomplete.mock.calls[0]![0].options;
    expect(typeof options).toBe('function');
    return options;
  }

  it('offers a SEARCHABLE model picker then a plain effort picker from that harness catalog', async () => {
    const autocomplete = vi.fn().mockResolvedValueOnce('gpt-5.6-terra');
    const select = vi.fn().mockResolvedValueOnce('low');
    mockCatalogAndClack(select, autocomplete);

    const { pickModelAndEffort } = await import('./agent-settings-prompts.js');
    const result = await pickModelAndEffort(agent, {});

    // Model axis: searchable autocomplete with the harness default pre-selected.
    expect(autocomplete).toHaveBeenCalledTimes(1);
    expect(autocomplete.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        message: 'Model for this codex agent?',
        initialValue: 'gpt-5.6-sol',
        maxItems: expect.any(Number),
      }),
    );
    // Effort axis: small list, plain select over live values only.
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        message: 'Effort/thinking level for this codex agent?',
        initialValue: 'high',
        options: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' },
        ],
      }),
    );
    expect(result).toEqual({ model: 'gpt-5.6-terra', effort: 'low' });
  });

  it('filters the searchable model list by substring across id AND display name', async () => {
    const autocomplete = vi.fn().mockResolvedValueOnce('gpt-5.6-terra');
    const select = vi.fn().mockResolvedValueOnce('low');
    mockCatalogAndClack(select, autocomplete);

    const { pickModelAndEffort } = await import('./agent-settings-prompts.js');
    await pickModelAndEffort(agent, {});

    const options = optionsFromAutocompleteCall(autocomplete);
    // Empty input: the whole catalog, no custom entry.
    expect(options.call({ userInput: '' })).toEqual([
      { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
      { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
    ]);
    // By id fragment: typed text narrows the catalog but is never submitted.
    expect(options.call({ userInput: 'terra' })).toEqual([
      { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
    ]);
    // By display name, case-insensitively.
    expect(options.call({ userInput: 'sOL' })).toEqual([
      { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    ]);
    expect(options.call({ userInput: 'zzz' })).toEqual([]);
  });

  it('never offers typed text as a custom model id', async () => {
    const typedId = 'openrouter/stealth/ox-alpha';
    const autocomplete = vi.fn().mockResolvedValueOnce(typedId);
    const select = vi.fn().mockResolvedValueOnce('high');
    const text = vi.fn();
    vi.doMock('./model-catalog.js', () => ({
      fetchAgentModelCatalog: vi.fn(async () => catalog),
    }));
    vi.doMock('@clack/prompts', () => ({
      select,
      autocomplete,
      text,
      spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
      log: { warn: vi.fn() },
      isCancel: () => false,
      cancel: vi.fn(),
    }));

    const { pickModelAndEffort } = await import('./agent-settings-prompts.js');
    const result = await pickModelAndEffort(agent, {});

    const options = optionsFromAutocompleteCall(autocomplete);
    expect(options.call({ userInput: typedId })).toEqual([]);
    expect(text).not.toHaveBeenCalled();
    expect(result.model).toBe(typedId);
  });

  it('never duplicates a custom option when the typed text IS a catalog choice', async () => {
    const autocomplete = vi.fn().mockResolvedValueOnce('gpt-5.6-sol');
    const select = vi.fn().mockResolvedValueOnce('low');
    mockCatalogAndClack(select, autocomplete);

    const { pickModelAndEffort } = await import('./agent-settings-prompts.js');
    await pickModelAndEffort(agent, {});

    const options = optionsFromAutocompleteCall(autocomplete);
    const returned = options.call({ userInput: 'GPT-5.6-SOL' });
    const values = returned.map((option) => option.value);
    expect(values.filter((value) => value.toLowerCase() === 'gpt-5.6-sol')).toHaveLength(1);
    expect(returned.some((option) => option.hint !== undefined)).toBe(false);
  });

  it('exits cleanly when the searchable model picker is cancelled (Ctrl-C)', async () => {
    const cancelSymbol = Symbol.for('clack:cancel');
    const autocomplete = vi.fn().mockResolvedValue(cancelSymbol);
    const select = vi.fn();
    vi.doMock('./model-catalog.js', () => ({
      fetchAgentModelCatalog: vi.fn(async () => catalog),
    }));
    vi.doMock('@clack/prompts', () => ({
      select,
      autocomplete,
      text: vi.fn(),
      spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
      log: { warn: vi.fn() },
      isCancel: (value: unknown) => typeof value === 'symbol',
      cancel: vi.fn(),
    }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    const { pickModelAndEffort } = await import('./agent-settings-prompts.js');
    await expect(pickModelAndEffort(agent, {})).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    // Cancelled before reaching the effort axis.
    expect(select).not.toHaveBeenCalled();
  });

  it('skips only the axis whose flag was already given — --model never opens the searchable picker', async () => {
    const autocomplete = vi.fn();
    const select = vi.fn().mockResolvedValue('low');
    mockCatalogAndClack(select, autocomplete);

    const { pickModelAndEffort } = await import('./agent-settings-prompts.js');
    const result = await pickModelAndEffort(agent, {}, { model: 'gpt-5.6-sol' });

    expect(autocomplete).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0]![0].message).toContain('Effort/thinking');
    expect(result).toEqual({ model: 'gpt-5.6-sol', effort: 'low' });
  });

  it('does not fetch or prompt when both flags were given', async () => {
    const fetchAgentModelCatalog = vi.fn();
    const select = vi.fn();
    vi.doMock('./model-catalog.js', () => ({ fetchAgentModelCatalog }));
    vi.doMock('@clack/prompts', () => ({
      select,
      autocomplete: vi.fn(),
      text: vi.fn(),
      spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
      log: { warn: vi.fn() },
      isCancel: () => false,
      cancel: vi.fn(),
    }));

    const { pickModelAndEffort } = await import('./agent-settings-prompts.js');
    const result = await pickModelAndEffort(agent, {}, { model: 'gpt-5.6-sol', effort: 'high' });

    expect(fetchAgentModelCatalog).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(result).toEqual({ model: 'gpt-5.6-sol', effort: 'high' });
  });

  it('fails closed when the live catalog fetch fails', async () => {
    const fetchAgentModelCatalog = vi.fn(async () => {
      throw new Error('ACP handshake timed out');
    });
    const select = vi.fn();
    const autocomplete = vi.fn();
    const text = vi
      .fn()
      .mockResolvedValueOnce('openrouter/stealth/ox-alpha')
      .mockResolvedValueOnce('high');
    const warn = vi.fn();
    vi.doMock('./model-catalog.js', () => ({ fetchAgentModelCatalog }));
    vi.doMock('@clack/prompts', () => ({
      select,
      autocomplete,
      text,
      spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
      log: { warn },
      isCancel: () => false,
      cancel: vi.fn(),
    }));

    const { pickModelAndEffort } = await import('./agent-settings-prompts.js');
    await expect(pickModelAndEffort(agent, {})).rejects.toThrow('ACP handshake timed out');
    expect(warn).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(autocomplete).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it('does not invent prompts when the live catalog advertises no usable axes', async () => {
    const fetchAgentModelCatalog = vi.fn(async () => ({ raw: [], catalog: [] }));
    const select = vi.fn();
    const text = vi
      .fn()
      .mockResolvedValueOnce('openrouter/stealth/ox-alpha')
      .mockResolvedValueOnce('high');
    vi.doMock('./model-catalog.js', () => ({ fetchAgentModelCatalog }));
    vi.doMock('@clack/prompts', () => ({
      select,
      text,
      spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
      log: { warn: vi.fn() },
      isCancel: () => false,
      cancel: vi.fn(),
    }));

    const { pickModelAndEffort } = await import('./agent-settings-prompts.js');
    const result = await pickModelAndEffort(agent, {});

    expect(select).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('returns no selection when the catalog has no axes', async () => {
    const fetchAgentModelCatalog = vi.fn(async () => ({ raw: [], catalog: [] }));
    const select = vi.fn();
    const text = vi.fn().mockResolvedValue('');
    vi.doMock('./model-catalog.js', () => ({ fetchAgentModelCatalog }));
    vi.doMock('@clack/prompts', () => ({
      select,
      text,
      spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
      log: { warn: vi.fn() },
      isCancel: () => false,
      cancel: vi.fn(),
    }));

    const { pickModelAndEffort } = await import('./agent-settings-prompts.js');
    const result = await pickModelAndEffort(agent, {});

    expect(result).toEqual({});
    expect(text).not.toHaveBeenCalled();
  });
});
