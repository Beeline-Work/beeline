import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('./HullDialog', async () => {
  const ReactModule = await import('react');
  return {
    HullDialog: (props: any) => ReactModule.createElement('HullDialog', props),
  };
});

import { ForwardCornerSheet } from './ForwardCornerSheet';

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

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

describe('forward-to-new-corner dialog', () => {
  it('asks through the centered dialog, keeping the prompt wording', () => {
    const renderer = render(<ForwardCornerSheet onClose={vi.fn()} onOpen={vi.fn()} visible />);
    const sheet = renderer.root.findByType('HullDialog').props;
    expect(sheet.testID).toBe('forward-corner-sheet');
    expect(sheet.title).toBe('Begin a new corner');
    expect(sheet.body).toBe('Start a new corner with the chosen message as the starting topic.');
    expect(sheet.visible).toBe(true);
  });

  it('confirms or cancels through its two actions', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const renderer = render(<ForwardCornerSheet onClose={onClose} onOpen={onOpen} visible />);
    const row = renderer.root.findByType('HullDialog').props.actions[1];
    expect(row.testID).toBe('forward-corner-open');
    expect(row.label).toBe('Open corner');
    act(() => row.onPress());
    expect(onOpen).toHaveBeenCalledOnce();
    act(() => renderer.root.findByType('HullDialog').props.actions[0].onPress());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on backdrop or hardware back', () => {
    const onClose = vi.fn();
    const renderer = render(<ForwardCornerSheet onClose={onClose} onOpen={vi.fn()} visible />);
    act(() => renderer.root.findByType('HullDialog').props.onRequestClose());
    expect(onClose).toHaveBeenCalledOnce();
  });
});
