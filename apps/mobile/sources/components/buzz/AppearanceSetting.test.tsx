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

import { AppearanceSetting } from './AppearanceSetting';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('AppearanceSetting', () => {
  it('opens the light/dark picker and reports the chosen appearance', () => {
    const onChange = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<AppearanceSetting onChange={onChange} value="dark" />);
    });
    const row = renderer.root.findByProps({ testID: 'appearance-setting' });
    expect(row.props.title).toBe('Appearance');
    expect(row.props.value).toBe('Dark');

    act(() => row.props.onPress());
    expect(renderer.root.findByProps({ testID: 'appearance-sheet' }).props.visible).toBe(true);
    expect(
      ['dark', 'light'].map(
        (appearance) => renderer.root.findByProps({ testID: `appearance-${appearance}` }).props
          .label,
      ),
    ).toEqual(['Dark', 'Light']);

    act(() => renderer.root.findByProps({ testID: 'appearance-light' }).props.onPress());
    expect(onChange).toHaveBeenCalledWith('light');
    expect(renderer.root.findByProps({ testID: 'appearance-sheet' }).props.visible).toBe(false);
  });

  it('does not call onChange when the current appearance is re-selected', () => {
    const onChange = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<AppearanceSetting onChange={onChange} value="dark" />);
    });
    act(() => renderer.root.findByProps({ testID: 'appearance-setting' }).props.onPress());
    act(() => renderer.root.findByProps({ testID: 'appearance-dark' }).props.onPress());
    expect(onChange).not.toHaveBeenCalled();
  });
});
