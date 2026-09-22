import React, { useState } from 'react';
// @ts-expect-error react-test-renderer has no types in this workspace
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Linking: { openURL: vi.fn() },
    Modal: host('Modal'),
    Platform: { OS: 'android' },
    Pressable: host('Pressable'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
  };
});
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: 'KeyboardAvoidingView',
}));
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('./MonoHull', () => ({ HullSurface: 'HullSurface' }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { HUMAN_CORNER_TITLE_MAX_LENGTH, NewCornerDialog } from './NewCornerDialog';

function mount(error?: string, apps: React.ComponentProps<typeof NewCornerDialog>['apps'] = []) {
  const submit = vi.fn();
  const close = vi.fn();
  function Harness() {
    const [title, setTitle] = useState('');
    const [selectedAppId, setSelectedAppId] = useState<string>();
    return (
      <NewCornerDialog
        visible
        title={title}
        setTitle={setTitle}
        creating={false}
        error={error}
        onCreate={() => submit(title.trim())}
        onClose={close}
        apps={apps}
        selectedAppId={selectedAppId}
        setSelectedAppId={setSelectedAppId}
      />
    );
  }
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<Harness />);
  });
  const host = (testID: string) => tree.root.findByProps({ testID });
  return { tree, host, submit, close };
}

describe('NewCornerDialog', () => {
  it('requires only a title and submits it', () => {
    const { host, submit } = mount();
    expect(host('create-corner-title').props).toMatchObject({
      accessibilityLabel: 'Corner title',
      maxLength: HUMAN_CORNER_TITLE_MAX_LENGTH,
    });
    expect(host('create-corner-submit').props.disabled).toBe(true);
    act(() => host('create-corner-title').props.onChangeText(' Release notes '));
    expect(host('create-corner-submit').props.disabled).toBe(false);
    act(() => host('create-corner-submit').props.onPress());
    expect(submit).toHaveBeenCalledWith('Release notes');
  });

  it('keeps a server refusal visible in the dialog', () => {
    const { host } = mount('only the creator can close this corner');
    expect(host('create-corner-error').props.accessibilityRole).toBe('alert');
  });

  it('offers zero or one installed app without requiring one', () => {
    const { host } = mount(undefined, [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        manifest: {
          version: 1,
          slug: 'release-board',
          title: 'Release board',
          developer: 'Bee Labs',
          humanUi: { kind: 'broker', capability: 'release-board.ui' },
        },
      },
    ]);
    expect(host('create-corner-app-none').props.accessibilityState.checked).toBe(true);
    act(() => host('create-corner-app-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').props.onPress());
    expect(host('create-corner-app-none').props.accessibilityState.checked).toBe(false);
  });
});
