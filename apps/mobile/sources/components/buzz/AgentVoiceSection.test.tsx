import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { AgentVoiceCatalog } from '@beeline/api-contract/phone';
import { beelineThemes } from '@/buzz/groknight';
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', ScrollView: 'ScrollView' }));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: any) => factory({ buzz: beelineThemes.obsidian }),
    hairlineWidth: 1,
  },
  useUnistyles: () => ({ theme: { buzz: beelineThemes.obsidian } }),
}));
vi.mock('./VoicePreviewPlayer', () => ({ VoicePreviewPlayer: () => null }));
vi.mock('./SettingsRow', () => ({
  SettingsRow: (props: any) => React.createElement('Row', props),
}));
vi.mock('./Button', () => ({ Button: (props: any) => React.createElement('Button', props) }));
import { AgentVoiceSection } from './AgentVoiceSection';
const catalog = {
  provider: 'fish-s2.1-pro' as const,
  currentVoiceId: 'one',
  canChange: true,
  choices: [
    { id: 'one', name: 'One' },
    { id: 'two', name: 'Two' },
  ],
};
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
it('uses the saved server receipt, keeps failed drafts, and ignores stale preview responses after Cancel', async () => {
  let previewResolve!: (value: { url: string }) => void;
  const api = {
    read: vi.fn(async () => catalog),
    save: vi.fn(async (): Promise<AgentVoiceCatalog> => {
      throw Error('Another agent chose it');
    }),
    preview: vi.fn(
      () =>
        new Promise<{ url: string }>((resolve) => {
          previewResolve = resolve;
        }),
    ),
  };
  let renderer: any;
  await act(async () => {
    renderer = create(<AgentVoiceSection agentId="a" handle="agent" canEdit api={api} />);
  });
  await act(async () =>
    renderer.root.findByProps({ testID: 'change-agent-voice' }).props.onPress(),
  );
  await act(async () => renderer.root.findByProps({ testID: 'voice-option-two' }).props.onPress());
  await act(async () =>
    renderer.root.findByProps({ testID: 'voice-option-two' }).props.trailingPress.onPress(),
  );
  await act(async () =>
    renderer.root.findByProps({ testID: 'cancel-agent-voice' }).props.onPress(),
  );
  await act(async () => previewResolve({ url: 'https://platform.r2.fish.audio/sample.mp3' }));
  expect(renderer.root.findAllByProps({ testID: 'voice-library' })).toHaveLength(0);
  await act(async () =>
    renderer.root.findByProps({ testID: 'change-agent-voice' }).props.onPress(),
  );
  await act(async () => renderer.root.findByProps({ testID: 'voice-option-two' }).props.onPress());
  await act(async () => renderer.root.findByProps({ testID: 'save-agent-voice' }).props.onPress());
  await settle();
  expect(renderer.root.findByProps({ testID: 'voice-error' }).props.children).toBe(
    'Another agent chose it',
  );
  expect(renderer.root.findByProps({ testID: 'voice-option-two' }).props.description).toBe(
    'Selected',
  );
  api.save.mockImplementationOnce(async () => ({ ...catalog, currentVoiceId: 'two' }));
  await act(async () => renderer.root.findByProps({ testID: 'save-agent-voice' }).props.onPress());
  await settle();
  expect(renderer.root.findByProps({ testID: 'change-agent-voice' }).props.title).toBe('Two');
  expect(api.save).toHaveBeenCalledWith('fish-s2.1-pro', 'two');
  await act(async () => renderer.unmount());
});
it('keeps Save functional when the live profile echo arrives before the write receipt', async () => {
  let saveResolve!: (value: typeof catalog) => void;
  const api = {
    read: vi.fn(async () => catalog),
    save: () =>
      new Promise<typeof catalog>((resolve) => {
        saveResolve = resolve;
      }),
    preview: vi.fn(),
  };
  let renderer: any;
  await act(async () => {
    renderer = create(
      <AgentVoiceSection agentId="a" configVersion="1" handle="agent" canEdit api={api} />,
    );
  });
  await act(async () =>
    renderer.root.findByProps({ testID: 'change-agent-voice' }).props.onPress(),
  );
  await act(async () => renderer.root.findByProps({ testID: 'save-agent-voice' }).props.onPress());
  await act(async () =>
    renderer.update(
      <AgentVoiceSection agentId="a" configVersion="2" handle="agent" canEdit api={api} />,
    ),
  );
  await act(async () => saveResolve(catalog));
  expect(renderer.root.findAllByProps({ testID: 'voice-confirm-actions' })).toHaveLength(0);
  expect(renderer.root.findByProps({ testID: 'change-agent-voice' }).props.disabled).toBe(false);
  await act(async () => renderer.unmount());
});
it('keeps other members read-only even if a stale catalog grants a change', async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(
      <AgentVoiceSection
        agentId="a"
        handle="agent"
        canEdit={false}
        api={{ read: async () => catalog, save: vi.fn(), preview: vi.fn() }}
      />,
    );
  });
  expect(renderer.root.findByProps({ testID: 'change-agent-voice' }).props.onPress).toBeUndefined();
  await act(async () => renderer.unmount());
});
