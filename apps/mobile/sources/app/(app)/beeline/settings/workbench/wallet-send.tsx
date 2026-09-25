import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PageHeader } from '@/components/buzz/PageHeader';
import { WalletSendForm } from '@/buzz/wallet-send-form';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Send (mock §Screens 3–4) — the standalone route, now a thin wrapper over
 * the shared `WalletSendForm` the wallet dashboard's Send tab also renders.
 */
export default function WalletSendScreen() {
  const params = useLocalSearchParams<{ workspaceId?: string | string[] }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="wallet-send-screen">
      <PageHeader
        backAccessibilityLabel="Back to Wallet"
        eyebrow="Wallet"
        onBack={() => router.back()}
        testID="wallet-send-header"
        title="Send"
      />
      <View style={styles.body}>
        <WalletSendForm workspaceId={workspaceId} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.buzz.bgTerminal },
  body: { flex: 1, padding: theme.buzz.space.md, gap: theme.buzz.space.xs },
}));
