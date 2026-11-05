import { afterEach, describe, expect, it } from 'vitest';
import type { LiveOverlay } from '@beeline/buzz-client';
import { applyLiveOverlayStructure, createLiveDraftDrainStore } from './live-draft-drain';
import { liveDraftMessages } from './live-turn-stream';

const agentPubkey = 'c3dfbf8acbb4b6e9f11bd37119a5ce2f4f104257885d098d8e075c0b0c4c066b';
const requestId = '294ee1cc8332a60c7c7cd0973628a26ab38cf4c4b9d3a802f6182ec38d6f326f';
const store = createLiveDraftDrainStore();

function draft(text: string, request = requestId): Extract<LiveOverlay, { kind: 'draft' }> {
  return {
    kind: 'draft',
    key: `draft:${agentPubkey}:${request}`,
    stableId: `live-turn:${agentPubkey}:${request}`,
    agentPubkey,
    requestId: request,
    text,
    closed: false,
    createdAt: Date.parse('2026-11-05T15:35:17.665496Z') / 1_000,
  };
}

afterEach(() => store.reset());

describe('draft baseline initialization', () => {
  it('does not create a transcript lane for Ruby’s empty baseline with no durable message', () => {
    const current: readonly LiveOverlay[] = [];
    const overlays = applyLiveOverlayStructure(current, draft(''), store);

    expect(overlays).toBe(current);
    expect(liveDraftMessages(overlays, [])).toEqual([]);
  });

  it('opens the lane on its first text and keeps subsequent text out of structural state', () => {
    const initialized = applyLiveOverlayStructure([], draft(''), store);
    const opened = applyLiveOverlayStructure(initialized, draft('The reply is ready.'), store);

    expect(liveDraftMessages(opened, [])).toHaveLength(1);
    expect(store.getReceived(`${agentPubkey}:${requestId}`)).toBe('The reply is ready.');
    expect(opened[0]).not.toHaveProperty('text');

    const updated = applyLiveOverlayStructure(opened, draft('The reply is ready. Here it is.'), store);
    expect(updated).toBe(opened);
    expect(store.getReceived(`${agentPubkey}:${requestId}`)).toBe('The reply is ready. Here it is.');
  });

  it('preserves an existing draft while another request initializes without text', () => {
    const previousRequest = 'previous-request';
    const previous = applyLiveOverlayStructure([], draft('Already visible.', previousRequest), store);
    const initialized = applyLiveOverlayStructure(previous, draft(''), store);

    expect(initialized).toBe(previous);
    expect(store.getReceived(`${agentPubkey}:${previousRequest}`)).toBe('Already visible.');

    const opened = applyLiveOverlayStructure(initialized, draft('New reply.'), store);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ requestId });
    expect(store.getReceived(`${agentPubkey}:${requestId}`)).toBe('New reply.');
  });

  it('keeps real streamed text when its lane retracts', () => {
    const opened = applyLiveOverlayStructure([], draft('Already visible.'), store);
    const { text: _text, ...update } = draft('');
    const retracted = applyLiveOverlayStructure(opened, { ...update, closed: true }, store);

    expect(retracted[0]).toMatchObject({ closed: true, requestId });
    expect(liveDraftMessages(retracted, [])).toHaveLength(1);
    expect(store.getReceived(`${agentPubkey}:${requestId}`)).toBe('Already visible.');
  });

  it('does not change the presence and thought paths', () => {
    const presence: LiveOverlay = {
      kind: 'presence', key: 'presence', agentPubkey, status: 'online', createdAt: 1,
    };
    const thought: LiveOverlay = {
      kind: 'thought', key: 'thought', agentPubkey, sessionId: requestId,
      text: 'Thinking', closed: false, createdAt: 2,
    };
    const overlays = applyLiveOverlayStructure(
      applyLiveOverlayStructure([], presence, store), thought, store,
    );

    expect(overlays).toEqual([presence, thought]);
  });
});
