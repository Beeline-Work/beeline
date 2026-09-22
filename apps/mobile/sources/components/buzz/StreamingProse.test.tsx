import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
    Linking: { openURL: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    TextInput: ReactModule.forwardRef((props: any, ref) =>
      ReactModule.createElement('TextInput', { ...props, ref }, props.children),
    ),
    View: host('View'),
    ScrollView: host('ScrollView'),
  };
});

// Code fences share the native output sheet; keep its platform shell out of Node.
vi.mock('./HullActionSheet', async () => {
  const ReactModule = await import('react');
  return {
    HULL_SHEET_INSET: 22,
    HullActionSheetModal: (props: any) =>
      ReactModule.createElement('HullActionSheetModal', props, props.children),
    HullActionSheetRow: (props: any) => ReactModule.createElement('HullActionSheetRow', props),
  };
});

vi.mock('react-native-reanimated', () => ({ useReducedMotion: () => false }));

import { groknight } from '@/buzz/groknight';
import {
  createLiveDraftDrainStore,
  type LiveDraftClock,
} from '@/buzz/live-draft-drain';
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

class ManualClock implements LiveDraftClock {
  at = 0;
  nextId = 1;
  timers = new Map<number, { at: number; callback: () => void }>();

  now() {
    return this.at;
  }

  setTimer(callback: () => void, delayMs: number) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.at + delayMs, callback });
    return id;
  }

  clearTimer(id: number) {
    this.timers.delete(id);
  }

  runNext() {
    const next = [...this.timers.entries()].sort((left, right) => left[1].at - right[1].at)[0];
    if (!next) return false;
    const [id, timer] = next;
    this.timers.delete(id);
    this.at = timer.at;
    timer.callback();
    return true;
  }
}

function collectText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (typeof node === 'object' && 'children' in (node as any))
    return collectText((node as any).children);
  return '';
}

describe('StreamingProse', () => {
  it('keeps the static compatibility seam printable', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<StreamingProse markdown="**Finished**" textStyle={PROVISIONAL} />);
    });
    expect(collectText(renderer.toJSON())).toContain('Finished');
  });

  it('prints the streaming draft literally through one plain Text, never Markdown', () => {
    // Option A: the live lane is one plain Text node. A half-written
    // `**bold**` shows its asterisks while the turn writes; the finished
    // durable reply is the surface that renders Markdown (C98).
    const clock = new ManualClock();
    const store = createLiveDraftDrainStore({ clock });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <StreamingProse streamKey="agent:turn" store={store} textStyle={PROVISIONAL} />,
      );
    });
    act(() => store.publish('agent:turn', '**The first scroll: the ancient beacons.**'));
    act(() => clock.runNext());

    const text = collectText(renderer.toJSON());
    expect(text).toContain('**The first scroll: the ancient beacons.**');
    // Exactly one text host: no block tree, no Markdown renderer in the lane.
    const textHosts = renderer.root.findAll(
      (node: { type: unknown }) => node.type === 'Text',
    );
    expect(textHosts).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('renders far fewer times than the 800 cumulative deltas it receives', () => {
    const clock = new ManualClock();
    const store = createLiveDraftDrainStore({ clock });
    let commits = 0;
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <React.Profiler id="live-row" onRender={() => (commits += 1)}>
          <StreamingProse streamKey="agent:turn" store={store} textStyle={PROVISIONAL} />
        </React.Profiler>,
      );
    });
    const mountedCommits = commits;

    let cumulative = '';
    act(() => {
      for (let chunk = 0; chunk < 800; chunk += 1) {
        cumulative += `${String(chunk).padStart(4, '0')} arriving words${chunk % 3 === 2 ? '\n' : ' '}`;
        store.publish('agent:turn', cumulative);
      }
    });

    // Arrival is queueing, not paint and not React work.
    expect(commits).toBe(mountedCommits);

    let ticks = 0;
    while (clock.timers.size) {
      act(() => clock.runNext());
      ticks += 1;
      if (ticks > 2_000) throw new Error('live drain did not become idle');
    }

    const metrics = store.getMetrics('agent:turn');
    expect(metrics.arrivals).toBe(800);
    expect(metrics.paints).toBeLessThan(800 / 3);
    expect(commits - mountedCommits).toBeLessThanOrEqual(metrics.paints);
    expect(commits - mountedCommits).toBeLessThan(800 / 3);
    expect(store.getPresentation('agent:turn')).toEqual({ text: cumulative });
    act(() => renderer.unmount());
  });

  it('makes a non-prefix rewrite visible immediately without a drain animation', () => {
    const clock = new ManualClock();
    const store = createLiveDraftDrainStore({ clock });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <StreamingProse streamKey="agent:turn" store={store} textStyle={PROVISIONAL} />,
      );
    });

    act(() => store.publish('agent:turn', 'first version'));
    act(() => clock.runNext());
    act(() => store.publish('agent:turn', 'replacement'));

    expect(store.getPresentation('agent:turn')).toEqual({ text: 'replacement' });
    expect(store.getMetrics('agent:turn').rewrites).toBe(1);
    expect(collectText(renderer.toJSON())).toContain('replacement');
    act(() => renderer.unmount());
  });
});