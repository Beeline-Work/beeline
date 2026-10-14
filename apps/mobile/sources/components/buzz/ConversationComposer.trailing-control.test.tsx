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
// The soft keyboard: shown or hidden, with the composer's listeners.
const keyboard = vi.hoisted(() => ({
  visible: true,
  listeners: new Map<string, () => void>(),
  dismiss: vi.fn(),
}));
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
    ScrollView: host('ScrollView'),
    Linking: { openSettings: vi.fn() },
    Keyboard: {
      isVisible: () => keyboard.visible,
      addListener: (event: string, listener: () => void) => {
        keyboard.listeners.set(event, listener);
        return { remove: () => keyboard.listeners.delete(event) };
      },
      dismiss: keyboard.dismiss,
    },
    Animated: {
      View: host('View'),
      Value: class {
        constructor(readonly value: number) {}
      },
      timing: () => ({ start() {}, stop() {} }),
    },
    Easing: { linear: (t: number) => t },
    Platform: {
      get OS() { return platformSetter.getOS(); },
      select: (choices: any) => choices.default,
    },
    StyleSheet: { create: (styles: any) => styles },
  } as any;
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
  return { default: Svg, Svg, Line: host('RNSVGLine'), Path: host('RNSVGPath'), Rect: host('RNSVGRect') };
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
  keyboard.visible = true;
  keyboard.listeners.clear();
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

// Locked mock v4 (2026-10-14): fixed places. ＋ on the left never changes;
// the voice spot is the mic, or Stop while a take is live; the far right is
// the go action — Conversation while nothing is typed, Send otherwise.

const voiceState = () => ({ join: vi.fn(), end: vi.fn(), call: null, connecting: false, error: null });
/** The row's controls, left to right, by testID. */
function controls(root: any) {
  const row = hosts(root, 'chat-composer-input-row')[0];
  const ids: string[] = [];
  const walk = (node: any) => {
    if (typeof node === 'string' || !node) return;
    const id = node.props?.testID;
    if (typeof node.type === 'string' && ['chat-attach-button', 'chat-mic', 'chat-speech-discard',
      'chat-conversation', 'chat-send'].includes(id)) ids.push(id);
    (node.children ?? []).forEach(walk);
  };
  walk(row);
  return ids;
}
function rerender(root: any, props: Record<string, any>) {
  const renderer = renderers[renderers.length - 1];
  act(() => renderer.update(<ConversationComposer {...root.findByType(ConversationComposer).props} {...props} />));
}
async function startTake(root: any) {
  await act(async () => hosts(root, 'chat-mic')[0].props.onPress());
  await act(async () => {});
}

