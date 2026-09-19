import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveDraftClock } from '@/buzz/live-draft-store';

const probes = vi.hoisted(() => ({
  markdownRenders: 0,
  reducedMotion: false,
  withTiming: vi.fn((value: number) => value),
  cancelAnimation: vi.fn(),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
  };
});

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  const AnimatedText = (props: any) =>
    ReactModule.createElement('AnimatedText', props, props.children);
  return {
    default: { Text: AnimatedText },
    cancelAnimation: probes.cancelAnimation,
    interpolateColor: (value: number, _input: number[], output: string[]) =>
      value <= 0 ? output[0] : output[1],
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useReducedMotion: () => probes.reducedMotion,
    useSharedValue: (value: number) => ReactModule.useRef({ value }).current,
    withTiming: probes.withTiming,
  };
});

vi.mock('./MonoMarkdown', async () => {
  const ReactModule = await import('react');
  return {
    MonoMarkdown: (props: any) => {
      probes.markdownRenders += 1;
      return ReactModule.createElement('MonoMarkdown', props, props.markdown);
    },
  };
});

import { createLiveDraftStore } from '@/buzz/live-draft-store';
import { groknight } from '@/buzz/groknight';
import { StreamingProse } from './StreamingProse';

class FrameClock implements LiveDraftClock {
  at = 0;
  nextId = 1;
  frames = new Map<number, (at: number) => void>();
  timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.at;
  requestFrame = (callback: (at: number) => void) => {
    const id = this.nextId++;
    this.frames.set(id, callback);
    return id;
  };
  cancelFrame = (id: number) => void this.frames.delete(id);
  setTimer = (callback: () => void, delay: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.at + delay, callback });
    return id;
  };
  clearTimer = (id: number) => void this.timers.delete(id);
  frame(at: number) {
    this.at = at;
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    callbacks.forEach((callback) => callback(at));
  }
}

const PROVISIONAL = { color: groknight.ledgerQuiet, fontSize: groknight.proseSize };
const originalConsoleError = console.error;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
  probes.markdownRenders = 0;
  probes.reducedMotion = false;
  probes.withTiming.mockClear();
  probes.cancelAnimation.mockClear();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function mount(store: ReturnType<typeof createLiveDraftStore>): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <StreamingProse
        store={store}
        streamKey="agent-a:turn-a"
        textStyle={PROVISIONAL}
        testID="draft"
      />,
    );
  });
  return renderer;
}

function markdown(renderer: ReactTestRenderer) {
  return renderer.root.findByType('MonoMarkdown').props as {
    markdown: string;
    tail?: { length: number; windowKey: number };
  };
}

describe('StreamingProse row-local reveal', () => {
  it('renders only on text commits while Reanimated owns every reveal frame', () => {
    const clock = new FrameClock();
    const store = createLiveDraftStore({ clock });
    const renderer = mount(store);
    expect(markdown(renderer).markdown).toBe('');

    store.publish('agent-a:turn-a', 'The answer');
    expect(markdown(renderer).markdown).toBe('');
    act(() => clock.frame(16));
    expect(markdown(renderer)).toMatchObject({
      markdown: 'The answer',
      tail: { length: 'The answer'.length },
    });
    expect(probes.withTiming).toHaveBeenCalledTimes(1);
    const rendersAfterCommit = probes.markdownRenders;

    act(() => vi.advanceTimersByTime(160));
    expect(probes.markdownRenders).toBe(rendersAfterCommit);
    expect(markdown(renderer).markdown).toBe('The answer');
  });

  it('extends one running tail without restarting it, then opens a later window', () => {
    const clock = new FrameClock();
    const store = createLiveDraftStore({ clock });
    const renderer = mount(store);
    store.publish('agent-a:turn-a', 'One');
    act(() => clock.frame(16));
    const firstWindow = markdown(renderer).tail!.windowKey;

    clock.at = 20;
    store.publish('agent-a:turn-a', 'One two');
    act(() => clock.frame(50));
    expect(markdown(renderer).tail).toMatchObject({ length: 7, windowKey: firstWindow });
    expect(probes.withTiming).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(200));
    clock.at = 90;
    store.publish('agent-a:turn-a', 'One two three');
    act(() => clock.frame(100));
    expect(markdown(renderer).tail!.windowKey).toBeGreaterThan(firstWindow);
    expect(probes.withTiming).toHaveBeenCalledTimes(2);
  });

  it('shows rewrites and catch-up drains fully, cancelling the reveal', () => {
    const clock = new FrameClock();
    const store = createLiveDraftStore({ clock });
    const renderer = mount(store);
    store.publish('agent-a:turn-a', 'The answer is 41');
    act(() => clock.frame(16));

    act(() => store.publish('agent-a:turn-a', 'The answer is 42'));
    expect(markdown(renderer)).toMatchObject({ markdown: 'The answer is 42', tail: undefined });
    expect(probes.cancelAnimation).toHaveBeenCalled();

    clock.at = 17;
    store.publish('agent-a:turn-a', 'The answer is 42. Done.');
    act(() => store.drain('agent-a:turn-a'));
    expect(markdown(renderer)).toMatchObject({
      markdown: 'The answer is 42. Done.',
      tail: undefined,
    });
  });

  it('keeps the same frame-aligned schedule under reduced motion and reveals no tail', () => {
    probes.reducedMotion = true;
    const clock = new FrameClock();
    const store = createLiveDraftStore({ clock });
    const renderer = mount(store);
    store.publish('agent-a:turn-a', 'Reduced motion');
    expect(markdown(renderer).markdown).toBe('');
    act(() => clock.frame(16));
    expect(markdown(renderer)).toMatchObject({ markdown: 'Reduced motion', tail: undefined });
    expect(probes.withTiming).not.toHaveBeenCalled();
  });
});
