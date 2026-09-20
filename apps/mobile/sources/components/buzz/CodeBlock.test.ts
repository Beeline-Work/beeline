import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { copy } = vi.hoisted(() => ({ copy: vi.fn(async () => undefined) }));

vi.mock('expo-clipboard', () => ({ setStringAsync: copy }));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android', select: (obj: any) => obj.android ?? obj.default },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    View: host('View'),
    ScrollView: host('ScrollView'),
    Pressable: host('Pressable'),
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});
vi.mock('./HullActionSheet', () => ({
  HULL_SHEET_INSET: 22,
  HullActionSheetModal: (props: any) =>
    React.createElement('HullActionSheetModal', props, props.children),
  HullActionSheetRow: (props: any) => React.createElement('HullActionSheetRow', props),
}));

import {
  CodeBlock,
  fenceByteLength,
  fenceInscription,
  hiddenLineLabel,
  isLongFence,
  PEEK_LINE_COUNT,
} from './CodeBlock';

const originalConsoleError = console.error;
beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

function collectHostText(node: { props?: { children?: unknown } }): string {
  const walk = (value: unknown): string => {
    if (value === null || value === undefined || typeof value === 'boolean') return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(walk).join('');
    if (typeof value === 'object' && value && 'props' in value) {
      return walk((value as { props: { children?: unknown } }).props.children);
    }
    return '';
  };
  return walk(node.props?.children);
}

function render(code: string, language: string | null = 'typescript'): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(CodeBlock, { code, language }));
  });
  return renderer;
}

const FRAME_JSON = `{
  "providers": {
    "milo": {
      "name": "Milo",
      "baseUrl": "https://milo-gateway.fly.dev/v1",
      "api": "openai-completions",
      "apiKey": "sk-or-...",
      "models": [
        { "id": "milo/auto", "reasoning": true, "context": 200000 }
      ]
    }
  }
}`;

describe('CodeBlock', () => {
  it('renders an unlabeled fence as wrapped, monochrome prose', () => {
    const renderer = render('Fix OTA runtime coverage for both Android and iOS.', null);
    const plainText = renderer.root.findByProps({ testID: 'plain-text-fence' });

    expect(plainText.props.selectable).toBe(true);
    expect(plainText.props.children).toContain('Fix OTA runtime coverage');
    expect(renderer.root.findAllByType('ScrollView').some((node) => node.props.horizontal)).toBe(
      false,
    );
    expect(renderer.root.findAllByType('Text').some((node) => node.props.children === 'TEXT')).toBe(
      false,
    );
    expect(renderer.root.findByProps({ accessibilityLabel: 'Copy all text' })).toBeDefined();
  });

  it.each(['text', 'txt', 'plaintext', 'markdown', 'md'])(
    'treats an explicitly labeled %s fence as wrapped prose',
    (language) => {
      const renderer = render('A readable paragraph with no syntax coloring.', language);
      expect(renderer.root.findByProps({ testID: 'plain-text-fence' })).toBeDefined();
      expect(renderer.root.findAllByType('ScrollView').some((node) => node.props.horizontal)).toBe(
        false,
      );
    },
  );

  it('keeps a short highlighted fence selectable and wrapping, with no chrome', () => {
    const renderer = render('const answer = 42;');
    const codeText = renderer.root.findAllByType('Text').find((node) => node.props.selectable);
    expect(codeText?.props.selectable).toBe(true);
    expect(renderer.root.findAllByType('ScrollView').some((node) => node.props.horizontal)).toBe(
      false,
    );
    expect(renderer.root.findAllByProps({ testID: 'code-inscription' })).toHaveLength(0);
    expect(renderer.root.findByProps({ accessibilityLabel: 'Copy all code' })).toBeDefined();
  });

  it('copies the complete block even while its peek is bounded', async () => {
    copy.mockClear();
    const renderer = render(FRAME_JSON, 'json');
    const copyButton = renderer.root.findByProps({ accessibilityLabel: 'Copy all code' });
    await act(async () => {
      await copyButton.props.onPress();
    });
    expect(copy).toHaveBeenCalledWith(FRAME_JSON);
    expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe(
      'Copied',
    );
  });

  it('inscribes a long fence and labels what the peek hides', () => {
    const renderer = render(FRAME_JSON, 'json');
    expect(renderer.root.findByProps({ testID: 'code-inscription' }).props.children).toBe(
      fenceInscription('json', FRAME_JSON),
    );
    expect(renderer.root.findByProps({ testID: 'code-inscription' }).props.children).toContain(
      'json · 13 lines ·',
    );
    expect(
      renderer.root
        .findAllByType('Text')
        .some((node) => node.props.children === hiddenLineLabel(13)),
    ).toBe(true);
    const highlighters = renderer.root.findAllByProps({ testID: 'code-highlighter' });
    const peekText = collectHostText(highlighters[0]!);
    expect(peekText).toContain('providers');
    expect(peekText).not.toContain('apiKey');
    expect(peekText).toBe(FRAME_JSON.split('\n').slice(0, PEEK_LINE_COUNT).join('\n'));
  });

  it('opens the existing output sheet full-width with wrapping', () => {
    const renderer = render(FRAME_JSON, 'json');
    const open = renderer.root.findByProps({
      accessibilityLabel: `Open json, ${hiddenLineLabel(13)}`,
    });
    expect(open.props.accessibilityState).toEqual({ expanded: false });
    expect(renderer.root.findByType('HullActionSheetModal' as any).props.visible).toBe(false);
    act(() => open.props.onPress());
    const sheet = renderer.root.findByType('HullActionSheetModal' as any);
    expect(sheet.props.visible).toBe(true);
    expect(sheet.props.title).toBe('json');
    expect(sheet.props.subtitle).toBe(fenceInscription('json', FRAME_JSON));
    expect(open.props.accessibilityState).toEqual({ expanded: true });
    expect(renderer.root.findAllByType('ScrollView').some((node) => node.props.horizontal)).toBe(
      false,
    );
    const highlighters = renderer.root.findAllByProps({ testID: 'code-highlighter' });
    const texts = highlighters.map((node) => collectHostText(node));
    expect(texts.some((text) => text.includes('apiKey') && text.includes('200000'))).toBe(true);
    expect(texts).toContain(FRAME_JSON);
    expect(JSON.parse(texts.find((text) => text === FRAME_JSON)!)).toEqual(JSON.parse(FRAME_JSON));
  });

  it('pins the length rule: more than a peek is long', () => {
    expect(PEEK_LINE_COUNT).toBe(4);
    expect(isLongFence('a\nb\nc\nd')).toBe(false);
    expect(isLongFence('a\nb\nc\nd\ne')).toBe(true);
    expect(hiddenLineLabel(13)).toBe('9 more lines');
    expect(hiddenLineLabel(5)).toBe('1 more line');
    expect(fenceByteLength(FRAME_JSON)).toBe(new TextEncoder().encode(FRAME_JSON).length);
  });
});
