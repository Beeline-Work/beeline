import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Linking: { openURL: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    View: host('View'),
    ScrollView: host('ScrollView'),
  };
});

let reducedMotion = false;
vi.mock('react-native-reanimated', () => ({ useReducedMotion: () => reducedMotion }));

import { groknight } from '@/buzz/groknight';
import { StreamingProse } from './StreamingProse';

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
  reducedMotion = false;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

/** Every rendered string, in order — what the reader can actually see. */
function collectText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (typeof node === 'object' && 'children' in (node as any))
    return collectText((node as any).children);
  return '';
}

/** The spans carrying the arriving-tail tone, and the colour they carry. */
function tailSpans(renderer: ReactTestRenderer): { text: string; color: string }[] {
  return renderer.root
    .findAll(
      (node: { type: unknown; props: { style?: unknown } }) =>
        node.type === 'Text' &&
        Array.isArray(node.props.style) &&
        node.props.style.some(
          (entry: unknown) =>
            Boolean(entry) &&
            typeof entry === 'object' &&
            'color' in (entry as Record<string, unknown>) &&
            Object.keys(entry as Record<string, unknown>).length === 1,
        ),
    )
    .map((node: any) => ({
      text: collectText(node.props.children),
      color: node.props.style.find(
        (entry: unknown) =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          Object.keys(entry as Record<string, unknown>).length === 1 &&
          'color' in (entry as Record<string, unknown>),
      ).color as string,
    }));
}

describe('StreamingProse', () => {
  it('shows exactly the text produced, with only the new characters arriving', () => {
    const renderer = render(<StreamingProse markdown="The answer" textStyle={PROVISIONAL} />);
    // The opening chunk has just arrived, so all of it is the tail.
    expect(collectText(renderer.toJSON())).toBe('The answer');
    expect(tailSpans(renderer).map((span) => span.text).join('')).toBe('The answer');

    // Let it settle, then stream a delta.
    act(() => vi.advanceTimersByTime(200));
    expect(tailSpans(renderer)).toEqual([]);
    act(() => renderer.update(<StreamingProse markdown="The answer is 42" textStyle={PROVISIONAL} />));

    expect(collectText(renderer.toJSON())).toBe('The answer is 42');
    // Only the delta animates; the words already read hold still.
    expect(tailSpans(renderer).map((span) => span.text).join('')).toBe(' is 42');
  });

  it('walks the arriving tail up from the ground to the body tone, once', () => {
    const renderer = render(<StreamingProse markdown="Arriving" textStyle={PROVISIONAL} />);
    expect(tailSpans(renderer)[0]?.color).toBe(groknight.bgBase.toLowerCase());

    act(() => vi.advanceTimersByTime(40));
    const midway = tailSpans(renderer)[0]?.color;
    expect(midway).not.toBe(groknight.bgBase.toLowerCase());
    expect(midway).not.toBe(groknight.ledgerQuiet);

    act(() => vi.advanceTimersByTime(160));
    // Settled: the tail is gone and the text simply carries the body tone.
    expect(tailSpans(renderer)).toEqual([]);
    expect(collectText(renderer.toJSON())).toBe('Arriving');
    // And no timer is left running to move it again.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never re-animates text the harness rewrote rather than appended', () => {
    const renderer = render(<StreamingProse markdown="The answer is 41" textStyle={PROVISIONAL} />);
    act(() => vi.advanceTimersByTime(200));
    act(() =>
      renderer.update(<StreamingProse markdown="The answer is 42" textStyle={PROVISIONAL} />),
    );
    expect(collectText(renderer.toJSON())).toBe('The answer is 42');
    expect(tailSpans(renderer)).toEqual([]);
  });

  it('skips the typewriter entirely under reduced motion', () => {
    reducedMotion = true;
    const renderer = render(<StreamingProse markdown="The answer" textStyle={PROVISIONAL} />);
    expect(collectText(renderer.toJSON())).toBe('The answer');
    expect(tailSpans(renderer)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    act(() =>
      renderer.update(<StreamingProse markdown="The answer is 42" textStyle={PROVISIONAL} />),
    );
    expect(collectText(renderer.toJSON())).toBe('The answer is 42');
    expect(tailSpans(renderer)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
