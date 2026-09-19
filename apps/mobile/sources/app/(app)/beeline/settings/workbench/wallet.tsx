import React, { useCallback, useEffect, useState } from 'react';
import { Image, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { Typography } from '@/constants/Typography';
import * as Clipboard from 'expo-clipboard';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { NetworkUnavailableState } from '@/components/buzz/NetworkUnavailableState';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { WalletQr } from '@/components/buzz/WalletQr';
import { chainIcon, tokenIcon } from '@/buzz/wallet-icons';
import { getWalletSource } from '@/buzz/wallet-source';
import type { WalletLedgerEntry, WalletView } from '@beeline/api-contract/wallet';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `14:26` today, otherwise `13 Sep` — one stamp vocabulary with the ledger. */
function activityStamp(createdAt: number, now: number = Date.now()): string {
  const date = new Date(createdAt < 1e12 ? createdAt * 1000 : createdAt);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  return `${date.getDate()} ${date.toLocaleString('en', { month: 'short' })}`;
}

/**
 * Wallet dashboard (post-connect overview): the address with copy and QR,
 * the total in USD, the asset breakdown with real token and chain marks,
 * the Send/Receive action tabs, and the transaction history feed.
 *
 * Data contracts: `WalletView` carries address/total/coins; the history
 * feed comes from `readWalletHistory` (the server's own ledger rows —
 * oldest first as stored, rendered newest first). The balance IS the
 * limit; the delegation banner stays the one header-only fact.
 */
export default function WalletScreen() {
  const params = useLocalSearchParams<{ workspaceId?: string | string[] }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [history, setHistory] = useState<WalletLedgerEntry[] | null>(null);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [granting, setGranting] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const view = await getWalletSource().readWallet({ workspaceId });
      setWallet(view);
      setError(null);
    } catch {
      setError('Wallet is unavailable right now');
    }
    try {
      const result = await getWalletSource().readHistory({ workspaceId, limit: 30 });
      setHistory([...result.entries].reverse());
      setHistoryUnavailable(false);
    } catch {
      // History degrades alone: the balance and assets stay paintable.
      setHistoryUnavailable(true);
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
    } catch {
      setError('network');
    } finally {
      setGranting(false);
    }
  }, [workspaceId, load]);

  const copyAddress = useCallback(async () => {
    if (!wallet?.address) return;
    await Clipboard.setStringAsync(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [wallet?.address]);

  const needsGrant = wallet !== null && !wallet.delegation.active;
  const address = wallet?.address ?? '';
  const coins = wallet?.coins ?? [];

  if (error && wallet === null) {
    return (
      <NetworkUnavailableState onRetry={() => void load()} testID="wallet-network-unavailable" />
    );
  }

  if (wallet === null) {
    return (
      <View style={[styles.container, styles.centered]} testID="wallet-loading">
        <SurfaceGlyphLoader testID="wallet-loader" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.contentInner} style={styles.content}>
        <View testID="wallet-screen">
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

            {/* Address: one row, copy on the trailing axis, QR on demand. */}
            <View style={styles.addressBlock} testID="wallet-address">
              <View style={styles.addressCopy}>
                <Text style={styles.sectionLabel}>Address</Text>
                <Text
                  numberOfLines={1}
                  selectable
                  style={styles.address}
                  testID="wallet-address-value"
                >
                  {address || '—'}
                </Text>
              </View>
              <TouchableOpacity
                accessibilityLabel="Copy address"
                accessibilityRole="button"
                onPress={copyAddress}
                style={styles.addressAction}
                testID="wallet-address-copy"
              >
                <Text style={styles.addressActionText}>{copied ? 'Copied' : 'Copy'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityLabel="Show address QR code"
                accessibilityRole="button"
                onPress={() => setQrOpen((open) => !open)}
                style={styles.addressAction}
                testID="wallet-address-qr-toggle"
              >
                <Text style={styles.addressActionText}>QR</Text>
              </TouchableOpacity>
            </View>
            {qrOpen ? (
              <View style={styles.qrBlock} testID="wallet-address-qr">
                <WalletQr payload={address} size={160} />
              </View>
            ) : null}

            <View style={styles.balanceBlock} testID="wallet-balance">
              <Text style={styles.balance} testID="wallet-balance-value">
                {wallet?.totalUsd ?? '—'}
              </Text>
              <Text style={styles.balanceLabel}>Total balance</Text>
              <View style={styles.balanceActions} testID="wallet-actions">
                {(['send', 'receive'] as const).map((action) => (
                  <TouchableOpacity
                    key={action}
                    accessibilityRole="button"
                    onPress={() =>
                      router.push({
                        pathname: `/beeline/settings/workbench/wallet-${action}`,
                        params: { workspaceId },
                      } as unknown as Href)
                    }
                    style={styles.balanceAction}
                    testID={`wallet-action-${action}`}
                  >
                    <Text style={styles.balanceActionText}>
                      {action === 'send' ? 'Send' : 'Receive'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <Text style={styles.sectionLabel} testID="wallet-assets-head">
              Assets
            </Text>
            {coins.length === 0 ? (
              <Text style={styles.quietLine} testID="wallet-assets-empty">
                No assets yet. Receive funds to get started.
              </Text>
            ) : (
              coins.map((coin) => {
                const mark = tokenIcon(coin.symbol);
                const badge = coin.chain ? chainIcon(coin.chain) : undefined;
                return (
                  <View
                    key={coin.symbol}
                    style={styles.coinRow}
                    testID={`wallet-coin-${coin.symbol}`}
                  >
                    <View style={styles.coinLeading}>
                      {mark ? (
                        <Image source={mark} style={styles.tokenIcon} />
                      ) : (
                        <View style={[styles.tokenIcon, styles.tokenMonogram]}>
                          <Text style={styles.monogramText}>{coin.symbol.slice(0, 1)}</Text>
                        </View>
                      )}
                      <View style={styles.coinCopy}>
                        <Text style={styles.coinName}>{coin.name}</Text>
                        <View style={styles.coinChainLine}>
                          <Text style={styles.coinSymbol}>{coin.symbol}</Text>
                          {badge && coin.chain ? (
                            <View
                              style={styles.chainBadge}
                              testID={`wallet-coin-chain-${coin.chain}`}
                            >
                              <Image source={badge} style={styles.chainIcon} />
                              <Text style={styles.chainName}>{coin.chain}</Text>
                            </View>
                          ) : null}
                        </View>
                      </View>
                    </View>
                    <View style={styles.coinRight}>
                      <Text style={styles.coinUsd}>{coin.usd}</Text>
                      <Text style={styles.coinAmount}>{coin.amount}</Text>
                    </View>
                  </View>
                );
              })
            )}

            <Text style={styles.sectionLabel} testID="wallet-activity-head">
              Activity
            </Text>
            {historyUnavailable ? (
              <Text style={styles.quietLine} testID="wallet-activity-unavailable">
                Activity is unavailable right now.
              </Text>
            ) : history === null ? (
              <View style={styles.activityLoading} testID="wallet-activity-loading">
                <SurfaceGlyphLoader compact testID="wallet-activity-loader" />
              </View>
            ) : history.length === 0 ? (
              <Text style={styles.quietLine} testID="wallet-activity-empty">
                No transactions yet.
              </Text>
            ) : (
              history.map((entry, index) => (
                <View
                  key={`${entry.createdAt}-${index}`}
                  style={styles.activityRow}
                  testID={`wallet-activity-${index}`}
                >
                  <View
                    style={[
                      styles.directionMark,
                      entry.direction === 'in' ? styles.directionIn : styles.directionOut,
                    ]}
                  >
                    <Text style={styles.directionText}>{entry.direction === 'in' ? '↓' : '↑'}</Text>
                  </View>
                  <View style={styles.activityCopy}>
                    <Text style={styles.activityTitle}>
                      {entry.direction === 'in'
                        ? 'Received'
                        : entry.agentName
                          ? `Sent by ${entry.agentName}`
                          : 'Sent'}
                    </Text>
                    <Text numberOfLines={1} style={styles.activitySub}>
                      {entry.counterparty} · {entry.chain}
                    </Text>
                  </View>
                  <View style={styles.activityRight}>
                    <Text
                      style={[
                        styles.activityAmount,
                        entry.direction === 'in' && styles.activityAmountIn,
                      ]}
                    >
                      {entry.amountText}
                    </Text>
                    <Text style={styles.activityStamp}>{activityStamp(entry.createdAt)}</Text>
                  </View>
                </View>
              ))
            )}
          </>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1 },
    centered: { alignItems: 'center', justifyContent: 'center', padding: hull.space.xl, gap: hull.space.md },
    activityLoading: { alignItems: 'flex-start', paddingVertical: hull.space.sm },
    content: { flex: 1 },
    contentInner: { padding: hull.space.md, gap: hull.space.xs, paddingBottom: hull.space.xxl },
    addressBlock: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: hull.space.sm,
      paddingVertical: hull.space.sm,
    },
    addressCopy: { flex: 1, minWidth: 0, gap: 2 },
    address: { ...hull.type.machine, color: hull.textPrimary },
    addressAction: {
      alignItems: 'center',
      borderColor: hull.border,
      borderRadius: hull.radius,
      borderWidth: StyleSheet.hairlineWidth,
      justifyContent: 'center',
      minHeight: 32,
      paddingHorizontal: hull.space.sm,
    },
    addressActionText: { ...hull.type.meta, color: hull.textSecondary },
    qrBlock: { alignItems: 'center', paddingBottom: hull.space.sm },
    balanceBlock: { alignItems: 'center', paddingVertical: hull.space.xl, gap: 2 },
    balance: { ...hull.type.hero, color: hull.textPrimary, textAlign: 'center' },
    balanceLabel: { ...hull.type.meta, color: hull.textMuted, textAlign: 'center' },
    balanceActions: { flexDirection: 'row', gap: hull.space.lg, marginTop: hull.space.md },
    balanceAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: hull.space.md },
    balanceActionText: {
      ...Typography.default(),
      ...Typography.ledger('medium'),
      ...hull.type.body,
      color: hull.accent,
    },
    sectionLabel: {
      ...Typography.default(),
      ...hull.type.sectionHead,
      color: hull.textMuted,
      paddingTop: hull.space.sm,
    },
    quietLine: { ...hull.type.meta, color: hull.textMuted, paddingVertical: hull.space.sm },
    coinRow: {
      alignItems: 'center',
      borderBottomColor: hull.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      justifyContent: 'space-between',
      minHeight: 56,
      paddingVertical: hull.space.sm,
    },
    coinLeading: {
      alignItems: 'center',
      flexDirection: 'row',
      flex: 1,
      gap: hull.space.sm,
      minWidth: 0,
    },
    tokenIcon: { borderRadius: 18, height: 36, width: 36 },
    tokenMonogram: {
      alignItems: 'center',
      backgroundColor: hull.border,
      justifyContent: 'center',
    },
    monogramText: { ...hull.type.meta, color: hull.textSecondary },
    coinCopy: { flex: 1, gap: 2, minWidth: 0 },
    coinChainLine: { alignItems: 'center', flexDirection: 'row', gap: hull.space.sm },
    coinName: { ...hull.type.body, color: hull.textPrimary },
    coinSymbol: { ...hull.type.meta, color: hull.textSecondary },
    chainBadge: { alignItems: 'center', flexDirection: 'row', gap: 4 },
    chainIcon: { borderRadius: 7, height: 14, width: 14 },
    chainName: { ...hull.type.meta, color: hull.textMuted },
    coinRight: { alignItems: 'flex-end', gap: 2 },
    coinUsd: { ...hull.type.body, color: hull.textPrimary },
    coinAmount: { ...hull.type.meta, color: hull.textSecondary },
    activityRow: {
      alignItems: 'center',
      borderBottomColor: hull.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: hull.space.sm,
      minHeight: 52,
      paddingVertical: hull.space.sm,
    },
    directionMark: {
      alignItems: 'center',
      borderRadius: 14,
      height: 28,
      justifyContent: 'center',
      width: 28,
    },
    directionIn: { backgroundColor: hull.border },
    directionOut: { opacity: 0.7 },
    directionText: { ...hull.type.meta, color: hull.textSecondary },
    activityCopy: { flex: 1, gap: 2, minWidth: 0 },
    activityTitle: { ...hull.type.body, color: hull.textPrimary },
    activitySub: { ...hull.type.meta, color: hull.textMuted },
    activityRight: { alignItems: 'flex-end', gap: 2 },
    activityAmount: { ...hull.type.body, color: hull.textPrimary },
    activityAmountIn: { color: hull.agentAccent },
    activityStamp: { ...hull.type.meta, color: hull.textMuted },
  };
});
