/** Production card, fonts and themes against the isolated built-server proof. */
import 'react-native-get-random-values';
import '../sources/unistyles';
import React, { useEffect, useState } from 'react';
import { registerRootComponent } from 'expo';
import { Platform, ScrollView, Text, View } from 'react-native';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import type { VaultSaveCard as Card } from '@beeline/api-contract/phone';
import { VaultSaveCard } from '../sources/components/buzz/VaultSaveCard';
import { Button } from '../sources/components/buzz/Button';
import { monolithSession } from '../sources/auth/monolith-session';

const origin = Platform.OS === 'web' ? 'http://127.0.0.1:43187' : 'http://10.0.2.2:43187';
monolithSession.fetch = (input, init) =>
  fetch(`${origin}${input.slice(input.indexOf('/v1/'))}`, {
    ...init,
    headers: { ...init?.headers, authorization: 'Bearer isolated-vault-proof-owner' },
  });
UnistylesRuntime.setTheme('bone');
function Proof() {
  const { theme } = useUnistyles();
  const [data, setData] = useState<{
    cardId: string;
    roomId: string;
    ownerId: string;
    card: Card;
  } | null>(null);
  const [other, setOther] = useState(false);
  const [fonts] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  useEffect(() => {
    void fetch(`${origin}/proof/card`)
      .then((response) => response.json())
      .then(setData);
  }, []);
  useEffect(() => {
    if (fonts) void SplashScreen.hideAsync();
  }, [fonts]);
  if (!fonts || !data) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.buzz.bgBase }}
        contentContainerStyle={{
          paddingTop: theme.buzz.space.xxl,
          paddingHorizontal: theme.buzz.space.md,
          paddingBottom: theme.buzz.space.xl,
          gap: theme.buzz.space.lg,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ ...theme.buzz.type.body, color: theme.buzz.textPrimary }}>
          Save to vault
        </Text>
        <View style={{ flexDirection: 'row', gap: theme.buzz.space.sm }}>
          <Button size="inline" label="Bone" onPress={() => UnistylesRuntime.setTheme('bone')} />
          <Button
            size="inline"
            label="Obsidian"
            onPress={() => UnistylesRuntime.setTheme('obsidian')}
          />
          <Button size="inline" label="Other member" onPress={() => setOther(!other)} />
        </View>
        <VaultSaveCard
          card={data.card}
          cardId={data.cardId}
          roomId={data.roomId}
          viewerId={other ? 'other' : data.ownerId}
          agentName="Jellybean"
        />
      </ScrollView>
    </GestureHandlerRootView>
  );
}
registerRootComponent(Proof);
