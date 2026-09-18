import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Synchronous mock for react-native.
const platformSetter = vi.hoisted(() => {
  let _os = 'android';
  return {
    setOS: (v: string) => {
      _os = v;
    },
    getOS: () => _os,
  };
});
vi.mock('react-native', () => {
  function host(name: string) {
    return (props: any) => React.createElement(name, props, props.children);
  }
  return {
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    Pressable: host('Pressable'),
    View: host('View'),
    Linking: { openSettings: vi.fn() },
    Platform: {
      get OS() {
        return platformSetter.getOS();
      },
      select: (choices: any) => choices.default,
    },
    StyleSheet: { create: (styles: any) => styles },
  } as any;
});

vi.mock('react-native-svg', () => {
  function host(name: string) {
    return (props: any) => React.createElement(name, props, props.children);
  }
  const Svg = host('RNSVG');
  return { default: Svg, Svg, Line: host('RNSVGLine') };
});

// Mock the speech adapter.
const mockMod = {
  start: vi.fn(),
  stop: vi.fn(),
  abort: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  addListener: vi.fn((_event: string, _handler: (...args: any[]) => void) => ({
    remove: vi.fn(),
  })),
};
vi.mock('@/buzz/speech-recognition-adapter', () => ({
  getRecognitionModule: () => mockMod,
}));

vi.mock('@/buzz/groknight', () => ({
  groknight: {
    type: { body: { lineHeight: 20 }, machine: {} },
    buzz: {
      dim: '#83838d',
      accent: '#b08a4a',
      dialogDanger: '#c4544d',
      ledgerQuiet: '#83838d',
      textSecondary: '#c9c9d1',
      textMuted: '#83838d',
      textPrimary: '#f0f0f3',
      bgRaised: '#190e21',
      border: '#291e33',
      radius: 3,
      bgBase: '#14091A',
      type: {
        body: {
          fontFamily: 'SpaceGrotesk-Regular',
          fontSize: 16,
          lineHeight: 23,
          letterSpacing: 0,
        },
        machine: {
          fontFamily: 'IBMPlexMono-Regular',
          fontSize: 13,
          lineHeight: 19,
          letterSpacing: 0,
        },
        meta: {
          fontFamily: 'SpaceGrotesk-Regular',
          fontSize: 13,
          lineHeight: 19,
          letterSpacing: 0,
        },
      },
      transcriptCard: { rowTitleSize: 15, rowKindSize: 12 },
    },
  },
}));

vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Medium: 'medium' },
}));

import {
  COMPOSER_MAX_INPUT_HEIGHT,
  COMPOSER_SINGLE_LINE_INPUT_HEIGHT,
  ConversationComposer,
} from './ConversationComposer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Shared handler map used by the mock's addListener.
const handlerMap = new Map<string, (...args: any[]) => void>();

function fireEvent(eventName: string, data?: any) {
  const handler = handlerMap.get(eventName);
  if (handler) handler(data);
}

const renderers: any[] = [];

function render(props: Record<string, any> = {}) {
  const onSend = vi.fn();
  const onChangeText = vi.fn();
  let renderer: any;
  act(() => {
    renderer = create(
      <ConversationComposer
        value=""
        height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT}
        maxHeight={COMPOSER_MAX_INPUT_HEIGHT}
        focused={false}
        disabled={false}
        onAttach={vi.fn()}
        onBlur={vi.fn()}
        onChangeText={onChangeText}
        onContentSizeChange={vi.fn()}
        onFocus={vi.fn()}
        onKeyPress={vi.fn()}
        onSend={onSend}
        {...props}
      />,
    );
  });
  renderers.push(renderer);
  return { renderer, onSend, onChangeText };
}

beforeEach(() => {
  vi.clearAllMocks();
  handlerMap.clear();
  platformSetter.setOS('android');
  mockMod.getPermissionsAsync.mockResolvedValue({
    status: 'granted',
    granted: true,
    canAskAgain: true,
  });
  mockMod.requestPermissionsAsync.mockResolvedValue({
    status: 'granted',
    granted: true,
    canAskAgain: true,
  });
  mockMod.addListener.mockImplementation((event: string, handler: (...args: any[]) => void) => {
    handlerMap.set(event, handler);
    return { remove: vi.fn(() => handlerMap.delete(event)) };
  });
});

afterEach(() => {
  act(() => renderers.splice(0).forEach((r) => r.unmount()));
});

describe('mic button visibility', () => {
  it('does not render the mic button on web/desktop', () => {
    platformSetter.setOS('web');
    const { renderer } = render();
    expect(renderer.root.findAllByProps({ testID: 'chat-mic' })).toHaveLength(0);
  });

  it('renders the mic button on Android', () => {
    const { renderer } = render();
    const mic = renderer.root.findByProps({ testID: 'chat-mic' });
    expect(mic.props.accessibilityLabel).toBe('Start speech input');
  });

  it('renders the mic button on iOS', () => {
    platformSetter.setOS('ios');
    const { renderer } = render();
    const mic = renderer.root.findByProps({ testID: 'chat-mic' });
    expect(mic.props.accessibilityLabel).toBe('Start speech input');
  });
});

