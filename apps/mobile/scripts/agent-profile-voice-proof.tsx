import React, { useEffect, useRef, useState } from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { View, Text, ScrollView } from 'react-native';
import { AgentProfileView } from '../sources/components/buzz/AgentProfileView';
import { SettingsRow } from '../sources/components/buzz/SettingsRow';
import { Button } from '../sources/components/buzz/Button';
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
function VoiceMock() {
  const initial = voices[second ? 1 : 0]!;
  const [current, setCurrent] = useState(initial.id);
  const [draft, setDraft] = useState(initial.id);
  const [open, setOpen] = useState(params.get('state') === 'picker');
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    audio.current?.pause();
    if (timer.current) clearTimeout(timer.current);
    setPlaying(null);
  };
  useEffect(
    () => () => {
      audio.current?.pause();
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (params.get('state') === 'picker')
      setTimeout(() => {
        const section = document.querySelector('[data-testid="voice-section"]');
        const scroll = document.querySelector('[data-testid="agent-profile-scroll"]');
        if (section && scroll)
          scroll.scrollTop +=
            section.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      }, 300);
  }, []);
  const preview = async (voice: (typeof voices)[number]) => {
    if (playing === voice.id) {
      stop();
      return;
    }
    stop();
    setError(false);
    const player = new Audio(voice.sample ?? '');
    audio.current = player;
    player.onended = stop;
    player.onerror = () => {
      stop();
      setError(true);
    };
    setPlaying(voice.id);
    try {
      await player.play();
      timer.current = setTimeout(stop, 8000);
    } catch {
      stop();
      setError(true);
    }
  };
  const selected = voices.find((v) => v.id === current)!;
  return (
    <View style={{ paddingTop: theme.space.lg, gap: theme.space.md }} testID="voice-section">
      <Text style={{ ...theme.type.sectionHead, color: theme.textMuted }}>VOICE</Text>
      <SettingsRow
        title={selected.name}
        description="Fish · Workspace voice provider"
        action="Change"
        onPress={() => {
          stop();
          setDraft(current);
          setOpen((v) => !v);
        }}
        testID="change-agent-voice"
        accessibilityLabel={`Current voice ${selected.name}. Change voice`}
      />
      {open && (
        <>
          <Text style={{ ...theme.type.meta, color: theme.ledgerQuiet }}>
            Choose a voice for @{detail.agent.identity.handle}
          </Text>
          <ScrollView style={{ maxHeight: 320 }} testID="voice-library">
            {voices.map((voice) => (
              <SettingsRow
                key={voice.id}
                title={voice.name}
                description={draft === voice.id ? 'Selected' : 'Public licensed library voice'}
                onPress={() => setDraft(voice.id)}
                testID={`voice-option-${voice.id}`}
                value={playing === voice.id ? 'Stop' : '▶ Play'}
                valueTone={draft === voice.id ? 'accent' : undefined}
                trailingPress={{
                  onPress: () => void preview(voice),
                  accessibilityLabel: `${playing === voice.id ? 'Stop' : 'Preview'} ${voice.name}`,
                  testID: `preview-${voice.id}`,
                }}
              />
            ))}
          </ScrollView>
          {error && (
            <Text
              style={{ ...theme.type.meta, color: theme.ledgerQuiet }}
              accessibilityRole="alert"
            >
              Preview unavailable. Try again.
            </Text>
          )}
          <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
            <Button
              label="Cancel"
              variant="secondary"
              onPress={() => {
                stop();
                setOpen(false);
              }}
            />
            <Button
              label="Save voice"
              variant="brass"
              onPress={() => {
                stop();
                setCurrent(draft);
                setOpen(false);
              }}
              testID="save-agent-voice"
            />
          </View>
        </>
      )}
    </View>
  );
}
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
        {...{ mockVoice: <VoiceMock /> }}
      />
    </View>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
