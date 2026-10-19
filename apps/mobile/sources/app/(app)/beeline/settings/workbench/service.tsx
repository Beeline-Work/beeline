import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { PageHeader } from '@/components/buzz/PageHeader';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { Button } from '@/components/buzz/Button';
import { NetworkUnavailableState } from '@/components/buzz/NetworkUnavailableState';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { HullActionSheetModal, HullActionSheetRow, HullActionSheetCancel } from '@/components/buzz/HullActionSheet';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { useSharedWorkbench } from '@/buzz/workbench-surface';
import { openCompanyItem, useConnectCompanyApp } from '@/buzz/company-connection-actions';
import type { WorkbenchCompany } from '@beeline/api-contract/workbench';

function param(v: string | string[] | undefined) { return Array.isArray(v) ? v[0] : v; }
/** Trusty Squire keeps the keys; it has no disconnect, so the page links out to its vault. */
export const SQUIRE_VAULT_URL = 'https://trustysquire.ai/vault';
type Machine = WorkbenchCompany['machines'][number];
const needsFix = (m: Machine) => m.status !== 'connected' || Boolean(m.error);
export default function ConnectorServiceScreen() {
  const params = useLocalSearchParams<{ workspaceId?: string | string[]; viewerId?: string | string[]; helperId?: string | string[]; service?: string | string[] }>();
  const scope = { workspaceId: param(params.workspaceId) ?? '', viewerId: param(params.viewerId) ?? '' };
  const service = param(params.service) ?? '';
  const { value: view, error: loadError, refresh } = useSharedWorkbench(scope);
  const row = view?.companies?.rows.find(item => item.id === service || (service === 'trusty-squire' && item.kind === 'sign-in-service'));
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const actions = useConnectCompanyApp(scope);
  const [machine, setMachine] = useState<Machine | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manageMachine = row?.machines.find(item => item.id === machine?.id) ?? machine;
  const reconnectMachine = (helperId: string) => {
    setMachine(null); router.push({ pathname: '/beeline/settings/workbench/connect', params: { ...scope, connectorId: 'trusty-squire', helperId } } as Href);
  };
  const keyed = row?.items.some(item => item.target.kind === 'key') ?? false;
  const agents = row?.kind === 'sign-in-service' ? 'Trusty Squire signs up and signs in to websites for your agents. Your computers keep the sign-in sessions.'
    : row?.items.some(item => item.kind === 'connection') ? `Agents use ${row.name} when you ask them to.`
      : `Agents call ${row?.name ?? 'this service'} with your keys, only on the hosts you allow.`;
  const disconnect = async () => {
    try {
      if (manageMachine) await getWorkbenchSource().disconnectConnector({ workspaceId: scope.workspaceId, connectorId: `squire:${manageMachine.id}` });
      else await getWorkbenchSource().disconnectLinkSignIn();
      setMachine(null); setLinkOpen(false); await refresh();
    } catch { setError('Could not disconnect. Try again.'); }
  };
  return <View style={[styles.screen, { paddingTop: insets.top }]} testID="connector-service-screen">
    <PageHeader eyebrow="Connectors" prominent title={row?.name ?? 'Connectors'} backAccessibilityLabel="Back to Connectors" onBack={() => router.back()} />
    {loadError && !row ? <NetworkUnavailableState onRetry={() => void refresh()} /> : !view ? <SurfaceGlyphLoader /> : !row ?
      <Text style={styles.note}>This company is no longer connected.</Text> :
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + theme.buzz.space.xl }]}>
        <SettingsRow appBoard title={row.name} description={[row.domain, row.subtitle].filter(Boolean).join(' · ')} leading={<ServiceMark company={row.name} domain={row.domain} mark={row.logo} />}
          value={row.attention ? row.status ?? 'Needs attention' : row.kind === 'sign-in-service' ? row.status : 'Connected'} valueTone={row.attention ? 'danger' : undefined}
          statusGlyph={row.attention ? 'failed' : 'live'} testID="connector-info-status" />
        <Text style={styles.note} testID="connector-info-agents">{agents}</Text>
        {row.attention ? <Text accessibilityRole="alert" style={styles.error}>{row.attention}</Text> : null}
        {row.kind === 'sign-in-service' ? <View>
          <RoomListSectionHeader title="Your computers" inset="content" />
          {row.machines.map(item => {
            const status = item.statusText ?? (item.reconnecting ? 'Reconnecting…' : item.signedInAs ?? (item.status === 'error' ? 'Google sign-in expired' : item.status === 'connected' ? 'Google signed in' : 'Google sign-in needed'));
            // An online computer that can retry does it in one tap; an offline one shows why it cannot.
            return !item.reconnecting && item.online && needsFix(item)
              ? <SettingsRow appBoard key={item.id} title={item.name} description={[status, item.error].filter(Boolean).join(' · ')} descriptionTone={item.status === 'error' ? 'danger' : undefined}
                action={item.status === 'not-added' ? 'Set up' : 'Reconnect'} onPress={() => reconnectMachine(item.id)} testID={`squire-computer-${item.id}`} />
              : <SettingsRow appBoard key={item.id} title={item.name} description={item.error} value={status}
                valueTone={item.status === 'error' || (item.status === 'connected' && !item.online) ? 'danger' : undefined}
                chevron="right" disabled={item.reconnecting} onPress={() => setMachine(item)} testID={`squire-computer-${item.id}`} />;
          })}
        </View> : (['connection', 'login', 'key'] as const).map(kind => {
          const items = row.items.filter(item => item.kind === kind);
          return items.length ? <View key={kind}>
            <RoomListSectionHeader title={kind === 'connection' ? 'Connections' : kind === 'login' ? 'Logins' : 'Keys'} inset="content" spacing="flush" />
            {items.map(item => item.target.kind === 'key'
              ? <SettingsRow appBoard key={item.id} title={item.title} description={item.subtitle}
                value={item.status} valueTone={item.attention ? 'danger' : undefined} testID={`company-item-${item.id}`} />
              : <SettingsRow appBoard key={item.id} title={item.title} description={item.subtitle}
                value={item.status} valueTone={item.attention ? 'danger' : undefined} chevron="right"
                onPress={() => item.target.kind === 'link' ? setLinkOpen(true) : openCompanyItem(item.target, scope)} testID={`company-item-${item.id}`} />)}
          </View> : null;
        })}
        {keyed ? <Button label="Manage in Trusty Squire" variant="secondary" fullWidth
          onPress={() => void WebBrowser.openBrowserAsync(SQUIRE_VAULT_URL)} testID="connector-squire-vault" /> : null}
        {row.alsoAvailable.length ? <View><RoomListSectionHeader title="Also available" inset="content" spacing="flush" />
          {row.alsoAvailable.map(app => <SettingsRow appBoard key={app.appKey} title={app.name} description={app.purpose}
            leading={<ServiceMark company={app.providerName} domain={app.domain} mark={app.logo} />} chevron="right"
            disabled={Boolean(actions.busy)} onPress={() => void actions.connect(app)} testID={`company-available-${app.appKey}`} />)}
        </View> : null}
        {loadError ? <Text accessibilityRole="alert" style={styles.error}>Could not refresh connections. Try again.</Text> : null}
        {error || actions.error ? <Text accessibilityRole="alert" style={styles.error}>{error ?? actions.error}</Text> : null}
      </ScrollView>}
    <HullActionSheetModal visible={Boolean(machine) || linkOpen} title={machine?.name ?? 'Link'} onClose={() => { setMachine(null); setLinkOpen(false); }}>
      {manageMachine?.reconnecting ? <Text style={styles.note}>Reconnecting…</Text> : manageMachine && !manageMachine.online ? <Text style={styles.error} testID="squire-computer-offline">{manageMachine.error ?? `Turn on ${manageMachine.name} to reconnect it.`}</Text>
        : machine && manageMachine && needsFix(manageMachine) ? <HullActionSheetRow label={manageMachine.status === 'not-added' ? 'Set up' : 'Reconnect'} onPress={() => reconnectMachine(machine.id)} /> : <HullActionSheetRow label="Disconnect" destructive onPress={() => void disconnect()} />}
      <HullActionSheetCancel onPress={() => { setMachine(null); setLinkOpen(false); }} />
    </HullActionSheetModal>
  </View>;
}
const styles = StyleSheet.create(theme => ({
  screen: { flex: 1, backgroundColor: theme.buzz.appCanvas },
  content: { paddingHorizontal: theme.buzz.space.lg, paddingTop: theme.buzz.layout.screenTop, gap: theme.buzz.layout.sectionGap },
  note: { ...theme.buzz.type.meta, color: theme.buzz.appQuiet }, error: { ...theme.buzz.type.meta, color: theme.buzz.dialogDanger },
}));
