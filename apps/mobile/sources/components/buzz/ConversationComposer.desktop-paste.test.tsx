// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-dom/client has no declarations in this workspace.
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  // @ts-expect-error react-native-web has no declarations in this workspace.
  const rnw = await import('react-native-web');
  return {
    Text: rnw.Text,
    TextInput: rnw.TextInput,
    TouchableOpacity: rnw.TouchableOpacity,
    Pressable: rnw.Pressable,
    View: rnw.View,
    Platform: rnw.Platform,
  };
});
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Medium: 'medium' },
}));

import { COMPOSER_SINGLE_LINE_INPUT_HEIGHT, ConversationComposer } from './ConversationComposer';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('desktop Ctrl+V paste reaches the composer as a real browser event', () => {
  it('drops onPaste passed through containerProps: react-native-web filters it before it reaches the DOM', async () => {
    // Regression guard for the bug this file fixes: react-native-web's View
    // only forwards a fixed allowlist of DOM props (clicks, pointers, keys,
    // focus) to its underlying element, so `onPaste` spread via
    // `containerProps` is silently dropped and a real Ctrl+V never arrives.
    const onPaste = vi.fn();
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ConversationComposer
          value=""
          height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT}
          focused={false}
          disabled={false}
          containerProps={{ onPaste } as Record<string, unknown>}
          onBlur={() => {}}
          onChangeText={() => {}}
          onContentSizeChange={() => {}}
          onFocus={() => {}}
          onKeyPress={() => {}}
          onSend={() => {}}
        />,
      );
    });
    const frame = container.firstElementChild as HTMLElement;
    act(() => {
      frame.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
    });
    expect(onPaste).not.toHaveBeenCalled();
  });

  it('fires onDesktopPaste, wired via a direct DOM addEventListener, when the browser dispatches a real paste event', async () => {
    const onDesktopPaste = vi.fn();
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ConversationComposer
          value=""
          height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT}
          focused={false}
          disabled={false}
          onDesktopPaste={onDesktopPaste}
          onBlur={() => {}}
          onChangeText={() => {}}
          onContentSizeChange={() => {}}
          onFocus={() => {}}
          onKeyPress={() => {}}
          onSend={() => {}}
        />,
      );
    });
    const frame = container.firstElementChild as HTMLElement;
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    act(() => {
      frame.dispatchEvent(pasteEvent);
    });
    expect(onDesktopPaste).toHaveBeenCalledTimes(1);
    expect(onDesktopPaste).toHaveBeenCalledWith(pasteEvent);
  });

  it('removes its paste listener on unmount', async () => {
    const onDesktopPaste = vi.fn();
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ConversationComposer
          value=""
          height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT}
          focused={false}
          disabled={false}
          onDesktopPaste={onDesktopPaste}
          onBlur={() => {}}
          onChangeText={() => {}}
          onContentSizeChange={() => {}}
          onFocus={() => {}}
          onKeyPress={() => {}}
          onSend={() => {}}
        />,
      );
    });
    const frame = container.firstElementChild as HTMLElement;
    act(() => root.unmount());
    act(() => {
      frame.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
    });
    expect(onDesktopPaste).not.toHaveBeenCalled();
  });
});