describe('composer controls hold fixed places', () => {
  it('state matrix: empty, has text, tag-only, dictating', async () => {
    const tagHandles = new Set(['ruby']);
    const root = render({ voice: voiceState(), value: '', tagHandles });
    expect(controls(root)).toEqual(['chat-attach-button', 'chat-mic', 'chat-conversation']);
    rerender(root, { value: '@ruby ' });
    expect(controls(root)).toEqual(['chat-attach-button', 'chat-mic', 'chat-conversation']);
    rerender(root, { value: '@ruby check the corner' });
    expect(controls(root)).toEqual(['chat-attach-button', 'chat-mic', 'chat-send']);
    await startTake(root);
    expect(controls(root)).toEqual(['chat-attach-button', 'chat-speech-discard', 'chat-send']);
  });

  it('an empty take still offers Send in the go slot, never Conversation', async () => {
    const root = render({ voice: voiceState(), value: '' });
    await startTake(root);
    expect(controls(root)).toEqual(['chat-attach-button', 'chat-speech-discard', 'chat-send']);
    expect(hosts(root, 'chat-send')[0].props.disabled).toBe(false);
  });

  it('keeps the same places with the keyboard up or down, focused or not', () => {
    const root = render({ value: 'ready to send', focused: true });
    expect(controls(root)).toEqual(['chat-attach-button', 'chat-mic', 'chat-send']);
    act(() => keyboard.listeners.get('keyboardDidHide')?.());
    expect(controls(root)).toEqual(['chat-attach-button', 'chat-mic', 'chat-send']);
    rerender(root, { focused: false });
    expect(controls(root)).toEqual(['chat-attach-button', 'chat-mic', 'chat-send']);
  });

  it('without Conversation, Send holds the far right, disabled while empty', () => {
    const root = render({ value: '' });
    expect(controls(root)).toEqual(['chat-attach-button', 'chat-mic', 'chat-send']);
    expect(hosts(root, 'chat-send')[0].props.disabled).toBe(true);
    rerender(root, { value: 'hello' });
    expect(hosts(root, 'chat-send')[0].props.disabled).toBe(false);
  });

  it('a staged file alone makes Send the go action', () => {
    const root = render({
      voice: voiceState(),
      value: '',
      canSend: true,
      attachments: [{ uri: 'file:///tmp/a.png', name: 'a.png', mimeType: 'image/png', sizeLabel: '1 KB' }],
    });
    expect(controls(root)).toEqual(['chat-attach-button', 'chat-mic', 'chat-send']);
  });

  it('a reply banner alone is not something to send', () => {
    const root = render({ voice: voiceState(), value: '', reply: { handle: '@cara', preview: 'earlier words' } });
    expect(controls(root)).toEqual(['chat-attach-button', 'chat-mic', 'chat-conversation']);
  });

  it('keeps ＋ working while dictating', async () => {
    const onAttach = vi.fn();
    const root = render({ value: '', onAttach });
    await startTake(root);
    const attach = hosts(root, 'chat-attach-button')[0];
    expect(attach.props.disabled).toBe(false);
    act(() => attach.props.onPress());
    expect(onAttach).toHaveBeenCalledOnce();
  });

  it('Stop takes the mic spot and discards the take', async () => {
    const onSend = vi.fn();
    const onChangeText = vi.fn();
    const root = render({ value: 'typed', onSend, onChangeText });
    await startTake(root);
    expect(hosts(root, 'chat-mic')).toHaveLength(0);
    act(() => hosts(root, 'chat-speech-discard')[0].props.onPress());
    expect(mockMod.abort).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(onChangeText).not.toHaveBeenCalled();
    expect(controls(root)).toEqual(['chat-attach-button', 'chat-mic', 'chat-send']);
  });

  it('lowers the keyboard when the mic starts a take', async () => {
    const root = render({ value: '', focused: true });
    await act(async () => hosts(root, 'chat-mic')[0].props.onPress());
    expect(keyboard.dismiss).toHaveBeenCalledOnce();
  });

  it('never hides the send control while an agent is working', () => {
    // PR #1340 removed the send button whenever a turn was active; it is
    // restored unconditionally. The composer takes no `running` prop at all,
    // so no turn state can remove the control — a tap queues the message.
    expect(hosts(render({ value: 'next instruction', focused: true }), 'chat-send')).toHaveLength(1);
  });

  it('when speech is unavailable, an empty composer still shows the disabled send control', () => {
    // An unsupported browser has no recognition module.
    platformSetter.setOS('web');
    speechModuleState.present = false;
    const webRoot = render({ value: '' });
    expect(hosts(webRoot, 'chat-mic')).toHaveLength(0);
    expect(hosts(webRoot, 'chat-send')[0].props.disabled).toBe(true);

    // The owner's speech switch off on a mobile platform behaves the same.
    platformSetter.setOS('android');
    speechModuleState.present = true;
    const mutedRoot = render({ value: '', speechEnabled: false });
    expect(hosts(mutedRoot, 'chat-mic')).toHaveLength(0);
    expect(hosts(mutedRoot, 'chat-send')[0].props.disabled).toBe(true);
  });

  it('every control is one 26pt slot with a 44pt target and one 20pt drawn glyph', async () => {
    const slot = (node: any) => {
      const style = [node.props.style].flat()[0];
      return [style.width, style.height, 26 + 2 * node.props.hitSlop];
    };
    const root = render({ voice: voiceState(), value: '' });
    const empty = ['chat-attach-button', 'chat-mic', 'chat-conversation'].map(id => slot(hosts(root, id)[0]));
    rerender(root, { value: 'hello' });
    const sendSlot = slot(hosts(root, 'chat-send')[0]);
    await startTake(root);
    const stopSlot = slot(hosts(root, 'chat-speech-discard')[0]);
    for (const each of [...empty, sendSlot, stopSlot]) expect(each).toEqual([26, 26, 44]);
    const glyphs = root.findAll((node: any) => node.type === 'RNSVG')
      .map((node: any) => [node.props.width, node.props.height, node.props.viewBox]);
    expect(glyphs.length).toBeGreaterThanOrEqual(3);
    for (const glyph of glyphs) expect(glyph).toEqual([20, 20, '0 0 20 20']);
  });

  it('inks every control in textPrimary; only Send is brass; disabled is muted', async () => {
    const ink = (root: any, id: string) => root.findAll((node: any) => node.type === 'RNSVG')
      .filter((node: any) => {
        let at = node.parent;
        while (at && at.props?.testID !== id) at = at.parent;
        return Boolean(at);
      })
      .flatMap((node: any) => node.findAll((child: any) => typeof child.props?.stroke === 'string')
        .map((child: any) => child.props.stroke));
    const root = render({ voice: voiceState(), value: '' });
    expect(new Set(ink(root, 'chat-attach-button'))).toEqual(new Set(['#f0f0f3']));
    expect(new Set(ink(root, 'chat-mic'))).toEqual(new Set(['#f0f0f3']));
    expect(new Set(ink(root, 'chat-conversation'))).toEqual(new Set(['#f0f0f3']));
    rerender(root, { value: 'hello' });
    expect(new Set(ink(root, 'chat-send'))).toEqual(new Set(['#b08a4a']));
    await startTake(root);
    expect(new Set(ink(root, 'chat-speech-discard'))).toEqual(new Set(['#f0f0f3']));
    const idle = render({ value: '' });
    expect(new Set(ink(idle, 'chat-send'))).toEqual(new Set(['#83838d']));
  });
});

