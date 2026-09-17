import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Synchronous mock for react-native.
const platformSetter = vi.hoisted(() => {
  let _os = 'android';
  return {
    setOS: (v: string) => { _os = v; },
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
      get OS() { return platformSetter.getOS(); },
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

// Mock the speech adapter; `modulePresent` simulates a device without a
// recogniser (getRecognitionModule() returning null).
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
const speechModuleState = vi.hoisted(() => ({ present: true }));
vi.mock('@/buzz/speech-recognition-adapter', () => ({
  getRecognitionModule: () => (speechModuleState.present ? mockMod : null),
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
        body: { fontFamily: 'SpaceGrotesk-Regular', fontSize: 16, lineHeight: 23, letterSpacing: 0 },
        machine: { fontFamily: 'IBMPlexMono-Regular', fontSize: 13, lineHeight: 19, letterSpacing: 0 },
        meta: { fontFamily: 'SpaceGrotesk-Regular', fontSize: 13, lineHeight: 19, letterSpacing: 0 },
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

// findAllByProps matches both the component instance and its host element;
// count host nodes only, so each rendered control counts once.
function hosts(root: any, testID: string) {
  return root.findAllByProps({ testID }).filter((n: any) => typeof n.type === 'string');
}

function render(props: Record<string, any> = {}) {
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
        onChangeText={vi.fn()}
        onContentSizeChange={vi.fn()}
        onFocus={vi.fn()}
        onKeyPress={vi.fn()}
        onSend={vi.fn()}
        {...props}
      />,
    );
  });
  renderers.push(renderer);
  return renderer.root;
}

beforeEach(() => {
  vi.clearAllMocks();
  handlerMap.clear();
  platformSetter.setOS('android');
  speechModuleState.present = true;
  mockMod.getPermissionsAsync.mockResolvedValue({ status: 'granted', granted: true, canAskAgain: true });
  mockMod.requestPermissionsAsync.mockResolvedValue({ status: 'granted', granted: true, canAskAgain: true });
  mockMod.addListener.mockImplementation((event: string, handler: (...args: any[]) => void) => {
    handlerMap.set(event, handler);
    return { remove: vi.fn(() => handlerMap.delete(event)) };
  });
});

afterEach(() => {
  act(() => renderers.splice(0).forEach((r) => r.unmount()));
});

// Steer 2026-09-15: the composer's trailing control is mic XOR send, never
// both. "Something to send" reuses the send button's own predicate
// (`canSend ?? Boolean(value.trim())`), so text or a staged attachment — and
// nothing else — moves the control from mic to send.

describe('composer trailing control is mic XOR send', () => {
  it('shows only the send control when there is text to send', () => {
    const root = render({ value: 'ready to send' });
    expect(hosts(root, 'chat-mic')).toHaveLength(0);
    expect(hosts(root, 'chat-send')).toHaveLength(1);
  });

  it('shows only the send control when an attachment is staged via canSend', () => {
    // The chat screen computes canSend from text OR staged attachments; the
    // composer must reuse that same verdict, not a second predicate.
    const root = render({ value: '', canSend: true });
    expect(hosts(root, 'chat-mic')).toHaveLength(0);
    expect(hosts(root, 'chat-send')).toHaveLength(1);
  });

  it('a reply banner alone does not make something sendable: mic stays', () => {
    const root = render({ value: '', reply: { handle: '@cara', preview: 'earlier words' } });
    expect(hosts(root, 'chat-send')).toHaveLength(0);
    expect(hosts(root, 'chat-mic')).toHaveLength(1);
  });

  it('a staged attachment in the adjuncts row alone does not make something sendable: mic stays', () => {
    const root = render({
      value: '',
      attachments: [{ uri: 'file:///tmp/a.png', name: 'a.png', mimeType: 'image/png', sizeLabel: '1 KB' }],
    });
    expect(hosts(root, 'chat-send')).toHaveLength(0);
    expect(hosts(root, 'chat-mic')).toHaveLength(1);
  });

  it('while listening, the control stays the mic even as partial transcript fills the input', async () => {
    const root = render({ value: '' });
    await act(async () => hosts(root, 'chat-mic')[0].props.onPress());
    await act(async () => {});
    expect(hosts(root, 'chat-mic')).toHaveLength(1);

    // Partial transcript arrives and the parent echoes it into the value;
    // the control must not swap to send mid-dictation.
    fireEvent('result', { results: [{ transcript: 'partial words so far' }] });
    const renderer = renderers[renderers.length - 1];
    act(() => {
      renderer.update(
        <ConversationComposer
          value="partial words so far"
          height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT}
          maxHeight={COMPOSER_MAX_INPUT_HEIGHT}
          focused={false}
          disabled={false}
          onBlur={vi.fn()}
          onChangeText={vi.fn()}
          onContentSizeChange={vi.fn()}
          onFocus={vi.fn()}
          onKeyPress={vi.fn()}
          onSend={vi.fn()}
        />,
      );
    });
    expect(hosts(root, 'chat-send')).toHaveLength(0);
    expect(hosts(root, 'chat-mic')).toHaveLength(1);
  });

  it('when speech is unavailable, an empty composer still shows the disabled send control', () => {
    // getRecognitionModule() returns null on web/desktop.
    platformSetter.setOS('web');
    const webRoot = render({ value: '' });
    expect(hosts(webRoot, 'chat-mic')).toHaveLength(0);
    expect(hosts(webRoot, 'chat-send')[0].props.disabled).toBe(true);

    // The owner's speech switch off on a mobile platform behaves the same.
    platformSetter.setOS('android');
    const mutedRoot = render({ value: '', speechEnabled: false });
    expect(hosts(mutedRoot, 'chat-mic')).toHaveLength(0);
    expect(hosts(mutedRoot, 'chat-send')[0].props.disabled).toBe(true);
  });

  it('both controls share one slot and size so the swap never shifts the input width', () => {
    const empty = render({ value: '' });
    const mic = hosts(empty, 'chat-mic')[0];
    const micStyle = Array.isArray(mic.props.style) ? mic.props.style[0] : mic.props.style;
    expect(micStyle.width).toBe(26);
    expect(micStyle.height).toBe(26);
    expect(micStyle.marginLeft).toBe(8);

    const ready = render({ value: 'text' });
    const send = hosts(ready, 'chat-send')[0];
    const sendStyle = Array.isArray(send.props.style) ? send.props.style[0] : send.props.style;
    expect(sendStyle.width).toBe(26);
    expect(sendStyle.height).toBe(26);
    expect(sendStyle.marginLeft).toBe(8);
  });
});
