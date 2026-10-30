import React from 'react';
import { AppState, BackHandler, Linking, Platform, ScrollView, Text, View } from 'react-native';
import * as Application from 'expo-application';
import { StyleSheet } from 'react-native-unistyles';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { MobileMinimum, StorePlatform } from '@beeline/api-contract/mobile-minimum';
import { fetchStoreUpdate, STORE_LISTINGS } from '@/buzz/store-update';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { Button } from '@/components/buzz/Button';
import { BeelineGlyphPaint } from '@/components/buzz/BeelineGlyphPaint';

export function StoreUpdateScreen({ minimum, installed, platform }: {
  minimum: MobileMinimum; installed: string; platform: StorePlatform;
}) {
  return (
    <SafeAreaView style={styles.screen} testID="store-update-required">
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.column}>
          <View style={styles.mark}>
            <BeelineGlyphPaint size={44} framing="cell" loop="once" live={false} />
          </View>
        <View style={styles.copy}>
          <Text accessibilityRole="header" style={styles.title}>Update Beeline to keep going</Text>
          <Text style={styles.reason}>{minimum.reason}</Text>
          <Text style={styles.versions}>{installed} → {minimum.minVersion}</Text>
          <Button fullWidth destination="external" label={platform === 'android' ? 'Update on Google Play' : 'Update on the App Store'}
            style={styles.buttonSpacing}
            appearance={{ control: ({ pressed }) => [styles.button, pressed && styles.pressed], label: styles.buttonLabel }}
            onPress={() => { void Linking.openURL(STORE_LISTINGS[platform]).catch(() => {}); }} />
        </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/** Root replacement keeps sign-in, deep links and Android Back behind the gate. */
export function StoreUpdateGate({ children, fontsReady = true }: { children: React.ReactNode; fontsReady?: boolean }) {
  const [minimum, setMinimum] = React.useState<MobileMinimum | null>(null);
  React.useEffect(() => {
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return;
    let active = true;
    let generation = 0;
    const check = () => {
      const current = ++generation;
      void fetchStoreUpdate(getBuzzRuntimeConfig().monolithUrl, Platform.OS, Application.nativeApplicationVersion)
        .then(result => { if (active && current === generation) setMinimum(result); });
    };
    check();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') check(); });
    return () => { active = false; subscription.remove(); };
  }, []);
  React.useEffect(() => {
    if (!minimum || Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [minimum]);
  return fontsReady && minimum && (Platform.OS === 'android' || Platform.OS === 'ios')
    ? <StoreUpdateScreen minimum={minimum} installed={Application.nativeApplicationVersion!} platform={Platform.OS} />
    : <>{children}</>;
}

const styles = StyleSheet.create(({ buzz }) => ({
  screen: { flex: 1, backgroundColor: buzz.bgBase },
  content: { flexGrow: 1, padding: buzz.space.lg },
  column: { flexGrow: 1, width: '100%', maxWidth: 400, alignSelf: 'center' },
  mark: { marginBottom: 'auto', paddingTop: buzz.space.lg, paddingBottom: buzz.space.xxl },
  copy: { gap: buzz.space.sm },
  title: { ...buzz.type.hero, color: buzz.textPrimary },
  reason: { ...buzz.type.body, color: buzz.textSecondary },
  versions: { ...buzz.type.machine, color: buzz.textMuted, marginTop: buzz.space.sm },
  buttonSpacing: { marginTop: buzz.space.md },
  button: { minHeight: 44, paddingHorizontal: buzz.space.md, paddingVertical: buzz.space.sm,
    alignItems: 'center', justifyContent: 'center', borderRadius: buzz.radius, backgroundColor: buzz.accent },
  buttonLabel: { ...buzz.type.bodyStrong, color: buzz.bgBase },
  pressed: { opacity: 0.85 },
}));
