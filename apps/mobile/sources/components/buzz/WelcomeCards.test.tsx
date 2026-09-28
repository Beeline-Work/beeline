import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WelcomeCards } from './WelcomeCards';

const complete = vi.fn(async () => ({ due: false }));
vi.mock('@/buzz/welcome-cards', () => ({ completeWelcomeCards: () => complete() }));
vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return {
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('react-native-svg', () => ({ SvgXml: () => null }));
vi.mock('./Ledger', () => ({ LedgerEntry: () => null }));
vi.mock('./IdentityMark', () => ({ IdentityMark: () => null }));
vi.mock('./ChevronGlyph', () => ({ ChevronGlyph: () => null }));
vi.mock('./CornerGlyph', () => ({ CornerGlyph: () => null }));
vi.mock('./HullDialog', () => ({
  HullModal: (props: any) => React.createElement('HullModal', props, props.children),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => complete.mockClear());

describe('first-entry welcome cards', () => {
  it('moves through four cards and completes the account once at Get started', async () => {
    const onDone = vi.fn();
    let renderer: ReturnType<typeof create>;
    act(() => {
      renderer = create(<WelcomeCards visible onDone={onDone} />);
    });
    const button = () => renderer!.root.findByProps({ testID: 'welcome-next' });
    for (let step = 0; step < 3; step += 1) {
      expect(button().props.accessibilityLabel).toBe('Next');
      act(() => button().props.onPress());
      expect(complete).not.toHaveBeenCalled();
    }
    expect(button().props.accessibilityLabel).toBe('Get started');
    await act(async () => {
      await button().props.onPress();
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
