import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RoomViewMessage } from '@beeline/api-contract/phone';
import { publishViewerConversation, removeViewerConversation } from '@/buzz/viewer-conversation';

const keyboardListeners = vi.hoisted(() => new Map<string, Set<() => void>>());
vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return {
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
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('./ConversationComposer', () => ({
  COMPOSER_SINGLE_LINE_INPUT_HEIGHT: 26,
  ConversationComposer: (props: any) => React.createElement('Composer', props),
}));
vi.mock('./TranscriptReference', () => ({
  ViewerConversationRing: () => null,
  TranscriptReference: ({ children }: any) => React.createElement('Text', {}, children),
}));
vi.mock('./AttachmentPickerSheet', () => ({ AttachmentPickerSheet: () => null }));

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
  vi.useFakeTimers();
  send.mockReset().mockResolvedValue(true);
  publish([reply('old', 'Earlier Room history')]);
  act(() => { renderer = create(<ViewerConversationDock kind="artifact" title="Checkout" roomId="viewer-test" />); });
});
afterEach(() => {
  act(() => renderer.unmount());
  removeViewerConversation('viewer-test');
  vi.useRealTimers();
});

it('keeps an unsent draft in the composer without revealing the transcript', () => {
  toggle();
  expect(renderer.root.findAllByProps({ testID: 'viewer-conversation-transcript' })).toHaveLength(0);
  type('First line\nSecond line\nThird line');
  expect(renderer.root.findAllByProps({ testID: 'viewer-conversation-transcript' })).toHaveLength(0);
  expect(send).not.toHaveBeenCalled();
});

it('keeps the pill and sent transcript expanded until the gold circle is tapped', async () => {
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
