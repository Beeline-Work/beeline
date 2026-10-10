import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { PageHeader } from '@/components/buzz/PageHeader';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { Button } from '@/components/buzz/Button';

function param(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }

export default function WalletServiceScreen() {
  const params = useLocalSearchParams<{ workspaceId?: string | string[] }>();
  const workspaceId = param(params.workspaceId) ?? '';
  const insets = useSafeAreaInsets();
  return <View style={[styles.screen, { paddingTop: insets.top }]} testID="wallet-service-screen">
    <PageHeader eyebrow="Connectors" prominent title="Coinbase wallet" backAccessibilityLabel="Back to Connectors" onBack={() => router.back()} />
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 32 + insets.bottom }]}>
      <View style={styles.identity}><ServiceMark company="Coinbase" domain="coinbase.com" /><Text style={styles.provenance}>Wallet</Text></View>
      <SettingsRow title="Status" value="Connected" statusGlyph="live" />
      <View><Text style={styles.sectionLabel}>WHAT YOUR AGENTS CAN DO</Text>
        <Text style={styles.explainer}>Your agents can prepare wallet actions within the permissions you grant. You review spending before it happens.</Text>
        {['Show my balance', 'Prepare a transfer', 'Show recent activity'].map(example =>
          <Text key={example} style={styles.example}>“{example}”</Text>)}
      </View>
      <Button label="Open wallet" onPress={() => router.push({ pathname: '/beeline/settings/workbench/wallet', params: { workspaceId } })}
        fullWidth testID="open-wallet" />
      <Text style={styles.note}>Opens the Coinbase wallet frontend.</Text>
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create(theme => { const hull = theme.buzz; return {
  screen: { flex: 1, backgroundColor: hull.appCanvas },
  content: { paddingHorizontal: hull.space.lg, paddingTop: hull.layout.screenTop, gap: hull.layout.sectionGap },
  identity: { flexDirection: 'row', alignItems: 'center', gap: hull.space.sm },
  provenance: { ...Typography.ledger(), ...hull.type.body, color: hull.appQuiet },
  sectionLabel: { ...Typography.default(), ...hull.type.sectionHead, color: hull.appQuiet, marginBottom: hull.space.sm },
  explainer: { ...Typography.ledger(), ...hull.type.body, color: hull.appSecondary },
  example: { ...Typography.ledger(), ...hull.type.body, color: hull.appInk, borderLeftWidth: 2, borderLeftColor: hull.accent,
    paddingLeft: hull.space.md, paddingVertical: hull.space.sm },
  note: { ...Typography.ledger(), ...hull.type.meta, color: hull.appQuiet },
}; });
