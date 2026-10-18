import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { View: host('View'), Text: host('Text'), Pressable: host('Pressable') };
});
import { VoiceCallCard } from './VoiceCallCard';

it('renders the committed ended line with its workspace exhaustion reason', async () => {
  const text = "Call ended · 3:00 · Today's 60 minutes are used";
  let renderer: any;
  await act(async () => { renderer = create(<VoiceCallCard
    call={{ id: 'call', roomId: 'room', startedAt: 100, endedAt: 280, participants: [] }}
    text={text} joined={false} onJoin={vi.fn()} />); });
  try {
    expect(renderer.root.findByProps({ testID: 'voice-call-ended' }).props.children).toBe(text);
    expect(renderer.root.findAllByProps({ testID: 'voice-call-join' })).toHaveLength(0);
  } finally { await act(async () => renderer.unmount()); }
});
