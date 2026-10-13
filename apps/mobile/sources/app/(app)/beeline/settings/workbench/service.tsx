import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { PageHeader } from '@/components/buzz/PageHeader';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { HullActionSheetModal, HullActionSheetRow, HullActionSheetCancel } from '@/components/buzz/HullActionSheet';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { useSharedWorkbench } from '@/buzz/workbench-surface';
import { keyServiceGroups, squireConnectionState, type KeyServiceGroup } from '@/buzz/connectors-model';

function param(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }
const SQUIRE_VAULT_URL = 'https://trustysquire.ai/vault';

export default function ConnectorServiceScreen() {
  const params = useLocalSearchParams<{ workspaceId?: string | string[]; viewerId?: string | string[]; helperId?: string | string[]; service?: string | string[] }>();
  const workspaceId = param(params.workspaceId) ?? '';
  const viewerId = param(params.viewerId) ?? '';
  const service = param(params.service) ?? '';
  const insets = useSafeAreaInsets();
  const { value: view, error: loadError, refresh } = useSharedWorkbench({ workspaceId, viewerId });
  const [error, setError] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);

  const groups = view ? keyServiceGroups(view, viewerId) : [];
  const group: KeyServiceGroup | undefined = groups.find(item => item.key === service);
  const isSquire = service === 'trusty-squire';
  const helperId = param(params.helperId);
  const helper = view?.helpers.find(item => item.id === helperId);
  const title = isSquire ? `Trusty Squire${helper ? ` · ${helper.name}` : ''}` : group?.name ?? 'Keys';
  const offline = isSquire && helper ? helper.squire?.status !== 'connected'
    : view ? squireConnectionState(view) !== 'connected' : true;
  const openVault = () => { void WebBrowser.openBrowserAsync(SQUIRE_VAULT_URL).catch(() => setError('Could not open Trusty Squire vault')); };

  return <View style={[styles.screen, { paddingTop: insets.top }]} testID="connector-service-screen">
    <PageHeader eyebrow="Connectors" prominent title={title} backAccessibilityLabel="Back to Connectors" onBack={() => router.back()} />
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
      {error || loadError ? <Text accessibilityRole="alert" style={styles.error}>{error ?? 'Connections are unavailable right now'}</Text> : null}
      {isSquire ? <>
        <Text style={styles.explainer}>Trusty Squire signs up and signs in to websites for your agents, so you never do the manual login. It keeps keys it obtains in its vault.</Text>
        <SettingsRow title="Status" value={helper?.squire?.status === 'error' ? 'Error' : offline ? 'Not added' : 'Connected'} valueTone={offline ? 'danger' : undefined}
          trailingPress={{ accessibilityLabel: 'Change Trusty Squire connection', onPress: () => setStatusOpen(true) }} />
        {helper?.squire?.errorMessage ? <Text accessibilityRole="alert" style={styles.error}>{helper.squire.errorMessage}</Text> : null}
        <View style={styles.section}><Text style={styles.sectionLabel}>WHAT YOUR AGENTS CAN DO</Text>
          <Text style={styles.explainer}>Ask your agent to use a site and Squire handles the login steps.</Text>
          <Text style={styles.example}>“Sign me up for this service”</Text><Text style={styles.example}>“Sign in and finish this task”</Text>
        </View>
      </> : group ? <>
        <View style={styles.identity}><ServiceMark company={group.name} domain={group.domain} /><Text style={styles.provenance}>{group.keys.length} {group.keys.length === 1 ? 'key' : 'keys'} · Trusty Squire</Text></View>
        {offline ? <><SettingsRow title="Status" value="Offline" valueTone="danger"
          trailingPress={{ accessibilityLabel: 'Reconnect Trusty Squire', onPress: () => setStatusOpen(true) }} />
          <Text style={styles.explainer}>Trusty Squire is offline. Reconnect it to use these keys.</Text></> :
          <View style={styles.section}><Text style={styles.sectionLabel}>WHAT YOUR AGENTS CAN DO</Text>
            <Text style={styles.explainer}>Let agents use the {group.name} account you choose, within the access you allow.</Text>
            <Text style={styles.example}>“Use {group.name} for this task”</Text>
          </View>}
        <View style={styles.section}><Text style={styles.sectionLabel}>YOUR KEYS</Text>
          {group.keys.map(key => <SettingsRow key={key.ref} title={key.name} />)}
        </View>
        <SettingsRow chevron="right" title="Manage in Trusty Squire" onPress={openVault} />
      </> : null}
    </ScrollView>
    <HullActionSheetModal visible={statusOpen} title="Trusty Squire" onClose={() => setStatusOpen(false)}>
      {offline ? <HullActionSheetRow label="Reconnect" onPress={() => { setStatusOpen(false); router.push({ pathname: '/beeline/settings/workbench/connect', params: { workspaceId, viewerId, connectorId: 'trusty-squire', ...(helperId ? { helperId } : {}) } }); }} /> :
        <HullActionSheetRow label="Disconnect" destructive onPress={() => {
          setStatusOpen(false);
          const machineId = helperId ?? view?.helpers.find(item => item.squire?.status === 'connected')?.id;
          void getWorkbenchSource().disconnectConnector({ workspaceId, connectorId: `squire:${machineId}` })
            .then(() => refresh()).catch(() => setError('Could not disconnect Trusty Squire'));
        }} />}
      <HullActionSheetCancel onPress={() => setStatusOpen(false)} />
    </HullActionSheetModal>
  </View>;
}

const styles = StyleSheet.create(theme => { const hull = theme.buzz; return {
  screen: { flex: 1, backgroundColor: hull.appCanvas },
  content: { paddingHorizontal: hull.space.lg, paddingTop: hull.layout.screenTop, gap: hull.layout.sectionGap },
  section: { gap: hull.space.xs },
  sectionLabel: { ...Typography.default(), ...hull.type.sectionHead, color: hull.appQuiet, marginBottom: hull.space.sm },
  identity: { flexDirection: 'row', alignItems: 'center', gap: hull.space.sm },
  provenance: { ...Typography.ledger(), ...hull.type.body, color: hull.appQuiet },
  explainer: { ...Typography.ledger(), ...hull.type.body, color: hull.appSecondary },
  example: { ...Typography.ledger(), ...hull.type.body, color: hull.appInk, borderLeftWidth: 2, borderLeftColor: hull.accent, paddingLeft: hull.space.md, paddingVertical: hull.space.sm },
  error: { ...Typography.ledger(), ...hull.type.body, color: hull.dialogDanger },
}; });
