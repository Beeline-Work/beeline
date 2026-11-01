import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDeviceSpeechLocale } from '@/buzz/speech-locale';
import { reportClientError } from '@/buzz/client-error-report';

vi.mock('@/buzz/client-error-report', () => ({ reportClientError: vi.fn(async () => {}) }));

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
    ScrollView: host('ScrollView'),
    View: host('View'),
    Linking: { openSettings: vi.fn() },
    Keyboard: { isVisible: () => true, addListener: () => ({ remove() {} }), dismiss() {} },
    Animated: {
      View: host('View'),
      Value: class {
        constructor(readonly value: number) {}
      },
      timing: () => ({ start() {}, stop() {} }),
    },
    Easing: { linear: (t: number) => t },
    Platform: {
      get OS() {
        return platformSetter.getOS();
      },
      select: (choices: any) => choices.default,
    },
    StyleSheet: { create: (styles: any) => styles },
  } as any;
});

vi.mock('./BeelineMarkSpinner', async () => {
  const ReactModule = await import('react');
  return {
    BeelineMarkSpinner: (props: any) => ReactModule.createElement('BeelineMarkSpinner', props),
  };
});

vi.mock('./HullDialog', async () => {
  const ReactModule = await import('react');
  return {
    HullDialog: (props: any) => ReactModule.createElement('HullDialog', props),
  };
});
vi.mock('react-native-svg', () => {
  function host(name: string) {
    return (props: any) => React.createElement(name, props, props.children);
  }
  const Svg = host('RNSVG');
  return {
    default: Svg,
    Svg,
    Line: host('RNSVGLine'),
    Path: host('RNSVGPath'),
    Rect: host('RNSVGRect'),
  };
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

vi.mock('@/buzz/groknight', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/buzz/groknight')>(),
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

import { SPEECH_SILENCE_TIMEOUT_MS } from '@/buzz/speech-input';
import {
  DictationWaveform as DictationWaveformType,
  WAVEFORM_BAR_COUNT,
} from './DictationWaveform';
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

/** The input host, which holds the whole text. */
function inputHost(root: any) {
  return root.findAll(
    (node: any) => node.props.testID === 'chat-input' && typeof node.type === 'string',
  )[0];
}

/** The text the input holds. */
function inputText(root: any): string {
  return inputHost(root).props.value;
}

/** Every string the composer shows, read from `.props.children`. */
function renderedText(renderer: any): string {
  const parts: string[] = [];
  const collect = (node: any) => {
    if (node == null || typeof node === 'boolean') return;
    if (Array.isArray(node)) return node.forEach(collect);
    if (typeof node === 'object') return;
    parts.push(String(node));
  };
  for (const text of renderer.root.findAllByType('Text')) collect(text.props.children);
  return parts.join(' ');
}

function render(props: Record<string, any> = {}) {
  const onSend = vi.fn();
  const onChangeText = vi.fn();
  const nativeInput = { setSelection: vi.fn(), setSelectionRange: vi.fn(), blur: vi.fn() };
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
      { createNodeMock: (element: any) => element.type === 'TextInput' ? nativeInput : null },
    );
  });
  renderers.push(renderer);
  return { renderer, onSend, onChangeText, nativeInput };
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

it.each(['android', 'ios', 'web'])('holds the existing mic on %s to enter voice mode without starting a dictation take on release', (platform) => {
  platformSetter.setOS(platform);
  const join = vi.fn();
  const { renderer } = render({ voice: { call: null, connecting: false, join } });
  const mic = renderer.root.findByProps({ testID: 'chat-mic' });
  act(() => { mic.props.onPressIn(); mic.props.onLongPress(); mic.props.onPress(); });
  expect(join).toHaveBeenCalledTimes(1);
  expect(mockMod.start).not.toHaveBeenCalled();
});

describe('mic button visibility', () => {
  it('renders the mic button on web when recognition is available', () => {
    platformSetter.setOS('web');
    const { renderer } = render();
    expect(renderer.root.findByProps({ testID: 'chat-mic' }).props.accessibilityLabel).toBe('Start speech input');
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
  it('tapping mic starts a take: waveform in the field, Stop in the mic spot, ＋ kept, no status line', async () => {
    const { renderer } = render();
    const micBtn = renderer.root.findByProps({ testID: 'chat-mic' });

    await act(async () => micBtn.props.onPress());

    // Allow microtask for state update
    await act(async () => {});

    expect(mockMod.getPermissionsAsync).toHaveBeenCalledOnce();
    expect(mockMod.start).toHaveBeenCalledOnce();
    expect(renderer.root.findAllByProps({ testID: 'chat-speech-waveform' }).length).toBeGreaterThan(
      0,
    );
    expect(renderer.root.findAllByProps({ testID: 'chat-speech-status' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'chat-attach-button' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ testID: 'chat-mic' })).toHaveLength(0);
    expect(
      renderer.root.findByProps({ testID: 'chat-speech-discard' }).props.accessibilityLabel,
    ).toBe('Stop recording');
  });

  it('primes the recogniser with the conversation names when the mic is tapped', async () => {
    const { renderer } = render({ speechHints: ['Niglet', 'Emberus', 'Formatting voice'] });
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});

    expect(mockMod.start).toHaveBeenCalledWith(
      expect.objectContaining({
        addsPunctuation: true,
        contextualStrings: ['Niglet', 'Emberus', 'Formatting voice'],
      }),
    );
  });

  it('dictates through the Android on-device recognizer, which punctuates, when its model is installed', async () => {
    const withLocales = mockMod as typeof mockMod & { getSupportedLocales?: unknown };
    withLocales.getSupportedLocales = vi
      .fn()
      .mockResolvedValue({ locales: [], installedLocales: [getDeviceSpeechLocale()] });
    try {
      const { renderer } = render();
      await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
      await act(async () => {});

      expect(mockMod.start).toHaveBeenCalledWith(
        expect.objectContaining({ addsPunctuation: true, requiresOnDeviceRecognition: true }),
      );
    } finally {
      delete withLocales.getSupportedLocales;
    }
  });

  it('shows a waveform, never the live words, while dictating', async () => {
    const { renderer } = render();
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    const props = renderer.root.findByType(ConversationComposer).props;
    act(() => renderer.update(<ConversationComposer {...props} value="draft words" />));
    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'recognized words' }], isFinal: false });
    });

    expect(renderedText(renderer)).not.toContain('recognized words');
    const input = renderer.root.findByProps({ testID: 'chat-input' });
    // The typed draft stays in the hidden input and returns after the take.
    expect(inputText(renderer.root)).toBe('draft words');
    expect(input.props.style.flat(Infinity)).toEqual(
      expect.arrayContaining([expect.objectContaining({ opacity: 0 })]),
    );
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

  it('announces the listening state accessibly', async () => {
    const { renderer } = render();
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});
    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'accessible words' }], isFinal: false });
    });
    const stop = renderer.root.findByProps({ testID: 'chat-speech-discard' });
    expect(stop.props.accessibilityLabel).toBe('Stop recording');
    expect(stop.props.accessibilityHint).toBe('Discards this take; typed text stays');
    const send = renderer.root.findByProps({ testID: 'chat-send' });
    expect(send.props.accessibilityLabel).toBe('Send message');
    expect(send.props.accessibilityHint).toBe('Stops dictation and sends');
  });

  it('Reproduction CONVERSATION-3: latest visible level updates before the scrolling history sample', async () => {
    vi.useFakeTimers();
    try {
      const { renderer } = render();
      await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
      await act(async () => {});
      const waveform = () => renderer.root.findAllByProps({ testID: 'chat-speech-waveform' })
        .find((node: any) => node.type === 'View');
      const tip = () => renderer.root.findAllByProps({ testID: 'chat-speech-waveform-live-level' })
        .find((node: any) => node.type === 'View');
      const height = () => tip().props.style.flat(Infinity).find((style: any) => style?.height).height;
      const samples = [height()];
      expect(waveform().props.style.flat(Infinity).some((style: any) => style?.transform)).toBe(true);
      expect(waveform().children).toHaveLength(0);
      for (const value of [2, 4, 7, -2]) {
        await act(async () => fireEvent('volumechange', { value }));
        samples.push(height());
        expect(waveform().children).toHaveLength(0);
      }
      expect(samples[0]).toBe(2);
      expect(samples[1]).toBeGreaterThan(samples[0]);
      expect(samples[2]).toBeGreaterThan(samples[1]);
      expect(samples[3]).toBeGreaterThan(samples[2]);
      expect(samples[4]).toBe(2);
      await act(async () => vi.advanceTimersByTime(120));
      expect(waveform().children.length).toBeGreaterThan(0);
      expect(waveform().children.length).toBeLessThanOrEqual(WAVEFORM_BAR_COUNT);
      console.info('CONVERSATION-3: same-render visible heights before history sampling', samples);
    } finally { vi.useRealTimers(); }
  });

  it('keeps Stop a plain outlined square with no ring or glow while listening', async () => {
    const { renderer } = render();
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});
    await act(async () => fireEvent('volumechange', { value: 10 }));

    const stop = renderer.root.findByProps({ testID: 'chat-speech-discard' });
    const styles = [stop.props.style].flat(Infinity).filter(Boolean);
    expect(styles).toEqual([expect.objectContaining({ width: 26, height: 26 })]);
    expect(renderer.root.findByProps({ testID: 'chat-stop-glyph' }).props.color).toBe('#f0f0f3');
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

  it('commits the final transcript into the field once the take ends', async () => {
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
    expect(inputText(renderer.root)).toBe('');

    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'hello world' }], isFinal: true });
    });
    expect(inputText(renderer.root)).toBe('hello world');
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

    await act(async () => vi.advanceTimersByTime(SPEECH_SILENCE_TIMEOUT_MS + 100));

    expect(onChangeText).toHaveBeenCalledWith('final words');
    expect(renderer.root.findByProps({ testID: 'chat-input' }).props.placeholder).toBe('Message');
    vi.useRealTimers();
  });

  it('does not show did-not-catch after a late partial from a silence stop', async () => {
    vi.useFakeTimers();
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
    await act(async () => vi.advanceTimersByTime(SPEECH_SILENCE_TIMEOUT_MS + 100));
    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'Sally sell' }], isFinal: false });
      fireEvent('end');
    });

    expect(inputText(renderer.root)).toBe('Sally sell');
    expect(renderer.root.findAllByProps({ testID: 'chat-speech-status' })).toHaveLength(0);
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
  it('keeps the microphone settings message after an Android recognizer refusal', async () => {
    const { renderer } = render();
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => fireEvent('error', { error: 'not-allowed', message: 'Recognition refused' }));
    const status = renderer.root.findByProps({ testID: 'chat-speech-status' }).findByType('Text');
    expect(status.props.children).toBe('microphone off in settings · tap to open settings');
    expect(reportClientError).not.toHaveBeenCalled();
  });

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
    await act(async () => renderer.root.findByProps({ testID: 'chat-speech-discard' }).props.onPress());
    await act(async () => fireEvent('end'));

    expect(renderer.root.findAllByProps({ testID: 'chat-speech-status' })).toHaveLength(0);
  });
});

