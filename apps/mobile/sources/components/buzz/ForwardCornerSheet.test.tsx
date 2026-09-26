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
vi.mock('./HullActionSheet', async () => {
  const ReactModule = await import('react');
  return {
    HullActionSheetModal: (props: any) =>
      ReactModule.createElement('HullActionSheetModal', props, props.children),
    HullActionSheetRow: (props: any) =>
      ReactModule.createElement('HullActionSheetRow', props),
    HullActionSheetCancel: (props: any) =>
      ReactModule.createElement('HullActionSheetCancel', props),
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

describe('forward-to-new-corner sheet', () => {
  it('asks through the shared bottom sheet, keeping the prompt wording', () => {
    const renderer = render(<ForwardCornerSheet onClose={vi.fn()} onOpen={vi.fn()} visible />);
    const sheet = renderer.root.findByType('HullActionSheetModal').props;
    expect(sheet.testID).toBe('forward-corner-sheet');
    expect(sheet.title).toBe('Forward to a new corner?');
    expect(sheet.subtitle).toBe(
      'A human-owned corner opens with this message ready to send in its composer.',
    );
    expect(sheet.visible).toBe(true);
  });

  it('confirms with one plain row and cancels through the sheet', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const renderer = render(
      <ForwardCornerSheet onClose={onClose} onOpen={onOpen} visible />,
    );
    const row = renderer.root.findByType('HullActionSheetRow').props;
    expect(row.testID).toBe('forward-corner-open');
    expect(row.label).toBe('Open a new corner');
    // A plain action carries no fifth trailing mark.
    expect(row.chevron).toBeUndefined();
    expect(row.toggle).toBeUndefined();
    expect(row.metadata).toBeUndefined();
    act(() => row.onPress());
    expect(onOpen).toHaveBeenCalledOnce();
    act(() => renderer.root.findByType('HullActionSheetCancel').props.onPress());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes the sheet on its own x, scrim or hardware back', () => {
    const onClose = vi.fn();
    const renderer = render(<ForwardCornerSheet onClose={onClose} onOpen={vi.fn()} visible />);
    act(() => renderer.root.findByType('HullActionSheetModal').props.onClose());
    expect(onClose).toHaveBeenCalledOnce();
  });
});