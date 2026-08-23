import { describe, expect, it } from 'vitest';
import { cornerActionSurface, type CornerAttentionMessage } from './corner-attention';

function agentMessage(text: string, timestamp: number): CornerAttentionMessage {
  return { text, timestamp, isAgentAuthor: true };
}

describe('cornerActionSurface', () => {
  it('renders an attention card with the newest agent ask when the verdict is needs-you and no merge target exists', () => {
    const surface = cornerActionSurface({
      status: 'needs-attention',
      hasMergeTarget: false,
      messages: [
        agentMessage('older narration', 100),
        agentMessage(
          'Main moved on since you approved it. Tell me here if you want this corner brought up to date.',
          200,
        ),
        // A person's message never speaks for the corner.
        { text: 'human words', timestamp: 300, isAgentAuthor: false },
      ],
    });
    expect(surface.kind).toBe('attention');
    if (surface.kind !== 'attention') return;
    expect(surface.card.status).toBe('needs-attention');
    expect(surface.card.label).toBe('NEEDS ATTENTION');
    expect(surface.card.detail).toBe(
      'Main moved on since you approved it. Tell me here if you want this corner brought up to date.',
    );
  });

  it('falls back to the review panel reason, then to no detail', () => {
    const withReason = cornerActionSurface({
      status: 'open',
      hasMergeTarget: false,
      mergeNotReadyReason: 'The agent has uncommitted work.',
    });
    expect(withReason).toMatchObject({
      kind: 'attention',
      card: { label: 'READY', detail: 'The agent has uncommitted work.' },
    });
    const bare = cornerActionSurface({ status: 'open', hasMergeTarget: false });
    expect(bare).toMatchObject({ kind: 'attention', card: { label: 'READY' } });
    expect(bare.kind === 'attention' && 'detail' in bare.card).toBe(false);
  });

  it('keeps the existing review panel when a live merge target exists — unchanged path', () => {
    for (const status of ['needs-attention', 'open', 'live'] as const) {
      expect(cornerActionSurface({ status, hasMergeTarget: true })).toEqual({ kind: 'review' });
    }
  });

  it("keeps today's empty state when the verdict is NOT needs-you", () => {
    for (const status of ['live', 'merged', 'archived'] as const) {
      expect(cornerActionSurface({ status, hasMergeTarget: false })).toEqual({
        kind: 'nothing-ready',
      });
    }
    // An unknown verdict (snapshot still in flight) is idle, not needs-you.
    expect(cornerActionSurface({ status: null, hasMergeTarget: false })).toEqual({
      kind: 'nothing-ready',
    });
  });

  it('never renders an attention card for an archived corner even if a stale snapshot disagrees', () => {
    expect(
      cornerActionSurface({ status: 'needs-attention', hasMergeTarget: false, archived: true }),
    ).toEqual({ kind: 'nothing-ready' });
  });

  it('never quotes drafts, system notices, or empty lines as the ask', () => {
    const surface = cornerActionSurface({
      status: 'needs-attention',
      hasMergeTarget: false,
      messages: [
        { text: 'still streaming…', timestamp: 500, isAgentAuthor: true, isAgentDraft: true },
        { text: '', timestamp: 400, isAgentAuthor: true },
      ],
    });
    expect(surface.kind === 'attention' && 'detail' in surface.card).toBe(false);
  });

  it('flattens and bounds the quoted ask to one pointer line', () => {
    const long = 'a'.repeat(400);
    const surface = cornerActionSurface({
      status: 'failed',
      hasMergeTarget: false,
      messages: [agentMessage(`line one\n\nline two   continues\n${long}`, 10)],
    });
    expect(surface.kind === 'attention' && surface.card.detail?.startsWith('line one line two')).toBe(true);
    expect(surface.kind === 'attention' && (surface.card.detail?.length ?? 0)).toBeLessThanOrEqual(240);
  });
});
