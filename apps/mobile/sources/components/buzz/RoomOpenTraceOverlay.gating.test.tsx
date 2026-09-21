import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let emitRun: ((run: (run: unknown) => void) => void) | null = null;
const observe = vi.fn((listener: (run: unknown) => void) => {
  emitRun?.(listener);
  return () => undefined;
});
const state = {
  buildEnabled: true,
  toggle: false,
  emit: false,
};

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props, props.children as React.ReactNode);
  return {
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
  };
});

vi.mock('@/buzz/room-open-trace', () => ({
  observeRoomOpenTrace: (listener: (run: unknown) => void) => observe(listener),
  roomOpenElapsed: (run: Array<{ phase: string; ms: number }>) => run,
  roomOpenTraceEnabled: () => state.buildEnabled,
}));
vi.mock('@/sync/storage', () => ({
  useLocalSetting: (name: string) => (name === 'roomOpenTraceOverlay' ? state.toggle : false),
}));

import { RoomOpenTraceOverlay } from './RoomOpenTraceOverlay';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render() {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<RoomOpenTraceOverlay />);
  });
  return renderer;
}

describe('RoomOpenTraceOverlay debug-toggle gating', () => {
  beforeEach(() => {
    observe.mockClear();
    emitRun = null;
  });

  it('paints nothing while the settings toggle is off, even on a tracing build', () => {
    state.buildEnabled = true;
    state.toggle = false;
    const renderer = render();
    expect(renderer.root.findAllByProps({ testID: 'room-open-trace' })).toHaveLength(0);
    expect(observe).not.toHaveBeenCalled();
  });

  it('subscribes and paints only when the toggle is on', () => {
    state.buildEnabled = true;
    state.toggle = true;
    emitRun = (listener) => listener([{ phase: 'nav-dispatch', ms: 0 }]);
    const renderer = render();
    expect(observe).toHaveBeenCalled();
    expect(renderer.root.findByProps({ testID: 'room-open-trace' })).toBeTruthy();
  });

  it('never paints on a build without the trace compiled in, toggle or not', () => {
    state.buildEnabled = false;
    state.toggle = true;
    const renderer = render();
    expect(renderer.root.findAllByProps({ testID: 'room-open-trace' })).toHaveLength(0);
    expect(observe).not.toHaveBeenCalled();
  });
});
