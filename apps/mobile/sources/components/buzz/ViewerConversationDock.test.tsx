import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
import { publishViewerConversation, removeViewerConversation } from '@/buzz/viewer-conversation';

const scrollToEnd = vi.hoisted(() => vi.fn());
const keyboard = vi.hoisted(() => ({ height: 0 }));
vi.mock('react-native-keyboard-controller', () => ({ useKeyboardState: (select: any) => select(keyboard) }));
const dimensions = vi.hoisted(() => ({ width: 390, height: 800 }));
const keyboardListeners = vi.hoisted(() => new Map<string, Set<() => void>>());
vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return {
    useWindowDimensions: () => dimensions, ScrollView: host('ScrollView'),
    View: host('View'), Text: host('Text'), Pressable: host('Pressable'), Platform: { OS: 'android' },
    Keyboard: {
      addListener: (name: string, callback: () => void) => {
        const listeners = keyboardListeners.get(name) ?? new Set();
        listeners.add(callback); keyboardListeners.set(name, listeners);
        return { remove: () => listeners.delete(callback) };
      },
    },
    Animated: { View: host('View'), Value: class {}, timing: () => ({ start() {} }) },
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0 }) }));
vi.mock('./ConversationComposer', () => ({
  COMPOSER_SINGLE_LINE_INPUT_HEIGHT: 26,
  ConversationComposer: (props: any) => React.createElement('Composer', props),
}));
vi.mock('./TranscriptReference', () => ({
  TranscriptReference: ({ children }: any) => React.createElement('Text', {}, children),
}));
vi.mock('./MonoMarkdown', () => ({ MonoMarkdown: ({ markdown }: any) => React.createElement('Text', {}, markdown) }));

import { Platform } from 'react-native';
import { ViewerConversationDock } from './ViewerConversationDock';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: any;
const send = vi.fn(async () => true);
const reply = (id: string, text: string) => ({
  id, text, presentation: 'message', author: { kind: 'agent', handle: 'moth', name: 'Moth' },
}) as RoomViewMessage;
const publish = (messages: RoomViewMessage[]) => act(() => publishViewerConversation({
  roomId: 'viewer-test', messages, send,
}));
const node = (testID: string) => renderer.root.findByProps({ testID });
const composer = () => renderer.root.findByType('Composer');
const toggle = () => act(() => node('viewer-conversation-toggle').props.onPress());
const type = (text: string) => act(() => composer().props.onChangeText(text));
const transcriptText = () => node('viewer-conversation-transcript').findAllByType('Text')
  .map((text: any) => text.props.children).flat(Infinity);

beforeEach(() => {
  (Platform as { OS: string }).OS = 'android';
  keyboard.height = 0;
  vi.useFakeTimers();
  scrollToEnd.mockClear();
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
  send.mockReset().mockResolvedValue(true);
  publish([reply('old', 'Earlier Room history')]);
  act(() => { renderer = create(<ViewerConversationDock kind="artifact" title="Checkout" roomId="viewer-test" />, { createNodeMock: (element: any) => element.type === 'ScrollView' ? { scrollToEnd } : null }); });
});
afterEach(() => {
  act(() => renderer.unmount());
  removeViewerConversation('viewer-test');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('keeps an unsent draft in the composer without revealing the transcript', () => {
  toggle();
  expect(renderer.root.findAllByProps({ testID: 'viewer-conversation-transcript' })).toHaveLength(0);
  type('First line\nSecond line\nThird line');
  expect(renderer.root.findAllByProps({ testID: 'viewer-conversation-transcript' })).toHaveLength(0);
  expect(send).not.toHaveBeenCalled();
});

it('keeps the pill and sent transcript expanded until the conversation toggle is tapped', async () => {
  toggle();
  type('Please simplify checkout');
  await act(async () => { expect(await composer().props.onSend()).toBe(true); });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'Please simplify checkout', agentHandle: 'moth' }), undefined);
  expect(node('viewer-conversation-toggle').props.accessibilityState.expanded).toBe(true);
  expect(composer().props.value).toBe('');
  expect(transcriptText()).toContain('Please simplify checkout');
  publish([reply('old', 'Earlier Room history'), reply('new', 'Here is the simpler checkout')]);
  expect(transcriptText()).toContain('Here is the simpler checkout');
  toggle();
  expect(renderer.root.findAllByType('Composer')).toHaveLength(0);
  expect(renderer.root.findAllByProps({ testID: 'viewer-conversation-transcript' })).toHaveLength(0);
  publish([reply('old', 'Earlier Room history'), reply('new', 'Here is the simpler checkout'), reply('next', 'One more reply')]);
  expect(transcriptText()).toContain('One more reply');
});

