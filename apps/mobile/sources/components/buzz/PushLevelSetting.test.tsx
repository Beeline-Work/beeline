import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./SettingsRow', () => ({
  SettingsRow: (props: Record<string, unknown>) => React.createElement('SettingsRow', props),
}));
vi.mock('./HullActionSheet', () => ({
  HullActionSheetModal: (props: Record<string, unknown>) => React.createElement('Sheet', props),
  HullActionSheetRow: (props: Record<string, unknown>) => React.createElement('Choice', props),
  HullActionSheetCancel: (props: Record<string, unknown>) => React.createElement('Cancel', props),
}));
vi.mock('react-native', () => ({
  Text: (props: Record<string, unknown>) => React.createElement('Text', props),
  View: (props: Record<string, unknown>) => React.createElement('View', props),
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: { hairlineWidth: 1, create: (value: unknown) => value },
}));

import { PushLevelSetting } from './PushLevelSetting';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('PushLevelSetting', () => {
  it('shows Attention as the selected default in the summary and picker', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<PushLevelSetting onSave={async () => undefined} value="attention" />);
    });
    const row = renderer.root.findByProps({ testID: 'push-notifications-setting' });
    expect(row.props.value).toBe('Attention (default)');
    act(() => row.props.onPress());
    expect(renderer.root.findByProps({ testID: 'push-level-attention' }).props.selected).toBe(true);
    expect(renderer.root.findByProps({ testID: 'push-level-full' }).props.selected).toBe(false);
  });

  it('opens the sensitivity picker and saves the selected level', async () => {
    const onSave = vi.fn(async () => undefined);
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<PushLevelSetting onSave={onSave} value="full" />);
    });
    const row = renderer.root.findByProps({ testID: 'push-notifications-setting' });
    expect(row.props.title).toBe('Notifications');
    expect(row.props.value).toBe('Full');

    act(() => row.props.onPress());
    expect(renderer.root.findByProps({ testID: 'push-notifications-sheet' }).props.visible).toBe(
      true,
    );
    expect(
      renderer.root
        .findAllByType('Choice')
        .map((choice: { props: { testID: string } }) => choice.props.testID),
    ).toEqual(['push-level-off', 'push-level-attention', 'push-level-full']);
    // The row's label is one line (HullActionSheetRow pins numberOfLines={1}),
    // so the level's name rides the label and the sentence explaining what it
    // delivers rides the wrapping description slot instead of ellipsizing.
    expect(
      ['off', 'attention', 'full'].map((level) => {
        const choice = renderer.root.findByProps({ testID: `push-level-${level}` });
        return [choice.props.label, choice.props.description];
      }),
    ).toEqual([
      ['Off', 'No push notifications.'],
      ['Attention (default)', 'Tags, DMs and replies to you, from people or agents.'],
      [
        'Full',
        'Everything in Attention, plus every human message and every final agent reply in all your Rooms and corners.',
      ],
    ]);

    await act(async () =>
      renderer.root.findByProps({ testID: 'push-level-attention' }).props.onPress(),
    );
    expect(onSave).toHaveBeenCalledWith('attention');
  });
});