describe('separate Conversation entry', () => {
  const voice = () => ({ join: vi.fn(), end: vi.fn(), call: null, connecting: false, error: null });
  it.each(['android', 'web'])('keeps mic beside waveform and swaps only waveform on %s', os => {
    platformSetter.setOS(os);
    const state = voice();
    const root = render({ voice: state });
    expect(hosts(root, 'chat-mic')).toHaveLength(1);
    expect(hosts(root, 'chat-conversation')).toHaveLength(1);
    expect(hosts(root, 'chat-send')).toHaveLength(0);
    act(() => hosts(root, 'chat-conversation')[0].props.onPress());
    expect(state.join).toHaveBeenCalledOnce();
    expect(mockMod.start).not.toHaveBeenCalled();
    const renderer = renderers.at(-1);
    act(() => renderer.update(<ConversationComposer {...root.findByType(ConversationComposer).props} value="hello" />));
    expect(hosts(root, 'chat-mic')).toHaveLength(1);
    expect(hosts(root, 'chat-conversation')).toHaveLength(0);
    expect(hosts(root, 'chat-send')).toHaveLength(1);
    act(() => keyboard.listeners.get('keyboardDidHide')?.());
    expect(hosts(root, 'chat-send')).toHaveLength(1);
  });
  it('keeps Conversation available without a dictation recognizer', () => {
    speechModuleState.present = false;
    const root = render({ voice: voice() });
    expect(hosts(root, 'chat-conversation')).toHaveLength(1);
    expect(hosts(root, 'chat-mic')).toHaveLength(0);
  });
  it('disables entry with the composer', () => {
    expect(hosts(render({ voice: voice(), disabled: true }), 'chat-conversation')[0].props.disabled).toBe(true);
  });
  it('keeps attachment Send available without dictation', () => {
    speechModuleState.present = false;
    const root = render({ voice: voice(), canSend: true });
    expect(hosts(root, 'chat-send')).toHaveLength(1);
    expect(hosts(root, 'chat-conversation')).toHaveLength(0);
  });
});
