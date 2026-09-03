import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { beelineThemes } from '@/buzz/groknight';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('./HullActionSheet', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    HullActionSheetModal: host('HullActionSheetModal'),
    HullActionSheetCancel: host('HullActionSheetCancel'),
  };
});
vi.mock('./IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});

import { FacePickerSheet } from './FacePickerSheet';

const theme = beelineThemes.obsidian;
const SEED = 'a'.repeat(64);

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});
afterAll(() => vi.restoreAllMocks());

function host(tree: ReactTestRenderer, testID: string) {
  const found = tree.root.findAll(
    (node: any) => typeof node.type === 'string' && node.props?.testID === testID,
    { deep: true },
  );
  expect(found, `expected exactly one ${testID}`).toHaveLength(1);
  return found[0];
}
function flat(style: unknown): Record<string, unknown> {
  return (Array.isArray(style) ? style.flat(Number.POSITIVE_INFINITY) : [style]).reduce(
    (all: Record<string, unknown>, part: unknown) =>
      part && typeof part === 'object' ? { ...all, ...(part as object) } : all,
    {},
  );
}

/** A stateful host: the screen behind the sheet, holding the face like Settings does. */
type SaveFace = React.ComponentProps<typeof FacePickerSheet>['onSave'];

function Host({ onSave }: { onSave: SaveFace }) {
  const [face, setFace] = React.useState<string | null>('fox');
  return React.createElement(
    React.Fragment,
    null,
    React.createElement('Text', { testID: 'host-face' }, face),
    React.createElement(FacePickerSheet, {
      visible: true,
      seed: SEED,
      face,
      onFaceChange: setFace,
      onSave,
      onClose: () => undefined,
    }),
  );
}

async function render(onSave: SaveFace) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(React.createElement(Host, { onSave }));
  });
  return tree;
}
async function press(node: any) {
  await act(async () => {
    node.props.onPress?.();
  });
}

describe('FacePickerSheet', () => {
  it('saves a tapped face immediately and keeps the optimistic choice on success', async () => {
    const onSave = vi.fn(async () => undefined);
    const tree = await render(onSave);
    expect(flat(host(tree, 'face-picker-fox').props.style).borderColor).toBe(theme.accent);
    await press(host(tree, 'face-picker-moth'));
    expect(onSave).toHaveBeenCalledWith('moth');
    expect(host(tree, 'host-face').props.children).toBe('moth');
    expect(flat(host(tree, 'face-picker-moth').props.style).borderColor).toBe(theme.accent);
    expect(flat(host(tree, 'face-picker-fox').props.style).borderColor).toBe(theme.faint);
  });

  it('rolls the face back and explains inline when the save is refused', async () => {
    let resolveSave!: (value: void) => void;
    let rejectSave!: (reason: unknown) => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          resolveSave = resolve;
          rejectSave = reject;
        }),
    );
    const tree = await render(onSave);
    act(() => {
      host(tree, 'face-picker-bear').props.onPress();
    });
    // Optimistic: the screen behind already wears the new face while the save is in flight.
    expect(host(tree, 'host-face').props.children).toBe('bear');
    await act(async () => {
      rejectSave(new Error('invalid face id'));
    });
    expect(host(tree, 'host-face').props.children).toBe('fox');
    expect(flat(host(tree, 'face-picker-fox').props.style).borderColor).toBe(theme.accent);
    expect(host(tree, 'face-picker-error').props.children).toContain('invalid face id');
    // Retryable: the next tap saves again and clears the error.
    act(() => {
      host(tree, 'face-picker-bear').props.onPress();
    });
    await act(async () => {
      resolveSave();
    });
    expect(host(tree, 'host-face').props.children).toBe('bear');
    expect(
      tree.root.findAll(
        (node: any) => typeof node.type === 'string' && node.props?.testID === 'face-picker-error',
      ),
    ).toHaveLength(0);
  });
});
