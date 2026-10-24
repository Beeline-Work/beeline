import WorkbenchScreen from '../sources/app/(app)/beeline/settings/workbench';
import ConnectorServiceScreen from '../sources/app/(app)/beeline/settings/workbench/service';
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import ConnectAppScreen, {
  ConnectorsSearchSheet,
} from '../sources/app/(app)/beeline/settings/workbench/connect-app';
import { RoomListSectionHeader } from '../sources/components/buzz/RoomListSectionHeader';
import { beelineThemes } from '../sources/buzz/groknight';
import { proofTheme, proofSurface } from './settings';
import { RepoPicker } from '../sources/components/buzz/RepoPicker';
const theme = beelineThemes[proofTheme];
const view = {
  companies: {
    suggestions: [
      {
        appKey: 'github',
        name: 'GitHub',
        domain: 'github.com',
        purpose: 'Work with repositories and issues.',
      },
      {
        appKey: 'slack',
        name: 'Slack',
        domain: 'slack.com',
        purpose: 'Read conversations and send messages.',
      },
    ],
  },
};
export default function App() {
  const [visible, setVisible] = React.useState(true);
  const [fonts] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!fonts) return null;
  if (proofSurface === 'workbench')
    return (
      <SafeAreaProvider>
        <WorkbenchScreen />
      </SafeAreaProvider>
    );
  if (proofSurface === 'service')
    return (
      <SafeAreaProvider>
        <ConnectorServiceScreen />
      </SafeAreaProvider>
    );
  if (proofSurface === 'page')
    return (
      <SafeAreaProvider>
        <ConnectAppScreen />
      </SafeAreaProvider>
    );
  if (proofSurface === 'repos')
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: theme.bgBase, paddingTop: 64 }}>
          <View
            style={{
              margin: 16,
              padding: 8,
              borderWidth: 1,
              borderColor: theme.borderStrong,
              backgroundColor: theme.bgHighlight,
            }}
          >
            <Text style={{ ...theme.type.sectionHead, color: theme.textPrimary }}>
              THIS ROOM ISN’T LINKED TO A REPO
            </Text>
            <RepoPicker
              candidates={Array.from({ length: 12 }, (_, i) => ({
                key: `repo-${i}`,
                name: `beeline-work/project-${i}`,
                remote: `https://github.com/beeline-work/project-${i}`,
                defaultBranch: 'main',
              }))}
              onSelect={() => {}}
              draftContext="proof"
            />
          </View>
        </View>
      </SafeAreaProvider>
    );
  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, paddingTop: 64, backgroundColor: theme.appCanvas }}>
        <Pressable onPress={() => setVisible(true)}>
          <Text style={{ ...theme.type.hero, color: theme.textPrimary, padding: 16 }}>
            Connectors · Search
          </Text>
        </Pressable>
        <RoomListSectionHeader title="Suggested" inset="content" spacing="flush" />
        <View style={{ margin: 16, padding: 16, backgroundColor: theme.bgHighlight }}>
          <RoomListSectionHeader title="Repositories" inset="content" spacing="flush" />
        </View>
        <ConnectorsSearchSheet
          visible={visible}
          onClose={() => setVisible(false)}
          scope={{ workspaceId: 'fixture', viewerId: 'fixture' }}
          view={view as any}
        />
      </View>
    </SafeAreaProvider>
  );
}
