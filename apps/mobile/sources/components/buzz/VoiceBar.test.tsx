import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { VOICE_QUOTA_MESSAGE } from '@beeline/api-contract/phone';
vi.mock('react-native', () => {
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { View: host('View'), Text: host('Text'), ScrollView: host('ScrollView'), Pressable: host('Pressable'),
    AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) } };
});
vi.mock('./IdentityMark', () => ({ IdentityMark: () => null }));
vi.mock('./MicGlyph', () => ({ MicGlyph: () => null }));
vi.mock('./BeelineMarkSpinner', () => ({ BeelineMarkSpinner: () => null }));
vi.mock('./DictationWaveform', () => ({ DictationWaveform: () => React.createElement('Waveform') }));
vi.mock('./HullDialog', () => ({ HullModal: () => null }));
import { VoiceBar } from './VoiceBar';

it('shows the exhausted daily quota inside the voice bar with an operable end mic', async () => {
  const end = vi.fn(); let renderer: any;
  await act(async () => { renderer = create(<VoiceBar voice={{ call: null, agents: [], target: null,
    speaker: null, level: 0, connecting: false, error: VOICE_QUOTA_MESSAGE, quotaExhausted: true, budgetWarning: null,
    firstAudioMs: null, humans: 1, unaddressed: 0, join: vi.fn(), end, aim: vi.fn() }} />); });
  expect(renderer.root.findByProps({ testID: 'voice-quota-error' }).props.children).toBe(VOICE_QUOTA_MESSAGE);
  expect(renderer.root.findAllByType('Waveform')).toHaveLength(0);
  await act(async () => renderer.root.findByProps({ testID: 'voice-mic' }).props.onPress());
  expect(end).toHaveBeenCalledOnce();
  await act(async () => renderer.unmount());
});

it('keeps a readable join error and agent avatars visible with an operable end control', async () => {
  const end = vi.fn(), aim = vi.fn(); let renderer: any;
  const error = 'Conversation mode could not connect.';
  await act(async () => { renderer = create(<VoiceBar voice={{ call: null,
    agents: [{ pubkey: 'ruby', kind: 'agent', name: 'Ruby' }, { pubkey: 'goose', kind: 'agent', name: 'Goosey' }],
    target: null, speaker: null, level: 0, connecting: false, error, quotaExhausted: false, budgetWarning: null,
    firstAudioMs: null, humans: 1, unaddressed: 0, join: vi.fn(), end, aim }} />); });
  try {
    expect(renderer.root.findByProps({ testID: 'voice-connection-error' }).props.children).toBe(error);
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Speak to Goosey' }).props.onPress());
    expect(aim).toHaveBeenCalledWith('goose');
    await act(async () => renderer.root.findByProps({ testID: 'voice-mic' }).props.onPress());
    expect(end).toHaveBeenCalledOnce();
  } finally { await act(async () => renderer.unmount()); }
});

it.each([1, 2])('uses the existing warning slot for %s humans and prioritizes call ending', async humans => {
  const voice = { call: null, agents: [], target: null, speaker: null, level: 0, connecting: false,
    error: null, quotaExhausted: false, budgetWarning: '2 min left today', firstAudioMs: null, humans, unaddressed: 0, join: vi.fn(), end: vi.fn(), aim: vi.fn() };
  let renderer: any;
  await act(async () => { renderer = create(<VoiceBar voice={voice} />); });
  const id = humans > 1 ? 'conversation-tip' : 'conversation-mode-label';
  expect(renderer.root.findByProps({ testID: id }).props.children).toBe('2 min left today');
  expect(renderer.root.findByProps({ testID: id }).props.accessibilityLiveRegion).toBe('polite');
  expect(renderer.root.findAllByProps({ testID: 'voice-budget-warning' })).toHaveLength(0);
  await act(async () => renderer.update(<VoiceBar voice={{ ...voice, endingWarning: 'Ending in 15s' }} />));
  expect(renderer.root.findByProps({ testID: id }).props.children).toBe('Ending in 15s');
  await act(async () => renderer.unmount());
});
