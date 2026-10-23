/** Local-only native/web proof. Metro adapters replace authenticated I/O. */
import 'react-native-get-random-values';
import './github-card-proof-theme';
import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { View, Text, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { RepositoryOnboardingCard } from '../sources/app/(app)/beeline/chat/RepositoryOnboardingCard';
import WorkspaceChoice from '../sources/app/(app)/beeline/community';
import { Button } from '../sources/components/buzz/Button';
import { viewer, setFixtureMode } from './github-card-proof-adapters';
const modes = ['Normal', 'Error', 'Linked', 'Workspace'] as const;
const initialMode = Platform.OS === 'web' ? new URLSearchParams(window.location.search).get('state') ?? 'Error' : 'Error';
setFixtureMode(initialMode);
const agentId = 'dd62e3931d7ba15199df4b9dc592dd948b5dd741104b5a24872569cfbe0fabd8';
const card = { id: 'fixture-card', roomId: 'fixture-room', agentId, requesterId: viewer, kind: 'repository' as const,
  canLink: true, state: 'install_missing' as const, status: 'open' as const, githubLinked: false,
  defaultName: 'beeline-notes', repositories: [], starters: [] };
const author = { pubkey: agentId, kind: 'agent' as const, name: 'Beebee', face: 'owl' };
function Proof() {
  const [mode, setMode] = useState(initialMode);
  const [bone, setBone] = useState(true);
  const { theme } = useUnistyles();
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!loaded) return null;
  return <SafeAreaProvider><View style={{ flex: 1, backgroundColor: theme.buzz.bgBase, paddingTop: 48 }}>
    <StatusBar style={bone ? 'dark' : 'light'} />
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16 }}>
      {modes.map(label => <Button key={label} label={label} variant="quiet" onPress={() => { setFixtureMode(label); setMode(label); }} />)}
      <Button label="Theme" variant="quiet" onPress={() => { UnistylesRuntime.setTheme(bone ? 'obsidian' : 'bone'); setBone(!bone); }} />
    </View>
    {mode === 'Workspace' ? <WorkspaceChoice /> : <View style={{ padding: 16 }}>
      <Text style={{ ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary, marginBottom: 24 }}>#general</Text>
      <RepositoryOnboardingCard key={mode} viewerId={viewer} author={author}
        card={mode === 'Linked' ? { ...card, status: 'settled', state: 'repo_linked', repository: 'lunchboxfortwo/beeline-notes', repositoryPrivate: true } : card} />
      {mode === 'Error' ? <RepositoryOnboardingCard card={{ ...card, id: 'other-card' }} viewerId={viewer} author={author} /> : null}
    </View>}
  </View></SafeAreaProvider>;
}
registerRootComponent(Proof);
