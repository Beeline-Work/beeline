import { registerRootComponent } from 'expo';
import React from 'react';
import { ScrollView } from 'react-native';
import { useFonts } from 'expo-font';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { PageHeader } from '../sources/components/buzz/PageHeader';
import { AgentUsageSection } from '../sources/components/buzz/AgentUsageSection';
import { beelineThemes } from '../sources/buzz/groknight';
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
  });
  if (!loaded) return null;
  const now = Date.now() / 1000;
  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: beelineThemes.obsidian.bgBase }}>
        <ScrollView>
          <PageHeader title="Profile" />
          <AgentUsageSection
            harness="claude"
            usage={{
              updatedAt: now,
              windows: [
                {
                  rateLimitType: 'five_hour',
                  status: 'allowed',
                  utilization: 0.42,
                  resetsAt: now + 3600,
                  updatedAt: now,
                },
                {
                  rateLimitType: 'seven_day',
                  status: 'allowed',
                  utilization: 0.83,
                  resetsAt: now + 86400 * 3,
                  updatedAt: now,
                },
                {
                  rateLimitType: 'seven_day_opus',
                  status: 'allowed',
                  utilization: 0.18,
                  resetsAt: now + 86400 * 3,
                  updatedAt: now,
                },
              ],
              context: { used: 612000, size: 1000000 },
            }}
          />
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
registerRootComponent(Proof);
