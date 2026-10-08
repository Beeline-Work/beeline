import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDeviceSpeechLocale } from '@/buzz/speech-locale';

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

import { SPEECH_SILENCE_TIMEOUT_MS } from '@/buzz/speech-input';
import {
  DictationWaveform as DictationWaveformType,
  WAVEFORM_SAMPLE_MS,
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

/** Every string the composer renders, read from `.props.children`. */
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
  it('tapping mic starts a take: waveform in the field, stop in the attach slot, no status line', async () => {
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
    expect(renderer.root.findAllByProps({ testID: 'chat-attach-button' })).toHaveLength(0);
    expect(
      renderer.root.findByProps({ testID: 'chat-speech-discard' }).props.accessibilityLabel,
    ).toBe('Discard recording');
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
    expect(input.props.value).toBe('draft words');
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
    const mic = renderer.root.findByProps({ testID: 'chat-mic' });
    expect(mic.props.accessibilityState).toEqual({ selected: true });
    expect(mic.props.accessibilityLabel).toBe('Stop listening and send');
    expect(mic.props.accessibilityHint).toBe('Stops dictation and sends');
  });

  it('grows the newest waveform bar with native volume', async () => {
    vi.useFakeTimers();
    try {
      const { renderer } = render();
      await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
      await act(async () => {});
      await act(async () => vi.advanceTimersByTime(WAVEFORM_SAMPLE_MS));
      await act(async () => fireEvent('volumechange', { value: 10 }));
      await act(async () => vi.advanceTimersByTime(WAVEFORM_SAMPLE_MS));
      const waveform = renderer.root
        .findAllByProps({ testID: 'chat-speech-waveform' })
        .find((node: any) => node.type === 'View');
      const heights = waveform.children.map(
        (bar: any) => bar.props.style.flat(Infinity).find((style: any) => style?.height).height,
      );
      expect(heights).toEqual([2, 18]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the mic a plain microphone with no ring or glow while listening', async () => {
    const { renderer } = render();
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});
    await act(async () => fireEvent('volumechange', { value: 10 }));

    const mic = renderer.root.findByProps({ testID: 'chat-mic' });
    const styles = mic.props.style.flat(Infinity).filter(Boolean);
    expect(styles).toEqual([expect.objectContaining({ width: 26, height: 26 })]);
    expect(renderer.root.findByProps({ testID: 'chat-mic-glyph' }).props.color).toBe('#f0f0f3');
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
    expect(renderer.root.findByProps({ testID: 'chat-input' }).props.value).toBe('');

    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'hello world' }], isFinal: true });
    });
    expect(renderer.root.findByProps({ testID: 'chat-input' }).props.value).toBe('hello world');
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

    expect(renderer.root.findByProps({ testID: 'chat-input' }).props.value).toBe('Sally sell');
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
    await act(async () => fireEvent('end'));

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

  it('removes the waveform after listening ends', async () => {
    const { renderer } = render({ value: '' });
    const micBtn = renderer.root.findByProps({ testID: 'chat-mic' });

    await act(async () => micBtn.props.onPress());
    await act(async () => {});
    expect(renderer.root.findAllByProps({ testID: 'chat-speech-waveform' }).length).toBeGreaterThan(
      0,
    );

    // Stop listening
    await act(async () => micBtn.props.onPress());
    await act(async () => fireEvent('end'));
    expect(renderer.root.findAllByProps({ testID: 'chat-speech-waveform' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'chat-attach-button' })).toBeTruthy();
  });

  it('waits for a complete final transcript before sending after a mic press', async () => {
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
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    expect(sentText).not.toHaveBeenCalled();
    // The Beeline mark replaces the mic and the waveform freezes while the
    // take is transcribed; there is no status line.
    expect(
      renderer.root.findAllByProps({ testID: 'chat-speech-finalizing' }).length,
    ).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ testID: 'chat-mic-glyph' })).toHaveLength(0);
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
    expect(renderer.root.findByProps({ testID: 'chat-input' }).props.value).toBe('');
    expect(renderer.root.findAllByProps({ testID: 'chat-speech-finalizing' })).toHaveLength(0);
  });

  it('one mic press after a committed final sends that text and clears', async () => {
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
    expect(renderer.root.findByProps({ testID: 'chat-input' }).props.value).toBe('already final');
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => fireEvent('end'));

    expect(onSend).toHaveBeenCalledOnce();
    expect(renderer.root.findByProps({ testID: 'chat-input' }).props.value).toBe('');
  });

  it('an empty mic press only stops and does not send', async () => {
    const { renderer, onSend } = render({ value: '' });
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
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
    expect(renderer.root.findByProps({ testID: 'chat-input' }).props.value).toBe('typed ');
  });

  it('discards a take while it is being transcribed, so the mic press sends nothing', async () => {
    vi.useFakeTimers();
    try {
      const { renderer, onSend, onChangeText } = render({ value: '' });
      await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
      await act(async () => {
        fireEvent('result', { results: [{ transcript: 'never sent' }], isFinal: false });
      });
      await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
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
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => fireEvent('end'));
  }

  it('keeps ■, the mark and the waveform while the message is sent; ■ drops it and keeps the chip', async () => {
    const { renderer, sends } = renderSending();
    await dictateAndSend(renderer(), 'make it smaller');

    expect(sends).toHaveLength(1);
    expect(sends[0].text).toBe('@ruby make it smaller');
    const root = renderer().root;
    expect(root.findAllByProps({ testID: 'chat-speech-discard' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'chat-speech-finalizing' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'chat-speech-waveform' }).length).toBeGreaterThan(0);
    expect(root.findAllByProps({ testID: 'chat-send' })).toHaveLength(0);
    expect(renderedText(renderer())).not.toContain('make it smaller');

    await act(async () => root.findByProps({ testID: 'chat-speech-discard' }).props.onPress());

    expect(sends[0].dictated.cancelled).toBe(true);
    expect(root.findByProps({ testID: 'chat-input' }).props.value).toBe('');
    expect(root.findAllByProps({ testID: 'chat-tag-ruby' }).length).toBeGreaterThan(0);
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
    expect(root.findByProps({ testID: 'chat-input' }).props.value).toBe('');
    expect(root.findAllByProps({ testID: 'chat-tag-ruby' }).length).toBeGreaterThan(0);
  });

  it('turns ■ back into ＋ once the message enters the Room', async () => {
    const { renderer, sends } = renderSending();
    await dictateAndSend(renderer(), 'ship it');
    const discard = renderer().root.findByProps({ testID: 'chat-speech-discard' });

    await act(async () => sends[0].enterRoom());
    // A ■ tap that raced the Room entry cannot pull the message back.
    await act(async () => discard.props.onPress());

    const root = renderer().root;
    expect(sends[0].dictated.cancelled).toBe(false);
    expect(root.findAllByProps({ testID: 'chat-speech-discard' })).toHaveLength(0);
    expect(root.findByProps({ testID: 'chat-attach-button' })).toBeTruthy();
    expect(root.findAllByProps({ testID: 'chat-speech-finalizing' })).toHaveLength(0);
  });
});

