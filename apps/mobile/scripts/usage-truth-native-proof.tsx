/** Release fixture for the Usage truth mock: the production AgentUsageSection
 * in its five states (fresh, refreshing, read failed, sign-in expired, machine
 * offline). Register this entry temporarily. "Next state" cycles the states;
 * "Theme" switches Bone and Obsidian. Each state answers its refresh the way
 * the server does for that case.
 */
import '../sources/unistyles';
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import type { AgentUsage, UsageRefreshOutcome } from '@beeline/api-contract/phone';
import { AgentUsageSection } from '../sources/components/buzz/AgentUsageSection';

UnistylesRuntime.setTheme('bone');
const now = Date.now() / 1000;
const today = (hour: number, minute: number) => {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.getTime() / 1000;
};
const morning = Math.min(today(9, 2), now - 3600);
const numbers = (at: number): Pick<AgentUsage, 'windows' | 'plan' | 'sharedWith' | 'machine'> => ({
  windows: [
    { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.14, resetsAt: now + 3 * 3600, updatedAt: at, label: 'session' },
    { rateLimitType: 'seven_day', status: 'allowed', utilization: 0.28, resetsAt: now + 3 * 86_400, updatedAt: at, label: 'week' },
    { rateLimitType: 'model_fable', status: 'allowed', utilization: 0, resetsAt: now + 3 * 86_400, updatedAt: at, label: 'Fable week' },
  ],
  plan: 'max',
  sharedWith: ['Jellybean', 'Nerd'],
  machine: 'squire',
});
const STATES: Array<{ title: string; usage: AgentUsage; answer?: UsageRefreshOutcome }> = [
  { title: '1. Fresh', usage: { updatedAt: now - 60, ...numbers(now - 60), read: { status: 'fresh', at: now - 60 } }, answer: { status: 'fresh' } },
  { title: '2. Refreshing', usage: { updatedAt: now - 5 * 60, ...numbers(now - 5 * 60), read: { status: 'fresh', at: now - 5 * 60 } } },
  {
    title: '3. Read failed',
    usage: { updatedAt: morning, ...numbers(morning), read: { status: 'rate_limited', at: now - 30, retryAfter: now + 6 * 60 } },
    answer: { status: 'rate_limited', retryAfter: now + 6 * 60 },
  },
  {
    title: '4. Sign-in expired',
    usage: { updatedAt: morning, ...numbers(morning), read: { status: 'signed_out', at: now - 30 } },
    answer: { status: 'signed_out' },
  },
  { title: '5. Machine offline', usage: { updatedAt: morning, ...numbers(morning), read: { status: 'fresh', at: morning } }, answer: { status: 'offline' } },
];

function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const { theme } = useUnistyles();
  const [index, setIndex] = useState(0);
  const [light, setLight] = useState(true);
  const state = STATES[index % STATES.length]!;
  if (!loaded) return null;
  const button = (label: string, onPress: () => void) => (
    <Pressable onPress={onPress} style={{ padding: 12, borderWidth: 1, borderColor: theme.buzz.border, borderRadius: theme.buzz.radius }}>
      <Text style={{ color: theme.buzz.textPrimary }}>{label}</Text>
    </Pressable>
  );
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.buzz.bgBase }} contentContainerStyle={{ paddingTop: 64, paddingHorizontal: 16 }}>
      <Text style={{ color: theme.buzz.textPrimary, fontSize: 18 }} testID="state-title">{state.title}</Text>
      <AgentUsageSection
        key={`${index}-${light}`}
        usage={state.usage}
        harness="claude"
        onRefresh={() => (state.answer ? Promise.resolve(state.answer) : new Promise(() => undefined))}
      />
      <View style={{ flexDirection: 'row', gap: 12, marginTop: 32 }}>
        {button('Next state', () => setIndex((v) => v + 1))}
        {button('Theme', () => {
          UnistylesRuntime.setTheme(light ? 'obsidian' : 'bone');
          setLight((v) => !v);
        })}
      </View>
    </ScrollView>
  );
}
registerRootComponent(Proof);
