import { describe, expect, it, vi } from 'vitest';
import { ModelSelectionUnavailableError } from './model-config.js';
import {
  applyRuntimeModelPreflight,
  revalidateRuntimeModelSelection,
} from './runtime-model-validation.js';

const agent = { command: 'fake-acp', args: ['stdio'] };

describe('revalidateRuntimeModelSelection', () => {
  it('wires a persisted selection and its startup block onto the daemon Body config', async () => {
    const config: {
      agentEnv: Record<string, string>;
      modelSelection?: { model?: string; effort?: string };
      modelUnavailable?: import('./model-availability.js').ModelUnavailableState;
    } = { agentEnv: {} };
    await applyRuntimeModelPreflight(
      config,
      agent,
      { model: 'stealth/ox-alpha' },
      vi.fn().mockRejectedValue(
        new ModelSelectionUnavailableError({
          label: 'model',
          value: 'stealth/ox-alpha',
          reason: 'not-advertised',
        }),
      ),
    );
    expect(config.modelSelection).toEqual({ model: 'stealth/ox-alpha' });
    expect(config.modelUnavailable).toMatchObject({
      kind: 'model-unavailable',
      unavailable: { label: 'model', value: 'stealth/ox-alpha' },
    });
  });

  it('lets a persisted selection start only after the live validator accepts it', async () => {
    const validate = vi.fn().mockResolvedValue({});
    await expect(
      revalidateRuntimeModelSelection(
        agent,
        { OPENAI_API_KEY: 'held' },
        { model: 'gpt-5.6-sol', effort: 'high' },
        validate,
      ),
    ).resolves.toBeUndefined();
    expect(validate).toHaveBeenCalledWith(
      agent,
      { OPENAI_API_KEY: 'held' },
      { model: 'gpt-5.6-sol', effort: 'high' },
    );
  });

  it('turns a disappeared persisted model into a typed startup block', async () => {
    const validate = vi.fn().mockRejectedValue(
      new ModelSelectionUnavailableError({
        label: 'model',
        value: 'stealth/ox-alpha',
        reason: 'not-advertised',
      }),
    );
    const state = await revalidateRuntimeModelSelection(
      agent,
      {},
      { model: 'stealth/ox-alpha', effort: 'high' },
      validate,
    );
    expect(state).toEqual({
      kind: 'model-unavailable',
      selection: { model: 'stealth/ox-alpha', effort: 'high' },
      unavailable: { label: 'model', value: 'stealth/ox-alpha' },
      detail:
        'model "stealth/ox-alpha" is unavailable. Choose one of the values in the live harness catalog.',
      recovery:
        'Open this agent’s settings, choose a value from the live model catalog, then restart the agent.',
    });
  });

  it('retains a provider redirect while redacting credential-shaped text', async () => {
    const validate = vi.fn().mockRejectedValue(
      new ModelSelectionUnavailableError({
        label: 'model',
        value: 'stealth/ox-alpha',
        reason: 'provider-refused',
        guidance: 'Retired; use z-ai/glm-5.3-flash. token=super-secret',
      }),
    );
    const state = await revalidateRuntimeModelSelection(
      agent,
      {},
      { model: 'stealth/ox-alpha' },
      validate,
    );
    expect(state?.detail).toContain('use z-ai/glm-5.3-flash');
    expect(state?.detail).toContain('credential=[redacted]');
    expect(state?.detail).not.toContain('super-secret');
  });

  it('names a retired effort rather than the still-valid selected model', async () => {
    const validate = vi.fn().mockRejectedValue(
      new ModelSelectionUnavailableError({
        label: 'effort',
        value: 'ultra',
        reason: 'not-advertised',
      }),
    );
    const state = await revalidateRuntimeModelSelection(
      agent,
      {},
      { model: 'sonnet', effort: 'ultra' },
      validate,
    );
    expect(state?.unavailable).toEqual({ label: 'effort', value: 'ultra' });
    expect(state?.detail).toContain('effort "ultra" is unavailable');
  });

  it('does not misreport a catalog transport failure as a retired model', async () => {
    const state = await revalidateRuntimeModelSelection(
      agent,
      {},
      { model: 'sonnet' },
      vi.fn().mockRejectedValue(new Error('ACP handshake timed out')),
    );
    expect(state).toMatchObject({
      kind: 'validation-unavailable',
      unavailable: { label: 'selection', value: 'sonnet' },
    });
    expect(state?.detail).toContain('could not verify');
    expect(state?.detail).not.toContain('ACP handshake timed out');
  });
});