describe('recipient chips', () => {
  const tagHandles = new Set(['ruby', 'sol']);

  it('shows a leading agent tag as a chip; the field reads empty and keeps the mic', () => {
    const { renderer } = render({ value: '@ruby ', tagHandles });
    expect(renderer.root.findByProps({ testID: 'chat-input' }).props.value).toBe('');
    expect(renderer.root.findAllByProps({ testID: 'chat-tag-ruby' }).length).toBeGreaterThan(0);
    expect(
      renderer.root.findByProps({ testID: 'chat-tag-ruby-edit' }).props.accessibilityLabel,
    ).toBe('Edit tags, @ruby');
    expect(
      renderer.root.findByProps({ testID: 'chat-tag-ruby-remove' }).props.accessibilityLabel,
    ).toBe('Remove @ruby');
    expect(renderer.root.findByProps({ testID: 'chat-mic' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ testID: 'chat-send' })).toHaveLength(0);
  });

  it('makes each chip a full-row target, and scrolls many chips in a capped strip beside the mic', () => {
    const many = new Set(['ruby', 'sol', 'fathom', 'goosy', 'hoots', 'milo']);
    const { renderer } = render({
      value: '@ruby @sol @fathom @goosy @hoots @milo ',
      tagHandles: many,
      onEditTags: vi.fn(),
    });
    const strip = renderer.root.findByProps({ testID: 'chat-tags' });
    expect(strip.props.horizontal).toBe(true);
    expect(strip.props.style).toMatchObject({ flexShrink: 1, maxWidth: '50%' });
    for (const handle of many) {
      expect(renderer.root.findByProps({ testID: `chat-tag-${handle}` }).props.style.height).toBe(
        42,
      );
    }
    expect(renderer.root.findByProps({ testID: 'chat-tag-ruby-remove' }).props.style.width).toBe(
      28,
    );
    expect(renderer.root.findByProps({ testID: 'chat-mic' })).toBeTruthy();
  });

  it('leaves a person or unknown handle as typed text', () => {
    const { renderer } = render({ value: '@lunchbox hi', tagHandles });
    expect(renderer.root.findByProps({ testID: 'chat-input' }).props.value).toBe('@lunchbox hi');
  });

  it('writes typed text back behind the chips, and reports whole-text cursor offsets', () => {
    const onSelectionChange = vi.fn();
    const { renderer, onChangeText } = render({ value: '@ruby ', tagHandles, onSelectionChange });
    const input = renderer.root.findByProps({ testID: 'chat-input' });
    act(() => input.props.onChangeText('hello'));
    expect(onChangeText).toHaveBeenCalledWith('@ruby hello');
    act(() => input.props.onSelectionChange({ nativeEvent: { selection: { start: 2, end: 2 } } }));
    expect(onSelectionChange.mock.calls[0][0].nativeEvent.selection).toEqual({ start: 8, end: 8 });
  });

  it('removes the last chip with one backspace at the start of the field', () => {
    const onKeyPress = vi.fn();
    const { renderer, onChangeText } = render({
      value: '@ruby @sol hi',
      tagHandles,
      onKeyPress,
    });
    const input = renderer.root.findByProps({ testID: 'chat-input' });
    act(() => input.props.onSelectionChange({ nativeEvent: { selection: { start: 0, end: 0 } } }));
    const preventDefault = vi.fn();
    act(() => input.props.onKeyPress({ nativeEvent: { key: 'Backspace' }, preventDefault }));
    expect(onChangeText).toHaveBeenCalledWith('@ruby hi');
    expect(preventDefault).toHaveBeenCalled();
    expect(onKeyPress).not.toHaveBeenCalled();

    act(() => input.props.onSelectionChange({ nativeEvent: { selection: { start: 2, end: 2 } } }));
    act(() => input.props.onKeyPress({ nativeEvent: { key: 'Backspace' }, preventDefault }));
    expect(onKeyPress).toHaveBeenCalledOnce();
  });

  it('removes one chip with its ×, and opens the tag menu from its body', () => {
    const onEditTags = vi.fn();
    const { renderer, onChangeText } = render({ value: '@ruby @sol ', tagHandles, onEditTags });
    act(() => renderer.root.findByProps({ testID: 'chat-tag-ruby-remove' }).props.onPress());
    expect(onChangeText).toHaveBeenCalledWith('@sol ');
    act(() => renderer.root.findByProps({ testID: 'chat-tag-sol-edit' }).props.onPress());
    expect(onEditTags).toHaveBeenCalledOnce();
  });

  it('keeps chips tappable while recording, and offers an empty @ chip when none is tagged', async () => {
    const onEditTags = vi.fn();
    const { renderer } = render({ value: '', tagHandles, onEditTags });
    expect(renderer.root.findAllByProps({ testID: 'chat-tag-empty' })).toHaveLength(0);
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});
    const empty = renderer.root.findByProps({ testID: 'chat-tag-empty' });
    expect(empty.props.accessibilityLabel).toBe('Tag an agent');
    act(() => empty.props.onPress());
    expect(onEditTags).toHaveBeenCalledOnce();
    expect(mockMod.stop).not.toHaveBeenCalled();
    expect(mockMod.abort).not.toHaveBeenCalled();

    const props = renderer.root.findByType(ConversationComposer).props;
    act(() => renderer.update(<ConversationComposer {...props} value="@ruby " />));
    expect(renderer.root.findAllByProps({ testID: 'chat-tag-empty' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'chat-tag-ruby' }).length).toBeGreaterThan(0);
  });

  it('appends dictation after the chips with one space and sends it with the tag', async () => {
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
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {
      fireEvent('result', { results: [{ transcript: 'make it smaller' }], isFinal: true });
    });
    expect(sent).toHaveBeenCalledWith('@ruby make it smaller');
  });

  it('does not send a chip alone when the take caught nothing', async () => {
    const { renderer, onSend } = render({ value: '@ruby ', tagHandles });
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => {});
    await act(async () => renderer.root.findByProps({ testID: 'chat-mic' }).props.onPress());
    await act(async () => fireEvent('end'));
    expect(onSend).not.toHaveBeenCalled();
  });
});
