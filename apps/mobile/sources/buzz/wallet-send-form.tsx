import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { HullActionSheetModal, HullActionSheetRow } from '@/components/buzz/HullActionSheet';
import { chainFeeLabel, getWalletSource } from '@/buzz/wallet-source';
import type { WalletChainView, WalletSendOutcome, WalletView } from '@beeline/api-contract/wallet';

/**
 * The send form, shared by the wallet dashboard's Send tab and the
 * standalone `wallet-send` route: Amount, To, then Via — the chain sits in
 * a popup over the same screen, next to what it costs. The only refusals
 * are insufficient funds and an expired delegation; both settle as a named
 * outcome inline.
 */
export function WalletSendForm({ workspaceId }: { workspaceId: string }) {
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState('');
  const [chain, setChain] = useState<WalletChainView | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [outcome, setOutcome] = useState<WalletSendOutcome | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    void getWalletSource()
      .readWallet({ workspaceId })
      .then((view) => {
        setWallet(view);
        setChain(view.chains.find((candidate) => candidate.id === 'base') ?? view.chains[0] ?? null);
      })
      .catch(() => setWallet(null));
  }, [workspaceId]);

  const defaultAsset = useMemo(() => wallet?.coins[0]?.symbol.toLowerCase() ?? 'usdc', [wallet]);

  const send = useCallback(async () => {
    if (!chain || !amount || !to) return;
    setSending(true);
    try {
      const result = await getWalletSource().sendFromWallet({
        workspaceId,
        chain: chain.id,
        asset: defaultAsset,
        amount,
        to,
      });
      setOutcome(result);
    } finally {
      setSending(false);
    }
  }, [workspaceId, chain, amount, to, defaultAsset]);

  return (
    <View testID="wallet-send-form">
      <Text style={styles.label}>Amount</Text>
      <View style={styles.amountRow}>
        <TextInput
          keyboardType="decimal-pad"
          onChangeText={setAmount}
          style={styles.amountInput}
          testID="wallet-send-amount"
          value={amount}
        />
        <Text style={styles.amountAsset}>{defaultAsset.toUpperCase()}</Text>
      </View>
      <Text style={styles.label}>To</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setTo}
        placeholder="0x…"
        placeholderTextColor="#83838d"
        style={styles.field}
        testID="wallet-send-to"
        value={to}
      />
      <Text style={[styles.label, styles.labelGap]}>Via</Text>
      <Pressable onPress={() => setPickerOpen(true)} testID="wallet-send-chain">
        <SettingsRow
          description={chain ? chainFeeLabel(chain) : undefined}
          testID="wallet-send-chain-row"
          title={chain?.name ?? 'Chain'}
        />
      </Pressable>
      {outcome ? (
        <Text
          style={outcome.outcome === 'sent' ? styles.sent : styles.refused}
          testID="wallet-send-outcome"
        >
          {outcome.outcome === 'sent'
            ? `Sent ${outcome.amountText} · ${outcome.balanceAfterUsd} left`
            : outcome.outcome === 'insufficient'
              ? `Not enough ${outcome.asset} — ${outcome.available} available`
              : outcome.outcome === 'delegation-expired'
                ? 'Your permission to let agents sign has expired. Renew it on the wallet screen.'
                : `Could not send · ${outcome.reason}`}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={sending || !amount || !to}
        onPress={send}
        style={styles.sendPress}
        testID="wallet-send-confirm"
      >
        <Text style={[styles.sendButton, (sending || !amount || !to) && styles.sendDisabled]}>
          Send
        </Text>
      </Pressable>
      <HullActionSheetModal
        onClose={() => setPickerOpen(false)}
        testID="wallet-chain-picker"
        title="send via"
        visible={pickerOpen}
      >
        {(wallet?.chains ?? []).map((candidate) => (
          <HullActionSheetRow
            key={candidate.id}
            disabled={!candidate.hasBalance}
            label={candidate.name}
            metadata={chainFeeLabel(candidate)}
            onPress={() => {
              setChain(candidate);
              setPickerOpen(false);
            }}
            selected={chain?.id === candidate.id}
            testID={`wallet-chain-${candidate.id}`}
          />
        ))}
      </HullActionSheetModal>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    label: { ...hull.type.meta, color: hull.textSecondary },
    labelGap: { marginTop: hull.space.md },
    amountRow: { alignItems: 'baseline', flexDirection: 'row', gap: hull.space.sm },
    amountInput: {
      ...hull.type.hero,
      color: hull.textPrimary,
      flex: 1,
    },
    amountAsset: { ...hull.type.meta, color: hull.textSecondary },
    field: {
      ...hull.type.body,
      borderBottomColor: hull.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      color: hull.textPrimary,
      paddingVertical: hull.space.sm,
    },
    sent: { ...hull.type.meta, color: hull.textPrimary, marginTop: hull.space.md },
    refused: { ...hull.type.meta, color: hull.textSecondary, marginTop: hull.space.md },
    sendPress: { minHeight: 44, justifyContent: 'center', marginTop: hull.space.lg },
    sendButton: {
      ...hull.type.bodyStrong,
      color: hull.agentAccent,
      textAlign: 'center',
    },
    sendDisabled: { opacity: 0.42 },
  };
});