it('ignores unrelated replies while the browser keyboard or composer is used without sending', () => {
  act(() => renderer.update(<ViewerConversationDock kind="computer" title="Checkout" roomId="viewer-test" />));
  for (const event of ['keyboardDidShow', 'keyboardDidHide']) {
    act(() => { for (const listener of keyboardListeners.get(event) ?? []) listener(); });
    expect(renderer.root.findAllByType('Composer')).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'viewer-conversation-transcript' })).toHaveLength(0);
  }
  publish([reply('old', 'Earlier Room history'), reply('new', 'A fresh reply')]);
  expect(renderer.root.findAllByProps({ testID: 'viewer-conversation-transcript' })).toHaveLength(0);
  toggle();
  type('Unsent thought');
  act(() => composer().props.onFocus());
  act(() => composer().props.onBlur());
  toggle();
  expect(renderer.root.findAllByProps({ testID: 'viewer-conversation-transcript' })).toHaveLength(0);
  expect(send).not.toHaveBeenCalled();
});

it('shows a reply to a sent message in the ticker while the pill is collapsed', async () => {
  toggle();
  type('Please check this');
  await act(async () => { await composer().props.onSend(); });
  toggle();
  publish([reply('old', 'Earlier Room history'), reply('new', 'A fresh reply')]);
  expect(transcriptText()).toContain('A fresh reply');
  expect(node('viewer-conversation-toggle').props.accessibilityState.expanded).toBe(false);
  expect(renderer.root.findAllByType('Composer')).toHaveLength(0);
  act(() => vi.advanceTimersByTime(6000));
  expect(renderer.root.findAllByProps({ testID: 'viewer-conversation-transcript' })).toHaveLength(0);
  toggle();
  expect(transcriptText()).toContain('A fresh reply');
});

it('retains the draft and expanded pill when delivery fails', async () => {
  send.mockResolvedValue(false);
  toggle();
  type('Try again');
  await act(async () => { expect(await composer().props.onSend()).toBe(false); });
  expect(composer().props.value).toBe('Try again');
  expect(node('viewer-conversation-toggle').props.accessibilityState.expanded).toBe(true);
});

it('retains a reply that arrives before the composer send returns', async () => {
  let finish!: (sent: boolean) => void;
  send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  toggle();
  type('Please check this');
  let pending!: Promise<boolean>;
  act(() => { pending = composer().props.onSend(); });
  publish([reply('old', 'Earlier Room history'), reply('fast', 'Checked it')]);
  expect(transcriptText()).toContain('Checked it');
  await act(async () => { finish(true); await pending; });
  expect(transcriptText()).toContain('Please check this');
});

it('grows with content and stops at the existing maximum', () => {
  toggle();
  type('First line\nSecond line\nThird line');
  act(() => composer().props.onContentSizeChange({ nativeEvent: { contentSize: { height: 64 } } }));
  expect(composer().props.height).toBe(64);
  act(() => composer().props.onContentSizeChange({ nativeEvent: { contentSize: { height: 1000 } } }));
  expect(composer().props.height).toBe(120);
});

it('keeps a browser conversation open after sending its captured screen', async () => {
  const captureScreen = vi.fn(async () => 'screen-base64');
  act(() => renderer.update(<ViewerConversationDock kind="computer" title="Checkout" roomId="viewer-test" agentHandle="moth" captureScreen={captureScreen} />));
  toggle();
  type('Please check this screen');
  await act(async () => { expect(await composer().props.onSend()).toBe(true); });
  expect(captureScreen).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ screenshotBase64: 'screen-base64', context: 'Viewing browser: Checkout' }), undefined);
  expect(node('viewer-conversation-toggle').props.accessibilityState.expanded).toBe(true);
  expect(transcriptText()).toContain('Please check this screen');
});


it('recomputes the expanded transcript cap on rotation and preserves the collapsed preview', async () => {
  toggle();
  type('Explain the artifact');
  await act(async () => { await composer().props.onSend(); });
  publish([reply('long', '**Bold**\n\n' + '- A long line of explanation\n'.repeat(120))]);
  expect(node('viewer-conversation-transcript').props.style).toContainEqual({ maxHeight: 320 });
  expect(node('viewer-conversation-scroll').props.keyboardShouldPersistTaps).toBe('handled');
  dimensions.height = 390;
  act(() => renderer.update(<ViewerConversationDock kind="artifact" title="Checkout" roomId="viewer-test" />));
  expect(node('viewer-conversation-transcript').props.style).toContainEqual({ maxHeight: 156 });
  toggle();
  publish([reply('long', 'long reply'), reply('ticker', '**Raw preview**')]);
  expect(renderer.root.findAllByProps({ testID: 'viewer-conversation-scroll' })).toHaveLength(0);
  expect(node('viewer-conversation-transcript').findAllByType('Text').filter((n: any) => n.props.numberOfLines === 2)).toHaveLength(2);
  dimensions.height = 800;
});


