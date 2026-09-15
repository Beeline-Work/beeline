import React, { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import QRCode from 'qrcode';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { getWalletSource } from '@/buzz/wallet-source';
import type { WalletView } from '@beeline/api-contract/wallet';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Receive (mock §Screens 5): one address, one QR. Same address on every
 * EVM chain. Solana is the only exception — a separate CDP account, shown
 * as its own row with a different address. The QR is the pure-JS matrix
 * from `qrcode` painted as a grid of tiles — no canvas, no WebView.
 */
export default function WalletReceiveScreen() {
  const params = useLocalSearchParams<{ workspaceId?: string | string[] }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [modules, setModules] = useState<{ size: number; get: (row: number, col: number) => number } | null>(
    null,
  );
  const address = wallet?.address ?? '';
  const solanaAddress = wallet?.solanaAddress ?? null;

  useEffect(() => {
    void getWalletSource()
      .readWallet({ workspaceId })
      .then(setWallet)
      .catch(() => setWallet(null));
  }, [workspaceId]);

  useEffect(() => {
    if (!address) return;
    try {
      setModules(QRCode.create(address, { errorCorrectionLevel: 'M' }).modules);
    } catch {
      setModules(null);
    }
  }, [address]);

  return (
    <View style={styles.container} testID="wallet-receive-screen">
      {modules ? (
        <View style={styles.qr} testID="wallet-receive-qr">
          {Array.from({ length: modules.size }, (_, row) => (
            <View key={row} style={styles.qrRow}>
              {Array.from({ length: modules.size }, (_, col) => (
                <View key={col} style={modules.get(row, col) ? styles.tileDark : styles.tileLight} />
              ))}
            </View>
          ))}
        </View>
      ) : (
        <View style={[styles.qrPlaceholder, { backgroundColor: '#ffffff' }]} testID="wallet-receive-qr-placeholder" />
      )}
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
  container: { alignItems: 'center', flex: 1, gap: 12, padding: 16 },
  qr: {
    backgroundColor: '#ffffff',
    borderRadius: 3,
    padding: 6,
  },
  qrRow: { flexDirection: 'row' },
  tileDark: { height: 6, width: 6, backgroundColor: '#171310' },
  tileLight: { height: 6, width: 6, backgroundColor: '#ffffff' },
  qrPlaceholder: {
    borderColor: '#83838d',
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
    height: 180,
    width: 180,
  },
  address: { color: '#f0f0f3' },
  sub: { color: '#83838d' },
}));
