import { AiClientsSection } from '@/components/buzz/AiClientsSection';
import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { useIsDesktop } from '@/utils/responsive';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import { useSharedWorkbench } from '@/buzz/workbench-surface';
import { connectionViewState, useConnectCompanyApp } from '@/buzz/company-connection-actions';
import { HullDialogInput } from '@/components/buzz/HullDialog';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { NetworkUnavailableState } from '@/components/buzz/NetworkUnavailableState';
import { ConnectorsSearchSheet } from './workbench/connect-app';

function first(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }
const SECTIONS = [ ['attention', 'Needs attention'], ['signin', 'Sign-in'], ['apps', 'Connected apps'], ['keys', 'Keys'] ] as const;

/** Owner-scoped server projection: the phone never groups or guesses provider identity. */
export default function WorkbenchScreen() {
  useLatencyRouteFrame('/beeline/settings/workbench');
  const params = useLocalSearchParams<{ workspaceId?: string | string[]; viewerId?: string | string[] }>();
  const activeWorkspaceId = useActiveCommunityId();
  const scope = { workspaceId: first(params.workspaceId) || activeWorkspaceId || '', viewerId: first(params.viewerId) ?? '' };
  const desktop = useIsDesktop();
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const { value: view, error, refresh, refreshAfterChange } = useSharedWorkbench(scope.viewerId ? scope : null);
  const index = view?.companies;
  const [searchOpen, setSearchOpen] = useState(false);
  const actions = useConnectCompanyApp(scope);
  const header = <PageHeader prominent backAccessibilityLabel="Back to Settings" eyebrow="Settings" title="Connectors" testID="workbench-header" onBack={() => router.back()} />;
  return <View style={[styles.container, { paddingTop: desktop ? 0 : insets.top }]}>
    {header}
    {(!index && error) || (view && !index) ? <NetworkUnavailableState onRetry={() => void refresh()} testID="workbench-network-unavailable" /> : !index ?
      <View style={styles.centered}><SurfaceGlyphLoader testID="workbench-loader" /></View> :
      <ScrollView style={styles.content} contentContainerStyle={[styles.contentInner, desktop && styles.desktopColumn, { paddingBottom: insets.bottom + theme.buzz.space.xxl }]} testID="workbench-scroll">
        <HullDialogInput accessibilityLabel="Search apps, keys, and websites" placeholder="Search apps, keys, and websites"
          value="" editable={false} variant="search" placeholderTextColor={theme.buzz.textDisabled}
          testID="connectors-search" onPress={() => setSearchOpen(true)} />
        {!index.hasConnections ? <View>
          <Text style={styles.note}>No connections yet. Choose a service to get started.</Text>
          <RoomListSectionHeader title="Suggested" inset="content" spacing="flush" />
          {index.suggestions.map(app => <SettingsRow appBoard key={app.providerId} title={app.name} description={app.purpose}
            leading={<ServiceMark company={app.providerName} domain={app.domain} mark={app.logo} />} value="Connect" chevron="right"
            disabled={Boolean(actions.busy)} onPress={() => void actions.connect(app)} testID={`connectors-suggest-${app.providerId}`} />)}
        </View> : SECTIONS.map(([section, title]) => {
          const rows = index.rows.filter(row => row.section === section);
          return rows.length ? <View key={section} testID={`connectors-${section}`}>
            <RoomListSectionHeader title={title} inset="content" spacing="flush" />
            {rows.map(row => {
              if (row.roomsClientId) return <AiClientsSection key={row.id}
                clients={(view?.aiClients ?? []).filter(client => client.clientId === row.roomsClientId)} onChanged={refreshAfterChange} />;
              const state = connectionViewState(row);
              return <SettingsRow appBoard key={row.id} title={row.name}
                description={state === 'error' && row.status ? `${row.status} · ${row.subtitle}` : row.subtitle}
                leading={<ServiceMark company={row.name} domain={row.domain} mark={row.logo} />}
                action={section === 'attention' ? 'Reconnect' : state === 'connect' ? 'Connect' : undefined}
                value={state === 'error' ? row.status : state === 'connected' && row.kind === 'sign-in-service' ? row.status : undefined}
                valueTone={state === 'error' ? 'danger' : undefined}
                statusGlyph={state === 'error' ? 'failed' : row.kind === 'sign-in-service' && row.status === 'Ready' ? 'live' : undefined}
                chevron="right" disabled={actions.busy === row.id} onPress={() => void actions.open(row, view?.apps)} testID={`connectors-company-${row.id}`} />;
            })}
          </View> : null;
        })}
        {error ? <SettingsRow title="Could not refresh connections. Try again." /> : null}
        {actions.error ? <SettingsRow title={actions.error} /> : null}
      </ScrollView>}
    <ConnectorsSearchSheet visible={searchOpen} onClose={() => setSearchOpen(false)} scope={scope} view={view} />
  </View>;
}
const styles = StyleSheet.create(theme => ({
  container: { flex: 1, backgroundColor: theme.buzz.appCanvas }, content: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  desktopColumn: { width: '100%', maxWidth: desktopColumnWidths.detail, alignSelf: 'center' },
    contentInner: {
 paddingHorizontal: theme.buzz.space.lg, paddingTop: theme.buzz.layout.screenTop, gap: theme.buzz.layout.sectionGap },
  note: { ...theme.buzz.type.meta, color: theme.buzz.appQuiet, marginBottom: theme.buzz.space.lg },
  error: { ...theme.buzz.type.meta, color: theme.buzz.dialogDanger },
}));