describe('listening flow', () => {
  it('tapping mic calls start and shows listening state', async () => {
    const { renderer } = render();
    const micBtn = renderer.root.findByProps({ testID: 'chat-mic' });

    await act(async () => micBtn.props.onPress());

    // Allow microtask for state update
    await act(async () => {});

    expect(mockMod.getPermissionsAsync).toHaveBeenCalledOnce();
    expect(mockMod.start).toHaveBeenCalledOnce();

    // Check placeholder
    expect(renderer.root.findByProps({ testID: 'chat-input' }).props.placeholder).toBe('Listening');
    const status = renderer.root.findByProps({ testID: 'chat-speech-status' }).findByType('Text');
    expect(String(status.props.children)).toBe('listening \u00b7 tap mic to stop');
  });

  it('shows interim transcript once, inside the input in provisional styling', async () => {
    const { renderer } = render();
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});

    await act(async () => {
      fireEvent('result', {
        results: [{ transcript: 'hello world', confidence: 0.9, segments: [] }],
        isFinal: false,
      });
    });

    const interim = renderer.root.findByProps({ testID: 'chat-speech-interim' });
    const statusLine = renderer.root.findByProps({ testID: 'chat-speech-status' });
    const flattened: any[] = [];
    const collect = (node: any) => {
      if (node == null || typeof node === 'boolean') return;
      if (Array.isArray(node)) {
        node.forEach(collect);
        return;
      }
      if (typeof node === 'object') {
        if (typeof node.props?.children !== 'undefined') collect(node.props.children);
        return;
      }
      flattened.push(String(node));
    };
    collect(interim.props.children);
    expect(flattened.join('')).toBe('hello world');
    const interimParts = interim.findAllByType('Text');
    const [committedPart, partialPart] = interimParts.slice(-2);
    expect(committedPart.props.style).not.toEqual(expect.objectContaining({ fontStyle: 'italic' }));
    expect(partialPart.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ fontStyle: 'italic' })]),
    );
    flattened.length = 0;
    collect(statusLine.props.children);
    expect(flattened.join('')).not.toContain('hello world');
  });

  it('does not truncate a long interim transcript to one line', async () => {
    const { renderer } = render();
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});
    await act(async () => {
      fireEvent('result', {
        results: [{ transcript: 'a long provisional phrase that needs to wrap onto another line' }],
        isFinal: false,
      });
    });
    const interimText = renderer.root.findByProps({
      importantForAccessibility: 'no-hide-descendants',
    });
    expect(interimText.props.numberOfLines).toBeUndefined();
  });

  it('preserves special characters in final speech without escaping or decoding them', async () => {
    const onChangeText = vi.fn();
    const { renderer } = render({ value: '', onChangeText });
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});
    await act(async () => {
      fireEvent('result', {
        results: [{ transcript: `<main> & \"quotes\" aren't %3F` }],
        isFinal: true,
      });
    });
    expect(onChangeText).toHaveBeenCalledWith(`<main> & \"quotes\" aren't %3F`);
  });

  it('announces listening state and the provisional transcript accessibly', async () => {
    const { renderer } = render();
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});
    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'accessible words' }], isFinal: false });
    });
    const mic = renderer.root.findByProps({ testID: 'chat-mic' });
    expect(mic.props.accessibilityState).toEqual({ selected: true });
    expect(mic.props.accessibilityValue).toEqual({ text: 'Listening: accessible words' });
    const status = renderer.root.findByProps({ testID: 'chat-speech-status' });
    expect(status.props.accessibilityLiveRegion).toBe('polite');
    expect(status.props.accessibilityRole).toBe('text');
  });

  it('pulses the mic treatment in response to native volume', async () => {
    const { renderer } = render();
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});
    const before = renderer.root.findAllByType('RNSVGLine').map((line: any) => line.props.y1);
    await act(async () => fireEvent('volumechange', { value: 10 }));
    const after = renderer.root.findAllByType('RNSVGLine').map((line: any) => line.props.y1);
    expect(after).not.toEqual(before);
    const micStyle = renderer.root.findByProps({ testID: 'chat-mic' }).props.style;
    expect(micStyle).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ transform: [{ scale: 1.12 }], opacity: 1 }),
      ]),
    );
  });

  it('commits final result to onChangeText', async () => {
    const onChangeText = vi.fn();
    const { renderer } = render({ value: '', onChangeText });

    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});

    // Simulate final result
    await act(async () => {
      fireEvent('result', {
        results: [{ transcript: 'hello there', confidence: 0.95, segments: [] }],
        isFinal: true,
      });
    });

    expect(onChangeText).toHaveBeenCalledWith('hello there');

    // While the dictation is still live, a later final result appends to the
    // committed text (the parent echoes the committed value back in).
    const { root } = { root: renderer.root };
    act(() => {
      renderer.update(
        <ConversationComposer
          value="hello there"
          height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT}
          maxHeight={COMPOSER_MAX_INPUT_HEIGHT}
          focused={false}
          disabled={false}
          onAttach={vi.fn()}
          onBlur={vi.fn()}
          onChangeText={onChangeText}
          onContentSizeChange={vi.fn()}
          onFocus={vi.fn()}
          onKeyPress={vi.fn()}
          onSend={vi.fn()}
        />,
      );
    });
    await act(async () => {
      fireEvent('result', {
        results: [{ transcript: 'friend', confidence: 0.95, segments: [] }],
        isFinal: true,
      });
    });
    expect(onChangeText).toHaveBeenCalledWith('hello there friend');
    expect(root).toBeTruthy();
  });

  it('replaces interim text with the final transcript without rendering both', async () => {
    let renderer: any;
    function ControlledComposer() {
      const [value, setValue] = React.useState('');
      return (
        <ConversationComposer
          value={value}
          height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT}
          maxHeight={COMPOSER_MAX_INPUT_HEIGHT}
          focused={false}
          disabled={false}
          onAttach={vi.fn()}
          onBlur={vi.fn()}
          onChangeText={setValue}
          onContentSizeChange={vi.fn()}
          onFocus={vi.fn()}
          onKeyPress={vi.fn()}
          onSend={vi.fn()}
        />
      );
    }
    act(() => {
      renderer = create(<ControlledComposer />);
    });
    renderers.push(renderer);

    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'hello world' }], isFinal: false });
    });
    const interimOverlays = () =>
      renderer.root
        .findAllByType('View')
        .filter((node: any) => node.props.testID === 'chat-speech-interim');
    expect(interimOverlays()).toHaveLength(1);

    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'hello world' }], isFinal: true });
    });
    expect(renderer.root.findByProps({ testID: 'chat-input' }).props.value).toBe('hello world');
    expect(interimOverlays()).toHaveLength(0);
  });

  it('auto-stops after silence timeout', async () => {
    vi.useFakeTimers();
    const onChangeText = vi.fn();
    const { renderer } = render({ value: '', onChangeText });

    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});

    await act(async () => {
      fireEvent('result', {
        results: [{ transcript: 'final words', confidence: 0.9, segments: [] }],
        isFinal: true,
      });
    });

    await act(async () => vi.advanceTimersByTime(2100));

    expect(onChangeText).toHaveBeenCalledWith('final words');
    vi.useRealTimers();
  });

  it('restarts on end event', async () => {
    const { renderer } = render();
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});
    mockMod.start.mockClear();

    await act(async () => fireEvent('end', null));

    expect(mockMod.start).toHaveBeenCalled();
  });
});

