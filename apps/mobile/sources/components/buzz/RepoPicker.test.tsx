import React from 'react';
// @ts-expect-error react-test-renderer has no types in this workspace
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return {
    SectionList: host('SectionList'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
    useWindowDimensions: () => ({ width: 360, height: 500 }),
  };
});
vi.mock('react-native-unistyles', () => {
  const value = new Proxy({}, { get: () => value });
  return {
    StyleSheet: {
      create: (factory: (theme: unknown) => unknown) => factory({ buzz: value }),
      hairlineWidth: 1,
    },
    useUnistyles: () => ({ theme: { buzz: value } }),
  };
});
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('./OwnerGrantNeededCard', () => ({ OwnerGrantNeededCard: 'OwnerGrantNeededCard' }));

import { RepoPicker } from './RepoPicker';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderPicker(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <RepoPicker
        candidates={Array.from({ length: 100 }, (_, index) => ({
          key: `repo-${index}`,
          name: `owner/repo-${index}`,
          remote: `https://github.com/owner/repo-${index}`,
          defaultBranch: 'main',
        }))}
        fillAvailableHeight
        onSelect={() => {}}
      />,
    );
  });
  return renderer;
}

describe('RepoPicker', () => {
  it('renders a scrollable candidate list that shrinks inside the dialog body', () => {
    const renderer = renderPicker();
    const list = renderer.root.findByProps({ testID: 'repo-picker-list' });
    expect(list.props.sections[0].data).toHaveLength(100);
    expect(list.props.style).toContainEqual(
      expect.objectContaining({ flex: 1, flexShrink: 1, minHeight: 0 }),
    );
    expect(list.props.nestedScrollEnabled).toBe(true);
    expect(list.props.keyboardShouldPersistTaps).toBe('handled');
    act(() => renderer.unmount());
  });
});