describe('send and mic state', () => {
  it('while listening, Stop replaces the mic and Send stays far right', async () => {
    const { renderer } = render({ value: '' });
    expect(renderer.root.findByProps({ testID: 'chat-mic' })).toBeTruthy();

    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});

    expect(renderer.root.findAllByProps({ testID: 'chat-mic' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'chat-speech-discard' })).toBeTruthy();
    expect(renderer.root.findByProps({ testID: 'chat-send' }).props.disabled).toBe(false);
  });

  it('text input remains editable', async () => {
    const onChangeText = vi.fn();
    const { renderer } = render({ onChangeText });

    await act(async () => {
      renderer.root.findByProps({ testID: 'chat-input' }).props.onChangeText('typed text');
    });
    expect(onChangeText).toHaveBeenCalledWith('typed text');
  });

  it('removes the waveform after listening ends', async () => {
    const { renderer } = render({ value: '' });
    const micBtn = renderer.root.findByProps({ testID: 'chat-mic' });

    await act(async () => micBtn.props.onPress());
    await act(async () => {});
    expect(renderer.root.findAllByProps({ testID: 'chat-speech-waveform' }).length).toBeGreaterThan(
      0,
    );

    // Send ends the take
    await act(async () => renderer.root.findByProps({ testID: 'chat-send' }).props.onPress());
    await act(async () => fireEvent('end'));
    expect(renderer.root.findAllByProps({ testID: 'chat-speech-waveform' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'chat-attach-button' })).toBeTruthy();
  });

  it('waits for a complete final transcript before sending after a Send press', async () => {
    const sentText = vi.fn();
    let renderer: any;
    function ControlledComposer() {
      const [value, setValue] = React.useState('');
      const valueRef = React.useRef('');
      const commit = (next: string) => {
        valueRef.current = next;
        setValue(next);
      };
      return (
        <ConversationComposer
          value={value}
          height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT}
          maxHeight={COMPOSER_MAX_INPUT_HEIGHT}
          focused={false}
          disabled={false}
          onAttach={vi.fn()}
          onBlur={vi.fn()}
          onChangeText={commit}
          onContentSizeChange={vi.fn()}
          onFocus={vi.fn()}
          onKeyPress={vi.fn()}
          onSend={() => {
            sentText(valueRef.current);
            commit('');
          }}
        />
      );
    }
    act(() => {
      renderer = create(<ControlledComposer />);
    });
    renderers.push(renderer);

    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'Sally sell' }], isFinal: false });
    });
    await act(async () => renderer.root.findByProps({ testID: 'chat-send' }).props.onPress());
    expect(sentText).not.toHaveBeenCalled();
    // The Beeline mark fills the Send slot and the waveform freezes while
    // the take is transcribed; there is no status line.
    expect(
      renderer.root.findAllByProps({ testID: 'chat-speech-finalizing' }).length,
    ).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ testID: 'chat-send-glyph' })).toHaveLength(0);
    expect(
      renderer.root.findAllByType(DictationWaveformType).map((node: any) => node.props.live),
    ).toEqual([false]);
    expect(renderer.root.findAllByProps({ testID: 'chat-speech-status' })).toHaveLength(0);

    await act(async () => {
      fireEvent('result', {
        results: [{ transcript: 'Sally sells seashells by the seashore' }],
        isFinal: true,
      });
    });

    expect(sentText).toHaveBeenCalledOnce();
    expect(sentText).toHaveBeenCalledWith('Sally sells seashells by the seashore');
    expect(inputText(renderer.root)).toBe('');
    expect(renderer.root.findAllByProps({ testID: 'chat-speech-finalizing' })).toHaveLength(0);
  });

  it('one Send press after a committed final sends that text and clears', async () => {
    const onSend = vi.fn();
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
          onSend={() => {
            onSend();
            setValue('');
          }}
        />
      );
    }
    act(() => {
      renderer = create(<ControlledComposer />);
    });
    renderers.push(renderer);

    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'already final' }], isFinal: true });
    });
    expect(inputText(renderer.root)).toBe('already final');
    await act(async () => renderer.root.findByProps({ testID: 'chat-send' }).props.onPress());
    await act(async () => fireEvent('end'));

    expect(onSend).toHaveBeenCalledOnce();
    expect(inputText(renderer.root)).toBe('');
  });

  it('an empty Send press only stops and does not send', async () => {
    const { renderer, onSend } = render({ value: '' });
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});
    await act(async () => renderer.root.findByProps({ testID: 'chat-send' }).props.onPress());
    await act(async () => fireEvent('end'));
    expect(onSend).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ testID: 'chat-speech-waveform' })).toHaveLength(0);
  });
});

