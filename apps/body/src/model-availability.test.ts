import { describe, expect, it } from 'vitest';
import { newIdentity } from '@beeline/gate';
import { buildAgentMessage } from './activity.js';
import {
  modelUnavailableState,
  modelUnavailableEventTags,
  modelUnavailableRoomMessage,
  type ModelUnavailableState,
} from './model-availability.js';
import { ModelSelectionUnavailableError } from './model-config.js';

describe('model unavailable Room projection', () => {
  it('publishes a durable agent message with the selected id and recovery state', () => {
    const state: ModelUnavailableState = {
      kind: 'model-unavailable',
      selection: { model: 'stealth/ox-alpha', effort: 'high' },
      unavailable: { label: 'model', value: 'stealth/ox-alpha' },
      detail: 'model "stealth/ox-alpha" is unavailable. Use z-ai/glm-5.3-flash instead.',
      recovery:
        'Open this agent’s settings, choose a value from the live model catalog, then restart the agent.',
    };
    const event = buildAgentMessage(
      'room-1',
      newIdentity('model-unavailable-test'),
      modelUnavailableRoomMessage(state),
      undefined,
      [],
      modelUnavailableEventTags(state),
      undefined,
      1_700_000_000,
    );

    expect(event.content).toContain('Model unavailable · stealth/ox-alpha');
    expect(event.content).toContain('z-ai/glm-5.3-flash');
    expect(event.tags).toContainEqual(['t', 'agent-message']);
    expect(event.tags).toContainEqual(['t', 'buzz-agent-model-unavailable']);
    expect(event.tags).toContainEqual(['status', 'model-unavailable']);
    expect(event.tags).toContainEqual(['unavailable', 'model']);
    expect(event.tags).toContainEqual(['unavailable-value', 'stealth/ox-alpha']);
    expect(event.tags).toContainEqual(['model', 'stealth/ox-alpha']);
    expect(event.tags).toContainEqual(['effort', 'high']);
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
    expect(modelUnavailableRoomMessage(state)).toContain('Model unavailable · ultra');
    expect(modelUnavailableEventTags(state)).toContainEqual(['unavailable', 'effort']);
    expect(modelUnavailableEventTags(state)).toContainEqual(['unavailable-value', 'ultra']);
  });
});
