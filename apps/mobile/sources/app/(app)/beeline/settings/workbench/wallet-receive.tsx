import React, { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { WalletQr } from '@/components/buzz/WalletQr';
import { getWalletSource } from '@/buzz/wallet-source';
import type { WalletView } from '@beeline/api-contract/wallet';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Receive (mock §Screens 5): one address, one QR. Same address on every
 * EVM chain. Solana is the only exception — a separate CDP account, shown
 * as its own row with a different address. The QR painting is the shared
 * `WalletQr` the dashboard also renders.
 */
export default function WalletReceiveScreen() {
  const params = useLocalSearchParams<{ workspaceId?: string | string[] }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const insets = useSafeAreaInsets();
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const address = wallet?.address ?? '';
  const solanaAddress = wallet?.solanaAddress ?? null;

  useEffect(() => {
    void getWalletSource()
      .readWallet({ workspaceId })
      .then(setWallet)
      .catch(() => setWallet(null));
  }, [workspaceId]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="wallet-receive-screen">
      <PageHeader
        backAccessibilityLabel="Back to Wallet"
        eyebrow="Wallet"
        onBack={() => router.back()}
        testID="wallet-receive-header"
        title="Receive"
      />
      <View style={styles.body}>
        <WalletQr payload={address} />
        <Text selectable style={styles.address} testID="wallet-receive-address">
          {address}
        </Text>
        <Text style={styles.sub}>Same address on every EVM chain.</Text>
        <SettingsRow
          disabled
          description={solanaAddress ?? 'different address'}
          testID="wallet-receive-solana"
          title="Solana"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    body: {
      alignItems: 'center',
      flex: 1,
      gap: hull.space.sm,
      padding: hull.space.md,
    },
    address: { ...hull.type.machine, color: hull.textPrimary },
    sub: { ...hull.type.meta, color: hull.textMuted },
  };
});
