import { describe, expect, it } from 'vitest';
import {
  modelUnavailableDiagnostic,
  modelUnavailableState,
  type ModelUnavailableState,
} from './model-availability.js';
import { ModelSelectionUnavailableError } from './model-config.js';

describe('model unavailable startup state', () => {
  it('keeps a bounded local diagnostic with the selected id and recovery state', () => {
    const state: ModelUnavailableState = {
      kind: 'model-unavailable',
      selection: { model: 'stealth/ox-alpha', effort: 'high' },
      unavailable: { label: 'model', value: 'stealth/ox-alpha' },
      detail: 'model "stealth/ox-alpha" is unavailable. Use z-ai/glm-5.3-flash instead.',
      recovery:
        'Open this agent’s settings, choose a value from the live model catalog, then restart the agent.',
    };
    expect(modelUnavailableDiagnostic(state)).toContain('Model unavailable · stealth/ox-alpha');
    expect(modelUnavailableDiagnostic(state)).toContain('z-ai/glm-5.3-flash');
  });

  it('headlines and tags the failed effort when the selected model is still valid', () => {
    const state = modelUnavailableState(
      { model: 'sonnet', effort: 'ultra' },
      new ModelSelectionUnavailableError({
        label: 'effort',
        value: 'ultra',
        reason: 'not-advertised',
      }),
    );
    expect(modelUnavailableDiagnostic(state)).toContain('Model unavailable · ultra');
    expect(state.unavailable).toEqual({ label: 'effort', value: 'ultra' });
  });
});
