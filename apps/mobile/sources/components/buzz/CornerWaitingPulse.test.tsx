import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  timings: [] as Array<Record<string, unknown>>,
  starts: 0,
  stops: 0,
  reducedMotion: false,
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  class Value {
    constructor(public value: number) {}
    setValue(value: number) {
      this.value = value;
    }
    interpolate(config: unknown) {
      return { interpolation: config };
    }
  }
  return {
    Animated: {
      Value,
      View: (props: any) => ReactModule.createElement('AnimatedView', props, props.children),
      timing: (_value: unknown, config: Record<string, unknown>) => {
        native.timings.push(config);
        return { config };
      },
      loop: () => ({
        start: () => void (native.starts += 1),
        stop: () => void (native.stops += 1),
      }),
    },
    Easing: { linear: 'linear' },
  };
});
vi.mock('react-native-reanimated', () => ({
  useReducedMotion: () => native.reducedMotion,
}));

const { CornerWaitingPulse, WAITING_PULSE_CYCLE, waitingPulseOpacity } =
  await import('./CornerWaitingPulse');

describe('waiting pulse clock', () => {
  it('is one slow breath, slower than the 1120 ms live pulse', () => {
    expect(WAITING_PULSE_CYCLE).toBeGreaterThan(1120);
    expect(waitingPulseOpacity(0)).toBeCloseTo(1);
    expect(waitingPulseOpacity(WAITING_PULSE_CYCLE / 2)).toBeCloseTo(0.45);
  });

  it('gives every label the same opacity at the same frame time', () => {
    for (const at of [0, 317, 1200, 2399]) {
      expect(waitingPulseOpacity(at + WAITING_PULSE_CYCLE * 7)).toBeCloseTo(
        waitingPulseOpacity(at),
      );
    }
  });
});

describe('CornerWaitingPulse on the phone', () => {
  const label = (state: 'waiting' | 'working', key: string) => (
    <CornerWaitingPulse key={key} state={state}>
      {state}
    </CornerWaitingPulse>
  );

  it('breathes on one native-driven loop shared by every waiting label', () => {
    let tree: any;
    act(() => {
      tree = create(<>{[label('waiting', 'a'), label('working', 'b')]}</>);
    });
    act(() => tree.update(<>{[label('waiting', 'a'), label('waiting', 'b')]}</>));

    // The loop runs on the native driver, so no frame callback commits a new
    // shadow tree while a corner waits.
    expect(native.timings).toEqual([
      expect.objectContaining({ duration: WAITING_PULSE_CYCLE, useNativeDriver: true }),
    ]);
    expect(native.starts).toBe(1);
    const pulses = tree.root.findAllByType('AnimatedView');
    expect(pulses).toHaveLength(2);
    expect(pulses[0].props.style.opacity).toBe(pulses[1].props.style.opacity);
    expect(pulses[0].props.style.opacity).toHaveProperty('interpolation');

    act(() => tree.update(<>{[label('working', 'a'), label('waiting', 'b')]}</>));
    expect(native.stops).toBe(0);
    act(() => tree.unmount());
    expect(native.stops).toBe(1);
  });

  it('holds a waiting label still under reduced motion', () => {
    native.reducedMotion = true;
    const before = native.starts;
    let tree: any;
    act(() => {
      tree = create(label('waiting', 'a'));
    });
    expect(native.starts).toBe(before);
    expect(
      tree.root.find((node: any) => node.props?.testID === 'corner-waiting-pulse').props.style,
    ).toEqual({ opacity: 1 });
    act(() => tree.unmount());
    native.reducedMotion = false;
  });
});