describe('stop button', () => {
  it('discards a take while recording: nothing committed or sent, typed text kept', async () => {
    const { renderer, onSend, onChangeText } = render({ value: '' });
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    const props = renderer.root.findByType(ConversationComposer).props;
    act(() => renderer.update(<ConversationComposer {...props} value="typed " />));
    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'throw this away' }], isFinal: false });
    });
    await act(async () =>
      renderer.root.findByProps({ testID: 'chat-speech-discard' }).props.onPress(),
    );
    await act(async () => fireEvent('end'));

    expect(mockMod.abort).toHaveBeenCalled();
    expect(onChangeText).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ testID: 'chat-speech-waveform' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'chat-attach-button' })).toBeTruthy();
    expect(inputText(renderer.root)).toBe('typed ');
  });

  it('discards a take while it is being transcribed, so the Send press sends nothing', async () => {
    vi.useFakeTimers();
    try {
      const { renderer, onSend, onChangeText } = render({ value: '' });
      await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
      await act(async () => {
        fireEvent('result', { results: [{ transcript: 'never sent' }], isFinal: false });
      });
      await act(async () => renderer.root.findByProps({ testID: 'chat-send' }).props.onPress());
      expect(
        renderer.root.findAllByProps({ testID: 'chat-speech-finalizing' }).length,
      ).toBeGreaterThan(0);
      await act(async () =>
        renderer.root.findByProps({ testID: 'chat-speech-discard' }).props.onPress(),
      );
      await act(async () => {
        fireEvent('result', { results: [{ transcript: 'never sent' }], isFinal: true });
        fireEvent('end');
        vi.advanceTimersByTime(5000);
      });

      expect(onChangeText).not.toHaveBeenCalled();
      expect(onSend).not.toHaveBeenCalled();
      expect(renderer.root.findAllByProps({ testID: 'chat-speech-finalizing' })).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('stop button while a dictated message is sent', () => {
  const tagHandles = new Set(['ruby']);

  /** Sends land in `sends`; the test decides when each enters the Room. */
  function renderSending() {
    const sends: { dictated: any; text: string; enterRoom(): void }[] = [];
    let renderer: any;
    function ControlledComposer() {
      const [value, setValue] = React.useState('@ruby ');
      const [revision, setRevision] = React.useState(0);
      const valueRef = React.useRef(value);
      return (
        <ConversationComposer
          value={value}
          height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT}
          maxHeight={COMPOSER_MAX_INPUT_HEIGHT}
          focused={false}
          disabled={false}
          tagHandles={tagHandles}
          inputRevision={revision}
          onAttach={vi.fn()}
          onBlur={vi.fn()}
          onChangeText={(next) => {
            valueRef.current = next;
            setValue(next);
          }}
          onContentSizeChange={vi.fn()}
          onFocus={vi.fn()}
          onKeyPress={vi.fn()}
          onSend={(dictated) =>
            new Promise<void>(() => {
              sends.push({
                dictated,
                text: valueRef.current,
                enterRoom: () => {
                  dictated!.committed = true;
                  valueRef.current = '';
                  setValue('');
                  setRevision((current) => current + 1);
                },
              });
            })
          }
        />
      );
    }
    act(() => {
      renderer = create(<ControlledComposer />);
    });
    renderers.push(renderer);
    return { renderer: () => renderer, sends };
  }

  async function dictateAndSend(renderer: any, words: string) {
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {
      fireEvent('result', { results: [{ transcript: words }], isFinal: true });
    });
    await act(async () => renderer.root.findByProps({ testID: 'chat-send' }).props.onPress());
    await act(async () => fireEvent('end'));
  }

  it('keeps Stop, the mark and the waveform while the message is sent; Stop drops it and keeps the tag', async () => {
    const { renderer, sends } = renderSending();
    await dictateAndSend(renderer(), 'make it smaller');

    expect(sends).toHaveLength(1);
    expect(sends[0].text).toBe('@ruby make it smaller');
    const root = renderer().root;
    expect(root.findAllByProps({ testID: 'chat-speech-discard' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'chat-speech-finalizing' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'chat-speech-waveform' }).length).toBeGreaterThan(0);
    expect(root.findByProps({ testID: 'chat-send' }).props.disabled).toBe(true);
    expect(renderedText(renderer())).not.toContain('make it smaller');

    await act(async () => root.findByProps({ testID: 'chat-speech-discard' }).props.onPress());

    expect(sends[0].dictated.cancelled).toBe(true);
    expect(inputText(root)).toBe('@ruby ');
    expect(root.findAllByProps({ testID: 'chat-speech-finalizing' })).toHaveLength(0);
    expect(root.findByProps({ testID: 'chat-attach-button' })).toBeTruthy();
    expect(root.findByProps({ testID: 'chat-mic' })).toBeTruthy();
  });

  it('takes back words a final result already wrote while recording', async () => {
    const { renderer, sends } = renderSending();
    await act(async () => renderer().root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'half a thought' }], isFinal: true });
    });
    await act(async () =>
      renderer().root.findByProps({ testID: 'chat-speech-discard' }).props.onPress(),
    );

    const root = renderer().root;
    expect(sends).toHaveLength(0);
    expect(inputText(root)).toBe('@ruby ');
  });

  it('turns Stop back into the mic once the message enters the Room', async () => {
    const { renderer, sends } = renderSending();
    await dictateAndSend(renderer(), 'ship it');
    const discard = renderer().root.findByProps({ testID: 'chat-speech-discard' }).props.onPress;

    await act(async () => sends[0].enterRoom());
    // A Stop tap that raced the Room entry cannot pull the message back.
    await act(async () => discard());

    const root = renderer().root;
    expect(sends[0].dictated.cancelled).toBe(false);
    expect(root.findAllByProps({ testID: 'chat-speech-discard' })).toHaveLength(0);
    expect(root.findByProps({ testID: 'chat-mic' })).toBeTruthy();
    expect(root.findAllByProps({ testID: 'chat-speech-finalizing' })).toHaveLength(0);
  });
});

