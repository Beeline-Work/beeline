import { expect, it } from 'vitest';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
import { splitViewerContext, viewerAgentHandle, viewerContext } from './viewer-conversation';

it('keeps the selected viewer context bounded and separate from visible message prose', () => {
  const context = viewerContext('artifact', 'Checkout [draft]\nstep');
  expect(context).toBe('Viewing artifact: Checkout  draft  step');
  expect(splitViewerContext(`@moth Can you simplify this?\n\n[${context}]`)).toEqual({
    body: '@moth Can you simplify this?', context,
  });
  expect(splitViewerContext('An ordinary [Viewing artifact: note] in prose')).toEqual({
    body: 'An ordinary [Viewing artifact: note] in prose',
  });
});

it('addresses an artifact author only when that handle belongs to an agent', () => {
  const messages = [
    { author: { kind: 'agent', handle: 'moth' } },
    { author: { kind: 'human', handle: 'play-review' } },
  ] as RoomViewMessage[];
  expect(viewerAgentHandle('artifact', 'play-review', messages)).toBe('moth');
  expect(viewerAgentHandle('artifact', '@moth', messages)).toBe('moth');
  expect(viewerAgentHandle('artifact', 'play-review', [])).toBeUndefined();
  expect(viewerAgentHandle('computer', '@moth', [])).toBe('moth');
});
