import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { AgentProfileView } from '../sources/components/buzz/AgentProfileView';
import { beelineThemes } from '../sources/buzz/groknight';
import type { AgentDetailView } from '@beeline/buzz-client';
import voices from './agent-profile-voice-library.json';
// @ts-expect-error esbuild embeds the font as a data URL.
import font from '../sources/assets/fonts/SpaceGrotesk-Regular.ttf';

// @ts-expect-error esbuild embeds font assets.
import medium from '../sources/assets/fonts/SpaceGrotesk-Medium.ttf';
// @ts-expect-error esbuild embeds font assets.
import bold from '../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf';
// @ts-expect-error esbuild embeds font assets.
import mono from '../sources/assets/fonts/IBMPlexMono-Regular.ttf';

const params = new URLSearchParams(location.search);
const theme = beelineThemes[params.get('theme') === 'light' ? 'bone' : 'obsidian'];
const second = params.get('agent') === 'second';
const soul = second
  ? 'Patient and precise. Make complex ideas clear, ask good questions, and leave every conversation with a useful next step.'
  : 'Kind, proactive, and drawn to distant worlds. Investigate carefully, explain what matters, and see each piece of work through.';
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
  owner: { id: 'b'.repeat(64), name: 'Owner', handle: 'river' },
  selected: { model: 'gpt-6', effort: 'high' },
  catalog: [
    { id: 'model', category: 'model', options: [{ id: 'gpt-6', name: 'GPT-6' }] },
    { id: 'effort', category: 'reasoning_effort', options: [{ id: 'high', name: 'High' }] },
  ],
  seededSoul: soul,
  access: { policy: 'everyone', canChange: true },
  yolo: { enabled: true, canChange: true },
  recentWork: [],
  watchFilters: [],
} as unknown as AgentDetailView;
const style = document.createElement('style');
style.textContent = `@font-face{font-family:SpaceGrotesk-Regular;src:url(${font})}@font-face{font-family:SpaceGrotesk-Medium;src:url(${medium})}@font-face{font-family:SpaceGrotesk-SemiBold;src:url(${bold})}@font-face{font-family:IBMPlexMono-Regular;src:url(${mono})}body{margin:0;background:${theme.bgBase};color:${theme.textPrimary}}*{box-sizing:border-box}#root{height:100vh;display:flex}button:focus-visible,[role=button]:focus-visible{outline:2px solid ${theme.accent};outline-offset:2px}`;
document.head.appendChild(style);
Object.assign(globalThis, { __boardFixture: { agent: detail } });
// Only transport data is a fixture; the complete Profile/Voice controls are production components.
let currentVoiceId = voices[second ? 1 : 0]!.id;
const fixtureVoiceApi = {
  read: async () => ({
    provider: 'fish-s2.1-pro' as const,
    currentVoiceId,
    canChange: true,
    choices: voices.map((v) => ({ id: v.id, name: v.name, sampleUrl: v.sample ?? undefined })),
  }),
  save: async (_provider: import('@beeline/api-contract/phone').VoiceProvider, id: string) => {
    currentVoiceId = id;
    return fixtureVoiceApi.read();
  },
  preview: async (_provider: import('@beeline/api-contract/phone').VoiceProvider, id: string) => ({
    url: voices.find((v) => v.id === id)!.sample!,
  }),
};
function App() {
  const [editing, setEditing] = useState(params.get('state') === 'edit');
  const [name, setName] = useState(detail.agent.identity.name ?? '');
  const [soulDraft, setSoul] = useState(soul);
  const [savedSoul, setSavedSoul] = useState(soul);
  return (
    <View style={{ flex: 1 }}>
      <AgentProfileView
        detail={detail}
        loading={false}
        error={null}
        onRetry={() => undefined}
        onClose={() => undefined}
        onMessage={() => undefined}
        canManage={false}
        canEdit
        avatarDisabled={false}
        onGenerateAvatar={async () => undefined}
        refreshAgent={async () => detail}
        editing={editing}
        saving={false}
        nameDraft={name}
        soulDraft={soulDraft}
        onNameChange={setName}
        onSoulChange={setSoul}
        onEdit={() => setEditing(true)}
        onSave={() => {
          setSavedSoul(soulDraft);
          setEditing(false);
        }}
        onCancel={() => {
          setSoul(savedSoul);
          setEditing(false);
        }}
        soul={savedSoul}
        management={null}
        voiceApi={fixtureVoiceApi}
      />
    </View>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
if (params.get('state') === 'picker')
  setTimeout(() => {
    document.querySelector<HTMLElement>('[data-testid="change-agent-voice"]')?.click();
    setTimeout(() => {
      const section = document.querySelector('[data-testid="voice-section"]');
      const scroll = document.querySelector('[data-testid="agent-profile-scroll"]');
      if (section && scroll)
        scroll.scrollTop +=
          section.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    }, 200);
  }, 400);
