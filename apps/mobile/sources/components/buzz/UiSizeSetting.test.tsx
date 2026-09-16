import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('./SettingsRow', () => ({
  SettingsRow: (props: Record<string, unknown>) => React.createElement('SettingsRow', props),
}));
vi.mock('./HullActionSheet', () => ({
  HullActionSheetModal: (props: Record<string, unknown>) => React.createElement('Sheet', props),
  HullActionSheetRow: (props: Record<string, unknown>) => React.createElement('Choice', props),
  HullActionSheetCancel: (props: Record<string, unknown>) => React.createElement('Cancel', props),
}));

import { UiSizeSetting, uiSizeSettingLabel } from './UiSizeSetting';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('UiSizeSetting', () => {
  it('names proportional desktop scaling and text-only native scaling honestly', () => {
    expect(uiSizeSettingLabel('web')).toBe('Interface size');
    expect(uiSizeSettingLabel('ios')).toBe('Text size');
    expect(uiSizeSettingLabel('android')).toBe('Text size');
  });

  it('presents the three sizes and reports a new selection', () => {
    const onChange = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<UiSizeSetting onChange={onChange} value="medium" />);
    });

    const row = renderer.root.findByProps({ testID: 'ui-size-setting' });
    expect(row.props.title).toBe('Interface size');
    expect(row.props.value).toBe('Medium');
    act(() => row.props.onPress());

    expect(
      ['small', 'medium', 'large'].map(
        (size) => renderer.root.findByProps({ testID: `ui-size-${size}` }).props.label,
      ),
    ).toEqual(['Small', 'Medium', 'Large']);

    act(() => renderer.root.findByProps({ testID: 'ui-size-large' }).props.onPress());
    expect(onChange).toHaveBeenCalledWith('large');
    expect(renderer.root.findByProps({ testID: 'ui-size-sheet' }).props.visible).toBe(false);
  });

  it('does not report the current selection again', () => {
    const onChange = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<UiSizeSetting onChange={onChange} value="small" />);
    });
    act(() => renderer.root.findByProps({ testID: 'ui-size-setting' }).props.onPress());
    act(() => renderer.root.findByProps({ testID: 'ui-size-small' }).props.onPress());
    expect(onChange).not.toHaveBeenCalled();
  });
});
