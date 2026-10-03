import React from 'react';
// @ts-expect-error react-test-renderer has no types in this workspace
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: (theme: any) => unknown) =>
      factory({
        buzz: {
          type: { meta: {} },
          textPrimary: '#111',
          borderStrong: '#aaa',
          radius: 3,
          accent: '#876',
        },
      }),
  },
}));
vi.mock('./HullDialog', async () => {
  const ReactModule = await import('react');
  return { HullDialogInput: (props: any) => ReactModule.createElement('TextInput', props) };
});
vi.mock('./HullActionSheet', async () => {
  const ReactModule = await import('react');
  return {
    HULL_SHEET_INSET: 22,
    HullActionSheetModal: (props: any) =>
      ReactModule.createElement('HullActionSheetModal', props, props.children, props.footer),
    HullActionSheetCancel: (props: any) =>
      ReactModule.createElement('HullActionSheetCancel', props),
  };
});
vi.mock('./Button', async () => {
  const ReactModule = await import('react');
  return { Button: (props: any) => ReactModule.createElement('Button', props, props.children) };
});

import { CreatePollSheet } from './CreatePollSheet';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('CreatePollSheet', () => {
  it('keeps Create disabled until the question and both options are valid, then submits the draft', async () => {
    const onCreate = vi.fn();
    let renderer: any;
    act(() => {
      renderer = create(
        <CreatePollSheet visible busy={false} onClose={vi.fn()} onCreate={onCreate} />,
      );
    });
    const find = (testID: string) => renderer.root.findByProps({ testID });
    expect(renderer.root.findByType('HullActionSheetModal').props.title).toBe('Create poll');
    expect(find('create-poll-submit').props.variant).toBe('primary');
    expect(find('create-poll-submit').props.disabled).toBe(true);
    act(() => find('create-poll-question').props.onChangeText(' Ship? '));
    act(() => find('create-poll-option-0').props.onChangeText(' Yes '));
    expect(find('create-poll-submit').props.disabled).toBe(true);
    act(() => find('create-poll-option-1').props.onChangeText(' No '));
    expect(find('create-poll-submit').props.disabled).toBe(false);
    await act(async () => {
      await find('create-poll-submit').props.onPress();
    });
    expect(onCreate).toHaveBeenCalledWith({
      prompt: 'Ship?',
      options: [
        { label: 'Yes', consequence: 'Yes' },
        { label: 'No', consequence: 'No' },
      ],
      ttlSeconds: 3600,
    });
  });
});
