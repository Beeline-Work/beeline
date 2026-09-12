import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const viewport = vi.hoisted(() => ({ width: 390, height: 844 }));

vi.mock('react-native', () => ({
  Dimensions: { get: () => viewport },
  Platform: { OS: 'web', isPad: false },
  useWindowDimensions: () => viewport,
}));
vi.mock('./platform', () => ({
  isDesktopPlatform: () => true,
  isRunningOnMac: () => false,
}));

import { useIsDesktop } from './responsive';

let observed = false;
function Probe() {
  observed = useIsDesktop();
  return null;
}

describe('web responsive layout', () => {
  let renderer: ReactTestRenderer;
  const originalError = console.error;

  beforeAll(() => {
    console.error = (...args: unknown[]) => {
      const message = String(args[0] ?? '');
      if (message.startsWith('react-test-renderer is deprecated') || message.includes('act(')) return;
      originalError(...args);
    };
  });

  afterAll(() => {
    console.error = originalError;
  });

  it('treats compact web as phone and switches to desktop live at 768px', () => {
    viewport.width = 390;
    act(() => {
      renderer = create(<Probe />);
    });
    expect(observed).toBe(false);

    viewport.width = 767;
    act(() => renderer.update(<Probe />));
    expect(observed).toBe(false);

    viewport.width = 768;
    act(() => renderer.update(<Probe />));
    expect(observed).toBe(true);

    viewport.width = 1440;
    act(() => renderer.update(<Probe />));
    expect(observed).toBe(true);
  });
});
