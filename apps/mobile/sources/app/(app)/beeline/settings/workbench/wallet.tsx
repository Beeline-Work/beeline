import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { getWalletSource } from '@/buzz/wallet-source';
import type { WalletView } from '@beeline/api-contract/wallet';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Wallet (mock §Screens, pass 4): a total, then coins with their marks. No
 * chains on this page. The delegation banner is the one header-only fact —
 * an expired grant reads as "your agents need permission again", never a
 * silent agent failure. Send/Receive are the pair at the bottom.
 */
export default function WalletScreen() {
  const params = useLocalSearchParams<{ workspaceId?: string | string[] }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [granting, setGranting] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setWallet(await getWalletSource().readWallet({ workspaceId }));
      setError(null);
    } catch {
      setError('Wallet is unavailable right now');
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const grant = useCallback(async () => {
    setGranting(true);
    try {
      await getWalletSource().grantDelegation({ workspaceId });
      await load();
    } finally {
      setGranting(false);
    }
  }, [workspaceId, load]);

  const create = useCallback(async () => {
    setCreating(true);
    try {
      setWallet(await getWalletSource().createWallet({ workspaceId }));
      setError(null);
    } catch {
      setError('Could not create the wallet. Try again.');
    } finally {
      setCreating(false);
    }
  }, [workspaceId]);

  const needsGrant = wallet !== null && !wallet.delegation.active;

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.contentInner} style={styles.content}>
        <View testID="wallet-screen">
          {error ? (
            <SettingsRow
              action="create"
              description="A wallet only you control. Your agents spend it; they never see the key."
              onPress={creating ? undefined : create}
              testID="wallet-create"
              title="Create wallet"
              tone="action"
            />
          ) : (
            <>
              {needsGrant ? (
                <SettingsRow
                  action="grant"
                  description="Your agents need permission again to spend."
                  onPress={granting ? undefined : grant}
                  testID="wallet-delegation-banner"
                  title="Permission expired"
                  tone="action"
                />
              ) : null}
              <View style={styles.balanceBlock} testID="wallet-balance">
                <Text style={styles.balance}>{wallet?.totalUsd ?? '—'}</Text>
              </View>
              {(wallet?.coins ?? []).map((coin) => (
                <View key={coin.symbol} style={styles.coinRow} testID={`wallet-coin-${coin.symbol}`}>
                  <View style={styles.coinCopy}>
                    <Text style={styles.coinName}>{coin.name}</Text>
                    <Text style={styles.coinSymbol}>{coin.symbol}</Text>
                  </View>
                  <View style={styles.coinRight}>
                    <Text style={styles.coinUsd}>{coin.usd}</Text>
                    <Text style={styles.coinAmount}>{coin.amount}</Text>
                  </View>
                </View>
              ))}
              <View style={styles.pair} testID="wallet-actions">
                <SettingsRow
                  action="Send"
                  onPress={() =>
                    router.push({
                      pathname: '/beeline/settings/workbench/wallet-send',
                      params: { workspaceId },
                    } as unknown as Href)
                  }
                  testID="wallet-send-row"
                  title="Send"
                  tone="action"
                />
                <SettingsRow
                  chevron="right"
                  onPress={() =>
                    router.push({
                      pathname: '/beeline/settings/workbench/wallet-receive',
                      params: { workspaceId },
                    } as unknown as Href)
                  }
                  testID="wallet-receive-row"
                  title="Receive"
                />
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1 },
    content: { flex: 1 },
    contentInner: { padding: hull.space.md, gap: hull.space.xs },
    balanceBlock: { paddingVertical: hull.space.sm },
    balance: {
      ...hull.type.hero,
      color: hull.textPrimary,
    },
    coinRow: {
      alignItems: 'center',
      borderBottomColor: hull.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 12,
    },
    coinCopy: { gap: 2 },
    coinName: { ...hull.type.body, color: hull.textPrimary },
    coinSymbol: { ...hull.type.meta, color: hull.textSecondary },
    coinRight: { alignItems: 'flex-end', gap: 2 },
    coinUsd: { ...hull.type.body, color: hull.textPrimary },
    coinAmount: { ...hull.type.meta, color: hull.textSecondary },
    pair: { gap: hull.space.md, marginTop: hull.space.md },
  };
});
