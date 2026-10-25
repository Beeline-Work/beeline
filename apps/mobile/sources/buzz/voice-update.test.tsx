import * as React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const openURL = vi.hoisted(() => vi.fn(async (_url: string) => {}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, Linking: { openURL }, View: 'View', Text: 'Text', Pressable: 'Pressable' }));
vi.mock('@/components/buzz/HullDialog', () => ({ HullDialog: (props: any) => React.createElement('HullDialog', props) }));
import { Modal } from '@/modal/ModalManager';
import { WebAlertModal } from '@/modal/components/WebAlertModal';
import { VoiceCallCard } from '@/components/buzz/VoiceCallCard';
import { showVoiceJoinError, VOICE_UPDATE_MESSAGE } from './voice-update';
import type { AlertModalConfig } from '@/modal/types';
beforeEach(() => openURL.mockReset().mockResolvedValue(undefined));
it.each([false, true])('iphone-022-gate: rendered Update opens the store (scheme failure: %s)', async failure => {
  let config!: AlertModalConfig;
  Modal.setFunctions(value => { config = { ...value, id: 'update' } as AlertModalConfig; return 'update'; }, () => {}, () => {});
  showVoiceJoinError(VOICE_UPDATE_MESSAGE);
  expect(config.message).toBe('Update Beeline in the App Store to join calls.');
  if (failure) openURL.mockRejectedValueOnce(new Error('Scheme unavailable'));
  let renderer: any;
  await act(async () => { renderer = create(<WebAlertModal config={config} onClose={() => {}} />); });
  try {
    const dialog = renderer.root.findByType('HullDialog');
    expect(dialog.props.body).toBe(config.message);
    expect(dialog.props.actions.map((action: any) => action.label)).toEqual(['OK', 'Update']);
    await act(async () => dialog.props.actions[1].onPress());
    expect(openURL.mock.calls.map(([url]) => url)).toEqual(failure
      ? ['itms-apps://apps.apple.com/app/id6803948500', 'https://apps.apple.com/app/id6803948500']
      : ['itms-apps://apps.apple.com/app/id6803948500']);
  } finally { await act(async () => renderer.unmount()); }
});
it('keeps ordinary call errors on the existing OK dialog', () => {
  const show = vi.fn(() => 'ordinary');
  Modal.setFunctions(show, () => {}, () => {});
  showVoiceJoinError('Microphone permission is required.');
  expect(show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Microphone permission is required.', buttons: [{ text: 'OK' }] }));
});
it('iphone-022-gate: joining from the header presents the update instruction in the existing dialog', async () => {
  const show = vi.fn(() => 'update');
  Modal.setFunctions(show, () => {}, () => {});
  let renderer: any;
  await act(async () => { renderer = create(<VoiceCallCard call={{ id: 'call', roomId: 'room', startedAt: 1, participants: [] } as any}
    joined={false} onJoin={() => showVoiceJoinError(VOICE_UPDATE_MESSAGE)} />); });
  try {
    await act(async () => renderer.root.findByProps({ testID: 'voice-call-join' }).props.onPress());
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Update Beeline in the App Store to join calls.' }));
  }
  finally { await act(async () => renderer.unmount()); }
});
