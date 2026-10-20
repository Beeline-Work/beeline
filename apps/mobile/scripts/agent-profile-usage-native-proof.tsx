/** Release fixture for Reproductions R1 and R2: the production Profile for an
 * owned agent with no merged work. Register this entry temporarily. Message
 * cycles a Codex agent and a Cursor agent carrying the usage a real quota-axi
 * read produced on squire through HarnessQuotaReader (2026-10-20), then a
 * Codex agent with no usage snapshot. Back alternates themes.
 */
import '../sources/unistyles';
import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useFonts } from 'expo-font';
import { UnistylesRuntime } from 'react-native-unistyles';
import { AgentProfileView } from '../sources/components/buzz/AgentProfileView';
import type { AgentDetailView } from '@beeline/buzz-client';

UnistylesRuntime.setTheme('obsidian');
// Read at 2026-10-20T02:28Z; shifted so the fixture always reads as fresh.
const READ = {"codex": {"updatedAt": 1792463287.358, "windows": [{"rateLimitType": "weekly", "status": "allowed", "utilization": 0.48, "resetsAt": 1792874591, "updatedAt": 1792463287.358, "label": "week"}], "plan": "pro", "credits": {"remaining": 62174.920478}}, "cursor": {"updatedAt": 1792463287.851, "windows": [{"rateLimitType": "included_usage", "status": "allowed", "utilization": 0, "resetsAt": 1795094859, "updatedAt": 1792463287.851, "label": "included usage"}, {"rateLimitType": "auto_usage", "status": "allowed", "utilization": 0.01, "resetsAt": 1795094859, "updatedAt": 1792463287.851, "label": "auto usage"}, {"rateLimitType": "api_usage", "status": "allowed", "utilization": 0, "resetsAt": 1795094859, "updatedAt": 1792463287.851, "label": "API usage"}, {"rateLimitType": "grok_bot", "status": "allowed", "utilization": 0, "resetsAt": 1792848465.964, "updatedAt": 1792463287.851, "label": "Grok Bot"}], "plan": "Ultra"}} as const;
const fresh = (usage: (typeof READ)['codex'] | (typeof READ)['cursor']) => {
  const shift = Date.now() / 1000 - usage.updatedAt;
  return {
    ...usage,
    updatedAt: usage.updatedAt + shift,
    windows: usage.windows.map((w) => ({ ...w, updatedAt: w.updatedAt + shift })),
  };
};
const AGENTS = [
  { name: 'Jellybean', handle: 'jellybean', face: 'owl', harness: 'codex', model: ['gpt-6.1-sol', '6.1 Sol'], usage: () => fresh(READ.codex) },
  { name: 'Kit', handle: 'kit', face: 'fox', harness: 'cursor', model: ['auto', 'Auto'], usage: () => fresh(READ.cursor) },
  { name: 'Nerd', handle: 'nerd', face: 'cat', harness: 'codex', model: ['gpt-6.1-sol', '6.1 Sol'], usage: () => undefined },
] as const;
const soul = 'Investigate carefully, explain what matters, and see each piece of work through.';

function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const [index, setIndex] = useState(0);
  const agent = AGENTS[index % AGENTS.length]!;
  const [light, setLight] = useState(false);
  const detail = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    agent: {
      identity: {
        pubkey: String(index % AGENTS.length).repeat(64),
        kind: 'agent',
        name: agent.name,
        handle: agent.handle,
        face: agent.face,
      },
      role: 'member',
    },
    owner: { pubkey: 'b'.repeat(64), kind: 'human', name: 'River', handle: 'river' },
    harness: agent.harness,
    usage: agent.usage(),
    selected: { model: agent.model[0], effort: 'high' },
    catalog: [
      { id: 'model', category: 'model', options: [{ id: agent.model[0], name: agent.model[1] }] },
      { id: 'effort', category: 'reasoning_effort', options: [{ id: 'high', name: 'High' }] },
    ],
    access: { policy: 'owner', canChange: true },
    yolo: { enabled: false, canChange: true },
    recentWork: [],
    watchFilters: [],
  } as unknown as AgentDetailView;
  if (!loaded) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
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
            onMessage={() => setIndex((v) => v + 1)}
            canManage={false}
            canEdit
            avatarDisabled={false}
            onGenerateAvatar={async () => undefined}
            refreshAgent={async () => detail}
            editing={false}
            saving={false}
            nameDraft={detail.agent.identity.name}
            soulDraft={soul}
            onNameChange={() => undefined}
            onSoulChange={() => undefined}
            onEdit={() => undefined}
            onSave={() => undefined}
            onCancel={() => undefined}
            soul={soul}
            management={null}
          />
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
registerRootComponent(Proof);