describe('member tags', () => {
  const tagHandles = new Set(['ruby', 'sol', 'speedy']);

  /** A composer whose parent keeps the text, as the Room does. */
  function renderControlled(initial: string, onKeyPress = vi.fn()) {
    const nativeInput = { setSelection: vi.fn(), setSelectionRange: vi.fn(), blur: vi.fn() };
    const changes: string[] = [];
    let renderer: any;
    function ControlledComposer() {
      const [value, setValue] = React.useState(initial);
      return (
        <ConversationComposer
          value={value}
          height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT}
          maxHeight={COMPOSER_MAX_INPUT_HEIGHT}
          focused
          disabled={false}
          tagHandles={tagHandles}
          onAttach={vi.fn()}
          onBlur={vi.fn()}
          onChangeText={(next) => {
            changes.push(next);
            setValue(next);
          }}
          onContentSizeChange={vi.fn()}
          onFocus={vi.fn()}
          onKeyPress={onKeyPress}
          onSend={vi.fn()}
        />
      );
    }
    act(() => {
      renderer = create(<ControlledComposer />, {
        createNodeMock: (element: any) => (element.type === 'TextInput' ? nativeInput : null),
      });
    });
    renderers.push(renderer);
    const input = () => inputHost(renderer.root);
    const select = (at: number, end = at) =>
      act(() => input().props.onSelectionChange({ nativeEvent: { selection: { start: at, end } } }));
    return { renderer, input, select, nativeInput, changes };
  }

  /** A web Backspace with the cursor at `at`, as react-native-web reports it. */
  function webBackspace(input: any, at: number, modifiers: Record<string, boolean> = {}) {
    const event = {
      nativeEvent: { key: 'Backspace', ...modifiers },
      target: { selectionStart: at, selectionEnd: at },
      preventDefault: vi.fn(),
    };
    act(() => input.props.onKeyPress(event));
    return event;
  }

  it.each(['android', 'ios', 'web'])(
    'shows a leading tag on %s as plain text of the input, like a later tag',
    (os) => {
      platformSetter.setOS(os);
      const { renderer } = render({ value: '@ruby hi @speedy', tagHandles });
      const input = inputHost(renderer.root);
      expect(input.props.value).toBe('@ruby hi @speedy');
      // No span, overlay or indent: the input draws the text itself.
      expect(input.findAll((node: any) => node.type === 'Text')).toHaveLength(0);
      expect(
        renderer.root.findAll((node: any) => String(node.props.testID ?? '').startsWith('chat-tag')),
      ).toHaveLength(0);
      const style = Object.assign({}, ...[input.props.style].flat(Infinity).filter(Boolean));
      expect(style.textIndent).toBeUndefined();
      expect(style.paddingTop).toBeUndefined();
      // Tags alone are still not a message: the mic stays and Send waits.
      act(() => renderer.update(<ConversationComposer {...renderer.root.findByType(ConversationComposer).props} value="@ruby " />));
      expect(renderer.root.findByProps({ testID: 'chat-mic' })).toBeTruthy();
      expect(renderer.root.findByProps({ testID: 'chat-send' }).props.disabled).toBe(true);
    },
  );

  it.each(['android', 'ios'])(
    'reports the cursor on %s exactly where the person put it, with no tag menu',
    (os) => {
      platformSetter.setOS(os);
      const onSelectionChange = vi.fn();
      const { renderer, nativeInput } = render({ value: '@ruby @sol hi', tagHandles, onSelectionChange });
      const input = inputHost(renderer.root);
      for (const selection of [{ start: 3, end: 3 }, { start: 0, end: 13 }, { start: 0, end: 5 }]) {
        act(() => input.props.onSelectionChange({ nativeEvent: { selection } }));
        expect(onSelectionChange).toHaveBeenLastCalledWith({ nativeEvent: { selection } });
      }
      expect(nativeInput.setSelection).not.toHaveBeenCalled();
      expect(nativeInput.blur).not.toHaveBeenCalled();
      expect(input.props.onPressIn).toBeUndefined();
    },
  );

  describe.each(['android', 'ios'])('a native backspace read from the text on %s', (os) => {
    beforeEach(() => platformSetter.setOS(os));

    it('deletes a whole tag at the start, in the middle and at the end, and puts the cursor where it began', () => {
      const start = renderControlled('@ruby make it smaller');
      start.select(5);
      act(() => start.input().props.onChangeText('@rub make it smaller'));
      expect(start.changes).toEqual([' make it smaller']);
      expect(start.nativeInput.setSelection).toHaveBeenLastCalledWith(0, 0);

      const middle = renderControlled('ask @speedy and @sol now');
      middle.select(11);
      act(() => middle.input().props.onChangeText('ask @speed and @sol now'));
      expect(middle.changes).toEqual(['ask  and @sol now']);
      expect(middle.nativeInput.setSelection).toHaveBeenLastCalledWith(4, 4);

      const end = renderControlled('thanks @sol');
      end.select(11);
      act(() => end.input().props.onChangeText('thanks @so'));
      expect(end.changes).toEqual(['thanks ']);
      expect(end.nativeInput.setSelection).toHaveBeenLastCalledWith(7, 7);
    });

    it('empties a field that holds only the tag', () => {
      const only = renderControlled('@ruby');
      only.select(5);
      act(() => only.input().props.onChangeText('@rub'));
      expect(only.changes).toEqual(['']);
      expect(inputText(only.renderer.root)).toBe('');
      expect(only.input().props.placeholder).toBeTruthy();
    });

    it('takes only the space after a tag, then the tag on the next press', () => {
      const tagged = renderControlled('@ruby ');
      tagged.select(6);
      act(() => tagged.input().props.onChangeText('@ruby'));
      expect(tagged.changes).toEqual(['@ruby']);
      expect(tagged.nativeInput.setSelection).not.toHaveBeenCalled();
      tagged.select(5);
      act(() => tagged.input().props.onChangeText('@rub'));
      expect(tagged.changes).toEqual(['@ruby', '']);
    });

    it('deletes one letter of a handle that is no Room member, and keeps other edits', () => {
      const typing = renderControlled('@spee');
      typing.select(5);
      act(() => typing.input().props.onChangeText('@spe'));
      act(() => typing.input().props.onChangeText('@spe hello'));
      expect(typing.changes).toEqual(['@spe', '@spe hello']);

      const cut = renderControlled('@ruby hi');
      // A selected last letter that is cut is not a backspace.
      cut.select(4, 5);
      act(() => cut.input().props.onChangeText('@rub hi'));
      expect(cut.changes).toEqual(['@rub hi']);
      expect(cut.nativeInput.setSelection).not.toHaveBeenCalled();
    });

    it.each(['Delete', 'Backspace'])(
      'deletes one letter on a forward delete inside a tag reported as %s',
      (key) => {
        // iOS reports a forward delete as Backspace; the cursor tells them apart.
        const onKeyPress = vi.fn();
        const forward = renderControlled('@ruby hi', onKeyPress);
        forward.select(4);
        act(() => forward.input().props.onKeyPress({ nativeEvent: { key } }));
        act(() => forward.input().props.onChangeText('@rub hi'));
        expect(onKeyPress).toHaveBeenCalledOnce();
        expect(forward.changes).toEqual(['@rub hi']);
        expect(forward.nativeInput.setSelection).not.toHaveBeenCalled();

        const beforeSpace = renderControlled('@ruby hi', onKeyPress);
        beforeSpace.select(5);
        act(() => beforeSpace.input().props.onKeyPress({ nativeEvent: { key } }));
        act(() => beforeSpace.input().props.onChangeText('@rubyhi'));
        expect(beforeSpace.changes).toEqual(['@rubyhi']);
      },
    );

    it('reads the next backspace from the cursor it set after deleting a tag', () => {
      const pair = renderControlled('@ruby @sol');
      pair.select(10);
      act(() => pair.input().props.onChangeText('@ruby @so'));
      expect(pair.changes).toEqual(['@ruby ']);
      expect(pair.nativeInput.setSelection).toHaveBeenLastCalledWith(6, 6);
      act(() => pair.input().props.onChangeText('@ruby'));
      expect(pair.changes).toEqual(['@ruby ', '@ruby']);
    });
  });

  describe('a web backspace key', () => {
    beforeEach(() => platformSetter.setOS('web'));

    it('deletes a whole tag at the start, in the middle and at the end, and puts the cursor where it began', () => {
      for (const [text, at, next, cursor] of [
        ['@ruby make it smaller', 5, ' make it smaller', 0],
        ['ask @speedy and @sol now', 11, 'ask  and @sol now', 4],
        ['thanks @sol', 11, 'thanks ', 7],
        ['@ruby', 5, '', 0],
      ] as const) {
        const onKeyPress = vi.fn();
        const composer = renderControlled(text, onKeyPress);
        const event = webBackspace(composer.input(), at);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(onKeyPress).not.toHaveBeenCalled();
        expect(composer.changes).toEqual([next]);
        expect(composer.nativeInput.setSelectionRange).toHaveBeenLastCalledWith(cursor, cursor);
      }
    });

    it('leaves the space after a tag, a half-typed handle and a word delete to the browser', () => {
      for (const [text, at, modifiers] of [
        ['@ruby ', 6, {}],
        ['@spee', 5, {}],
        ['@ruby', 5, { altKey: true }],
        ['@ruby', 5, { ctrlKey: true }],
        ['@ruby', 5, { metaKey: true }],
      ] as const) {
        const onKeyPress = vi.fn();
        const composer = renderControlled(text, onKeyPress);
        const event = webBackspace(composer.input(), at, modifiers);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(onKeyPress).toHaveBeenCalledOnce();
        expect(composer.changes).toEqual([]);
      }
      // A selection is the browser's to delete.
      const onKeyPress = vi.fn();
      const selected = renderControlled('@ruby hi', onKeyPress);
      const event = {
        nativeEvent: { key: 'Backspace' },
        target: { selectionStart: 1, selectionEnd: 5 },
        preventDefault: vi.fn(),
      };
      act(() => selected.input().props.onKeyPress(event));
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(selected.changes).toEqual([]);
    });

    it('writes typed text through as it is, with no tag diffing', () => {
      const composer = renderControlled('@ruby hi');
      act(() => composer.input().props.onChangeText('@rub hi'));
      expect(composer.changes).toEqual(['@rub hi']);
    });
  });

  it('shows the leading tags as plain text while recording', async () => {
    const { renderer } = render({ value: '', tagHandles });
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});
    expect(renderer.root.findAllByProps({ testID: 'chat-dictation-tags' })).toHaveLength(0);

    const props = renderer.root.findByType(ConversationComposer).props;
    act(() => renderer.update(<ConversationComposer {...props} value="@ruby @sol " />));
    const shown = renderer.root.findAll(
      (node: any) => node.props.testID === 'chat-dictation-tags' && typeof node.type === 'string',
    );
    expect(shown).toHaveLength(1);
    expect(shown[0].props.children).toBe('@ruby @sol');
    expect(shown[0].props.onPress).toBeUndefined();
  });

  it('appends dictation after the tags with one space and sends it with the tag', async () => {
    let renderer: any;
    const sent = vi.fn();
    function ControlledComposer() {
      const [value, setValue] = React.useState('@ruby ');
      const valueRef = React.useRef(value);
      return (
        <ConversationComposer
          value={value}
          height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT}
          maxHeight={COMPOSER_MAX_INPUT_HEIGHT}
          focused={false}
          disabled={false}
          tagHandles={tagHandles}
          onAttach={vi.fn()}
          onBlur={vi.fn()}
          onChangeText={(next) => {
            valueRef.current = next;
            setValue(next);
          }}
          onContentSizeChange={vi.fn()}
          onFocus={vi.fn()}
          onKeyPress={vi.fn()}
          onSend={() => sent(valueRef.current)}
        />
      );
    }
    act(() => {
      renderer = create(<ControlledComposer />);
    });
    renderers.push(renderer);
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'make it smaller' }], isFinal: false });
    });
    await act(async () => renderer.root.findByProps({ testID: 'chat-send' }).props.onPress());
    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'make it smaller' }], isFinal: true });
    });
    expect(sent).toHaveBeenCalledWith('@ruby make it smaller');
  });

  it('does not send a tag alone when the take caught nothing', async () => {
    const { renderer, onSend } = render({ value: '@ruby ', tagHandles });
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});
    await act(async () => renderer.root.findByProps({ testID: 'chat-send' }).props.onPress());
    await act(async () => fireEvent('end'));
    expect(onSend).not.toHaveBeenCalled();
  });
});
