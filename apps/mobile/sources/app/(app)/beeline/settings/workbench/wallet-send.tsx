import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useLocalSearchParams } from 'expo-router';
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
  return (
    <View style={styles.container} testID="wallet-send-screen">
      <WalletSendForm workspaceId={workspaceId} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, padding: theme.buzz.space.md, gap: theme.buzz.space.xs },
}));
