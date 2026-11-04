import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TranscriptSwipeable from './TranscriptSwipeable';

const rig = vi.hoisted(() => ({ pan: {} as Record<string, any>, offset: null as null | { value: number }, springs: [] as any[] }));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  StyleSheet: { create: (value: unknown) => value, absoluteFillObject: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 } },
  View: (props: any) => React.createElement('View', props, props.children),
}));
vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
  Gesture: { Pan: () => {
    const pan: Record<string, any> = {};
    for (const key of ['enabled', 'activeOffsetX', 'onStart', 'onUpdate', 'onEnd', 'onFinalize'])
      pan[key] = (value: unknown) => { rig.pan[key] = value; return pan; };
    return pan;
  } },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: (props: any) => React.createElement('AnimatedView', props, props.children) },
  ReduceMotion: { System: 'system' },
  runOnJS: (fn: unknown) => fn,
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (value: number) => { const ref = React.useRef({ value }); rig.offset = ref.current; return ref.current; },
  withSpring: (value: number, config: unknown, finish: unknown) => { rig.springs.push({ value, config, finish }); return value; },
}));

function mount(props: Record<string, unknown> = {}) {
  let renderer: any;
  act(() => { renderer = create(<TranscriptSwipeable renderLeftActions={() => <span>corner</span>} renderRightActions={() => <span>reply</span>} {...props}><span>message</span></TranscriptSwipeable>); });
  return renderer;
}

beforeEach(() => { rig.pan = {}; rig.offset = null; rig.springs = []; });
describe('transcript one-action swipe', () => {
  it('keeps the native recognizer available from the first render and matches the existing drag thresholds', () => {
    const renderer = mount();
    expect(rig.pan.enabled).toBe(true);
    expect(rig.pan.activeOffsetX).toEqual([-18, 10]);
    expect(renderer.root.findAllByType('GestureDetector')).toHaveLength(1);
    expect(renderer.root.findAllByType('span').map((node: any) => node.props.children)).toContain('message');
  });

  it('returns below-threshold and scroll-cancelled drags without committing an action', () => {
    const action = vi.fn(), closed = vi.fn();
    mount({ onSwipeableWillOpen: action, onSwipeableClose: closed });
    act(() => { rig.pan.onUpdate({ translationX: -20 }); rig.pan.onEnd({ translationX: -20, velocityX: 0 }); rig.pan.onFinalize(); });
    expect(action).not.toHaveBeenCalled();
    expect(rig.offset?.value).toBe(0);
    expect(rig.springs[0].config).toMatchObject({ damping: 1000, stiffness: 700, reduceMotion: 'system' });
    act(() => rig.springs[0].finish(false));
    expect(closed).not.toHaveBeenCalled();
    act(() => rig.springs[0].finish(true));
    expect(closed).toHaveBeenCalledWith('right');
    act(() => { rig.pan.onUpdate({ translationX: 40 }); rig.pan.onFinalize(); });
    expect(action).not.toHaveBeenCalled();
    expect(rig.offset?.value).toBe(0);
  });

  it.each([[-90, 0, 'left'], [90, 0, 'right'], [-8, -1100, 'left']])('commits the correct action once for translation %s and velocity %s', (translationX, velocityX, direction) => {
    const action = vi.fn();
    mount({ onSwipeableWillOpen: action });
    act(() => { rig.pan.onUpdate({ translationX }); rig.pan.onEnd({ translationX, velocityX }); rig.pan.onFinalize(); });
    expect(action).toHaveBeenCalledExactlyOnceWith(direction);
    expect(rig.offset?.value).toBe(0);
  });

  it('clamps unavailable directions and does not commit them', () => {
    const action = vi.fn();
    mount({ renderRightActions: undefined, onSwipeableWillOpen: action });
    act(() => { rig.pan.onUpdate({ translationX: -200 }); rig.pan.onEnd({ translationX: -200, velocityX: -100 }); });
    expect(rig.offset?.value).toBe(0);
    expect(action).not.toHaveBeenCalled();
    act(() => rig.pan.onUpdate({ translationX: 300 }));
    expect(rig.offset?.value).toBe(78);
  });
});