it('waits for a native frame before following new transcript content', async () => {
  toggle();
  type('Explain the artifact');
  await act(async () => { await composer().props.onSend(); });
  act(() => node('viewer-conversation-scroll').props.onContentSizeChange(300, 4000));
  expect(scrollToEnd).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(16));
  expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
});

it('R1 lifts the focused dock and bounds the transcript, then restores its resting offset', async () => {
  const bottom = () => node('viewer-conversation-pill').props.style[1].bottom;
  toggle();
  type('Please check this');
  await act(async () => { await composer().props.onSend(); });
  expect(bottom()).toBe(12);
  act(() => { keyboard.height = 420; composer().props.onFocus(); });
  expect(bottom()).toBe(432);
  const panelStyle = Object.assign({}, ...node('viewer-conversation-transcript').props.style);
  expect(panelStyle.bottom).toBe(485);
  expect(panelStyle.maxHeight).toBe(279);
  act(() => { keyboard.height = 0; composer().props.onChangeText('Keyboard dismissed'); });
  expect(bottom()).toBe(12);
});

it('does not lift an unfocused viewer for the browser keyboard', () => {
  toggle();
  act(() => { keyboard.height = 300; composer().props.onChangeText('Draft'); });
  expect(node('viewer-conversation-pill').props.style[1].bottom).toBe(12);
});

it.each(['ios', 'web'])('handles keyboard height on %s', (platform) => {
  (Platform as { OS: string }).OS = platform;
  toggle();
  act(() => { keyboard.height = 300; composer().props.onFocus(); });
  expect(node('viewer-conversation-pill').props.style[1].bottom).toBe(platform === 'web' ? 12 : 312);
});

it.each(['artifact', 'computer'] as const)('offers no file picker in the %s viewer', (kind) => {
  act(() => renderer.update(<ViewerConversationDock kind={kind} title="Checkout" roomId="viewer-test" />));
  toggle();
  expect(composer().props.onAttach).toBeUndefined();
  expect(composer().props.attachments).toBeUndefined();
});

it('uses one outer border and the shared bubble in both toggle states', () => {
  const pill = node('viewer-conversation-pill').props.style[0];
  expect(pill.borderWidth).toBe(1);
  const closed = node('viewer-conversation-toggle');
  expect(closed.props.style[0].borderWidth).toBe(0);
  expect(closed.props.style[0].height + 2 * pill.borderWidth).toBe(44);
  expect(closed.props.style[0].width + 2 * pill.borderWidth).toBe(44);
  const closedColor = closed.props.icon.props.color;
  expect(closed.props.icon.props.size).toBeUndefined();
  toggle();
  const opened = node('viewer-conversation-toggle');
  expect(opened.props.style[1].borderRightWidth).toBe(1);
  expect(opened.props.style[1].borderRightColor).toBe(pill.borderColor);
  expect(opened.props.icon.props.color).not.toBe(closedColor);
});


it.each(['artifact', 'computer'] as const)('does not lift the %s dock twice inside a keyboard-avoiding modal', async (kind) => {
  act(() => renderer.update(<ViewerConversationDock keyboardAvoidedByParent kind={kind} title="Checkout" roomId="viewer-test" />));
  toggle();
  type('Explain this viewer');
  await act(async () => { await composer().props.onSend(); });
  const bottom = () => node('viewer-conversation-pill').props.style[1].bottom;
  const restingBottom = kind === 'computer' ? 66 : 12;
  expect(bottom()).toBe(restingBottom);
  act(() => { keyboard.height = 420; composer().props.onFocus(); });
  // The modal supplies the 420-point displacement. Adding it here again
  // leaves a keyboard-sized gap between the pill and the keyboard.
  expect(bottom()).toBe(12);
  const panel = Object.assign({}, ...node('viewer-conversation-transcript').props.style);
  expect(panel.bottom).toBe(65);
  expect(panel.maxHeight).toBe(279);
  act(() => { keyboard.height = 0; composer().props.onChangeText('Keyboard dismissed'); });
  expect(bottom()).toBe(restingBottom);
});
