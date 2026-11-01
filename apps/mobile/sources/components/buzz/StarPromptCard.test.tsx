import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const wire = vi.hoisted(() => ({ listener: undefined as any }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({
  register: async (_: unknown, listener: unknown) => { wire.listener = listener; return () => {}; },
}) }));
const operation = vi.hoisted(() => vi.fn(async () => ({ prompt: null })));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('./TranscriptCard', () => ({ TranscriptCard: () => null }));
import { useStarPrompt } from './StarPromptCard';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let renderer: ReactTestRenderer | undefined;
let current: ReturnType<typeof useStarPrompt>;
function Probe() { current = useStarPrompt('room', true); return null; }
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
  for (let index = 0; index < 3; index++) {
    await act(async () => frame());
    expect(operation).not.toHaveBeenCalled();
  }
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

it('a reaction win uses its pushed eligibility instead of a follow-up prompt read', async () => {
  await act(async () => { renderer = create(<Probe />); });
  for (let index = 0; index < 4; index++) await act(async () => frame());
  operation.mockClear();
  const prompt = { milestone: 3, repository: 'Beeline-Work/beeline', url: 'https://github.com/Beeline-Work/beeline' };
  await act(async () => {
    wire.listener({ monolithLive: { type: 'message-delta', roomId: 'room', starPrompt: prompt } });
  });
  expect(current!.prompt).toEqual(prompt);
  for (let index = 0; index < 4; index++) await act(async () => frame());
  expect(operation).not.toHaveBeenCalled();
});

it('accepts reaction receipt eligibility without a read and fences an older opening reply', async () => {
  let resolve!: (view: { prompt: null }) => void;
  operation.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => { renderer = create(<Probe />); });
  for (let index = 0; index < 4; index++) await act(async () => frame());
  const prompt = { milestone: 3, repository: 'Beeline-Work/beeline', url: 'https://github.com/Beeline-Work/beeline' };
  await act(async () => current!.accept({ prompt }));
  await act(async () => resolve({ prompt: null }));
  expect(current!.prompt).toEqual(prompt);
  expect(operation).toHaveBeenCalledTimes(1);
});

it('a late eligibility projection cannot redisplay a milestone answered Not now', async () => {
  await act(async () => { renderer = create(<Probe />); });
  const prompt = { milestone: 3, repository: 'Beeline-Work/beeline', url: 'https://github.com/Beeline-Work/beeline' };
  await act(async () => current!.accept({ prompt }));
  operation.mockResolvedValueOnce({ outcome: 'later' } as any);
  await act(async () => current!.answer('later'));
  await act(async () => current!.accept({ prompt }));
  expect(current!.prompt).toBeNull();
});
