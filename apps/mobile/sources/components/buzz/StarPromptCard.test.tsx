import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const operation = vi.hoisted(() => vi.fn(async () => ({ prompt: null })));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('./TranscriptCard', () => ({ TranscriptCard: () => null }));
import { useStarPrompt } from './StarPromptCard';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let renderer: ReactTestRenderer | undefined;
function Probe() { useStarPrompt('no-wins', true); return null; }
function frame() {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(0));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  operation.mockClear();
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
it('leaves the first Room frame free of the optional prompt request', async () => {
  await act(async () => { renderer = create(<Probe />); });
  expect(operation).not.toHaveBeenCalled();
  await act(async () => frame());
  expect(operation).not.toHaveBeenCalled();
  await act(async () => frame());
  expect(operation).toHaveBeenCalledExactlyOnceWith('readStarPrompt', {});
});
it('does not send a prompt request after leaving before the first frame', async () => {
  await act(async () => { renderer = create(<Probe />); });
  await act(async () => renderer!.unmount());
  renderer = undefined;
  frame();
  frame();
  expect(operation).not.toHaveBeenCalled();
});
