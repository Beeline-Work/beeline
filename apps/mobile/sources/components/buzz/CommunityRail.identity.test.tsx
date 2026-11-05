import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { Pressable: host('Pressable'), ScrollView: host('ScrollView'), Text: host('Text'), TouchableOpacity: host('TouchableOpacity'), View: host('View') };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('./MonoHull', () => ({ PixelLoader: () => null, HullSurface: (props: any) => React.createElement('View', props, props.children) }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('./IdentityMark', () => ({ IdentityMark: (props: any) => React.createElement('IdentityMark', props) }));
import { CommunitySwitcherTrigger } from './CommunityRail';
describe('Unavailable workspace identity', () => {
  it('keeps the loaded workspace identity without adding a control while Rooms cannot load', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(CommunitySwitcherTrigger, {
        community: { communityId: 'sample', name: 'Sample' }, expanded: false,
      }));
    });
    expect(renderer.root.findAll((node: any) => node.props.testID === 'workspace-avatar-trigger')).toHaveLength(0);
    expect(renderer.root.findAll((node: any) => node.type === 'View' && node.props.testID === 'workspace-header-plate')).toHaveLength(1);
    expect(renderer.root.findAll((node: any) => node.type === 'Text' && node.props.testID === 'workspace-active-sample')[0].props.children).toBe('Sample');
    expect(renderer.root.findAll((node: any) => typeof node.props.onPress === 'function')).toHaveLength(0);
    act(() => renderer.unmount());
  });

});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
