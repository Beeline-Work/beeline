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
  it('opens the four-choice picker and saves the selected level', async () => {
    const onSave = vi.fn(async () => undefined);
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<PushLevelSetting onSave={onSave} value="mine" />);
    });
    const row = renderer.root.findByProps({ testID: 'push-notifications-setting' });
    expect(row.props.title).toBe('Notifications');
    expect(row.props.value).toBe('My corners');

    act(() => row.props.onPress());
    expect(renderer.root.findByProps({ testID: 'push-notifications-sheet' }).props.visible).toBe(
      true,
    );
    expect(
      ['off', 'direct', 'mine', 'all'].map(
        (level) => renderer.root.findByProps({ testID: `push-level-${level}` }).props.label,
      ),
    ).toEqual([
      'Off',
      'Direct messages and mentions',
      'Direct messages, mentions, and my corners',
      'Everything',
    ]);

    await act(async () =>
      renderer.root.findByProps({ testID: 'push-level-direct' }).props.onPress(),
    );
    expect(onSave).toHaveBeenCalledWith('direct');
  });
});
