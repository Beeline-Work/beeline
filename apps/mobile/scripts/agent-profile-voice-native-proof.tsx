/** Release fixture: production Profile/Voice UI, synthetic DTOs, real Fish samples.
 * Register this entry temporarily. Back alternates themes; Message alternates agents.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { UnistylesRuntime } from 'react-native-unistyles';
import { AgentProfileView } from '../sources/components/buzz/AgentProfileView';
import type { AgentDetailView } from '@beeline/buzz-client';
import type { VoiceProvider } from '@beeline/api-contract/phone';
import voices from './agent-profile-voice-library.json';
const soul =
  'Kind, proactive, and drawn to distant worlds. Investigate carefully, explain what matters, and see each piece of work through.';
export default function NativeProfileProof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const [second, setSecond] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('Emberus');
  const [draft, setDraft] = useState(soul);
  const [savedSoul, setSoul] = useState(soul);
  const [light, setLight] = useState(false);
  useEffect(() => {
    UnistylesRuntime.setTheme('obsidian');
  }, []);
  const api = useMemo(() => {
    let current = voices[second ? 1 : 0]!.id;
    const catalog = () => ({
      provider: 'fish-s2.1-pro' as const,
      currentVoiceId: current,
      canChange: true,
      choices: voices.map((v) => ({ id: v.id, name: v.name, sampleUrl: v.sample ?? undefined })),
    });
    return {
      read: async () => catalog(),
      save: async (_provider: VoiceProvider, id: string) => {
        current = id;
        return catalog();
      },
      preview: async (_provider: VoiceProvider, id: string) => ({
        url: voices.find((v) => v.id === id)!.sample!,
      }),
    };
  }, [second]);
  const detail = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    agent: {
      identity: {
        pubkey: (second ? 'd' : 'e').repeat(64),
        kind: 'agent',
        name: second ? 'Milo' : 'Emberus',
        handle: second ? 'milo' : 'emberus',
        face: second ? 'fox' : 'owl',
      },
      role: 'member',
    },
    owner: { pubkey: 'b'.repeat(64), kind: 'human', name: 'River', handle: 'river' },
    selected: { model: 'gpt-6', effort: 'high' },
    catalog: [
      { id: 'model', category: 'model', options: [{ id: 'gpt-6', name: 'GPT-6' }] },
      { id: 'effort', category: 'reasoning_effort', options: [{ id: 'high', name: 'High' }] },
    ],
    access: { policy: 'everyone', canChange: true },
    yolo: { enabled: true, canChange: true },
    recentWork: [],
    watchFilters: [],
  } as unknown as AgentDetailView;
  if (!loaded) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style={light ? 'dark' : 'light'} />
      <SafeAreaProvider>
        <KeyboardProvider>
          <AgentProfileView
            detail={detail}
            loading={false}
            error={null}
            onRetry={() => undefined}
            onClose={() => {
              UnistylesRuntime.setTheme(light ? 'obsidian' : 'bone');
              setLight((v) => !v);
            }}
            onMessage={() => {
              setSecond((v) => !v);
              setEditing(false);
            }}
            canManage={false}
            canEdit
            avatarDisabled={false}
            onGenerateAvatar={async () => undefined}
            refreshAgent={async () => detail}
            editing={editing}
            saving={false}
            nameDraft={name}
            soulDraft={draft}
            onNameChange={setName}
            onSoulChange={setDraft}
            onEdit={() => setEditing(true)}
            onSave={() => {
              setSoul(draft);
              setEditing(false);
            }}
            onCancel={() => {
              setDraft(savedSoul);
              setEditing(false);
            }}
            soul={savedSoul}
            management={null}
            voiceApi={api}
          />
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
