import { expect, it } from 'vitest';
import { generateKeypair, signEvent } from '@beeline/nostr';
import { LiveOverlayDecoder } from './live-overlay.js';
import { KIND_AGENT_DRAFT, TAG_AGENT_DRAFT } from './kinds.js';

it('verifies the signature before publishing and never lets a forgery advance a live lane', () => {
  const pair = generateKeypair();
  const signed = signEvent({
    pubkey: pair.publicKey, created_at: 1, kind: KIND_AGENT_DRAFT, content: 'signed draft',
    tags: [['t', TAG_AGENT_DRAFT], ['h', 'room'], ['agent', pair.publicKey],
      ['d', `${TAG_AGENT_DRAFT}:room`], ['request', 'turn']],
  }, pair.secretKey);
  const decoder = new LiveOverlayDecoder('room', new Set([pair.publicKey]));
  expect(decoder.decode({ ...signed, content: 'forged', created_at: 100 })).toBeNull();
  expect(decoder.decode(signed)?.kind).toBe('draft');
  expect(decoder.decode(signed)).toBeNull();
});