describe('edge states', () => {
  it('shows permission-denied status and dims mic', async () => {
    mockMod.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
    mockMod.requestPermissionsAsync.mockResolvedValue({
      status: 'denied',
      granted: false,
      canAskAgain: false,
    });

    const { renderer } = render();
    const micBtn = renderer.root.findByProps({ testID: 'chat-mic' });

    await act(async () => micBtn.props.onPress());
    await act(async () => {});

    const statusLine = renderer.root.findByProps({ testID: 'chat-speech-status' });
    const statusText = statusLine.findByType('Text');
    expect(String(statusText.props.children)).toContain('microphone off in settings');

    expect(micBtn.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ opacity: 0.4 })]),
    );
  });

  it('does not show a capture error when the user stops before speaking', async () => {
    const { renderer } = render();
    const micBtn = renderer.root.findByProps({ testID: 'chat-mic' });

    await act(async () => micBtn.props.onPress());
    await act(async () => {});

    // Stop without any final result
    await act(async () => micBtn.props.onPress());
    await act(async () => {});

    expect(renderer.root.findAllByProps({ testID: 'chat-speech-status' })).toHaveLength(0);
  });
});

describe('send and mic state', () => {
  it('keeps the trailing control the mic while listening; send is not rendered', async () => {
    const { renderer } = render({ value: '' });
    expect(renderer.root.findByProps({ testID: 'chat-mic' })).toBeTruthy();

    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});

    expect(renderer.root.findAllByProps({ testID: 'chat-send' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'chat-mic' })).toBeTruthy();
  });

  it('text input remains editable', async () => {
    const onChangeText = vi.fn();
    const { renderer } = render({ onChangeText });

    await act(async () => {
      renderer.root.findByProps({ testID: 'chat-input' }).props.onChangeText('typed text');
    });
    expect(onChangeText).toHaveBeenCalledWith('typed text');
  });

  it('placeholder reverts after listening ends', async () => {
    const { renderer } = render({ value: '' });
    const micBtn = renderer.root.findByProps({ testID: 'chat-mic' });

    await act(async () => micBtn.props.onPress());
    await act(async () => {});
    expect(renderer.root.findByProps({ testID: 'chat-input' }).props.placeholder).toBe('Listening');

    // Stop listening
    await act(async () => micBtn.props.onPress());
    await act(async () => {});
    expect(renderer.root.findByProps({ testID: 'chat-input' }).props.placeholder).toBe('Message');
  });
});
