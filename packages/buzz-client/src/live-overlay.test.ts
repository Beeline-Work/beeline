import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import { LiveOverlayDecoder } from './live-overlay.js';
import { KIND_AGENT_DRAFT, TAG_AGENT_DRAFT } from './kinds.js';

vi.mock('@beeline/nostr', () => ({ verifyEvent: vi.fn(() => true) }));
const agent = 'a'.repeat(64);
const event = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
  id: '1'.repeat(64), pubkey: agent, sig: 'b'.repeat(128),
  kind: KIND_AGENT_DRAFT, created_at: 1, content: 'hello',
  tags: [['t', TAG_AGENT_DRAFT], ['h', 'room'], ['agent', agent],
    ['d', `${TAG_AGENT_DRAFT}:room`], ['request', 'turn']],
  ...overrides,
});
beforeEach(() => vi.mocked(verifyEvent).mockReset().mockReturnValue(true));
describe('live overlay verification budget', () => {
  it.each<{ name: string; overrides: Partial<NostrEvent> }>([
    { name: 'unknown signer', overrides: { pubkey: 'c'.repeat(64) } },
    { name: 'unrelated lane', overrides: { tags: [['t', 'unrelated']] } },
    { name: 'missing request', overrides: { tags: event().tags.filter(([name]) => name !== 'request') } },
    { name: 'malformed id', overrides: { id: 'malformed' } },
    { name: 'invalid sequence', overrides: { created_at: NaN } },
    { name: 'oversized draft', overrides: { content: 'x'.repeat(1_048_577) } },
  ])('rejects $name before verification', ({ overrides }) => {
    const decoder = new LiveOverlayDecoder('room', new Set([agent]));
    expect(decoder.decode(event(overrides))).toBeNull();
    expect(verifyEvent).not.toHaveBeenCalled();
  });
  it('rejects duplicate and older snapshots before verification', () => {
    const decoder = new LiveOverlayDecoder('room', new Set([agent]));
    expect(decoder.decode(event({ created_at: 2 }))).not.toBeNull();
    vi.mocked(verifyEvent).mockClear();
    expect(decoder.decode(event({ created_at: 2 }))).toBeNull();
    expect(decoder.decode(event())).toBeNull();
    expect(verifyEvent).not.toHaveBeenCalled();
  });
  it('verifies each accepted long snapshot once, never replaying earlier text', () => {
    const decoder = new LiveOverlayDecoder('room', new Set([agent]));
    for (let n = 1; n <= 20; n++) {
      const update = event({ id: n.toString(16).padStart(64, '0'), created_at: n, content: 'stream '.repeat(n * 1000) });
      expect(decoder.decode(update)?.kind).toBe('draft');
      expect(verifyEvent).toHaveBeenCalledTimes(n);
      expect(decoder.decode(update)).toBeNull();
      expect(verifyEvent).toHaveBeenCalledTimes(n);
    }
  });
  it('never paints an invalid signature or lets it advance the sequence', () => {
    const decoder = new LiveOverlayDecoder('room', new Set([agent]));
    vi.mocked(verifyEvent).mockReturnValueOnce(false);
    expect(decoder.decode(event({ created_at: 100 }))).toBeNull();
    expect(decoder.decode(event())?.kind).toBe('draft');
  });
});
