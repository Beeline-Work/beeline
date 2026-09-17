import React, { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
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
    <View style={styles.container} testID="wallet-receive-screen">
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
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { alignItems: 'center', flex: 1, gap: theme.buzz.space.sm, padding: theme.buzz.space.md },
  address: { color: '#f0f0f3' },
  sub: { color: '#83838d' },
}));
