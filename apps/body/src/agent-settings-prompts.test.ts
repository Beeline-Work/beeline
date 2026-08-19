import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACCESS_AUTO_RESPONSE, DEFAULT_ACCESS_POLICY } from './access-policy.js';
import { resolveAccessSettings } from './agent-settings-prompts.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@clack/prompts');
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
