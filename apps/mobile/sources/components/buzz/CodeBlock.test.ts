import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { copy } = vi.hoisted(() => ({ copy: vi.fn(async () => undefined) }));

vi.mock('expo-clipboard', () => ({ setStringAsync: copy }));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android', select: (obj: any) => obj.android ?? obj.default },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    View: host('View'),
    ScrollView: host('ScrollView'),
    Pressable: host('Pressable'),
  };
});

import { CodeBlock } from './CodeBlock';

const originalConsoleError = console.error;
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

function render(code: string): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(CodeBlock, { code, language: 'typescript' }));
  });
  return renderer;
}

describe('CodeBlock', () => {
  it('keeps short highlighted code selectable in a horizontal scroller', () => {
    const renderer = render('const answer = 42;');
    const codeText = renderer.root.findAllByType('Text').find((node) => node.props.selectable);
    expect(codeText?.props.selectable).toBe(true);
    expect(renderer.root.findAllByType('ScrollView').some((node) => node.props.horizontal)).toBe(true);
  });

  it('copies the complete block even while its preview is bounded', async () => {
    copy.mockClear();
    const code = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n');
    const renderer = render(code);
    const copyButton = renderer.root.findByProps({ accessibilityLabel: 'Copy all code' });
    await act(async () => { await copyButton.props.onPress(); });
    expect(copy).toHaveBeenCalledWith(code);
    expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('Copied');
  });

  it('announces and exposes bounded expansion state', () => {
    const code = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n');
    const renderer = render(code);
    const expand = renderer.root.findByProps({ accessibilityLabel: 'Expand code block, 30 lines' });
    expect(expand.props.accessibilityState).toEqual({ expanded: false });
    act(() => expand.props.onPress());
    const collapse = renderer.root.findByProps({ accessibilityLabel: 'Collapse code block' });
    expect(collapse.props.accessibilityState).toEqual({ expanded: true });
    const vertical = renderer.root.findAllByType('ScrollView').find((node) => !node.props.horizontal);
    expect(vertical?.props.scrollEnabled).toBe(true);
  });
});
