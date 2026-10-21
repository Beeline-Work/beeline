import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { WorkbenchAppSearchResult } from '@beeline/api-contract/workbench';
import { HullActionSheetModal, HullActionSheetCancel } from '@/components/buzz/HullActionSheet';
import { HullDialogInput } from '@/components/buzz/HullDialog';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { useSharedWorkbench, type WorkbenchScope } from '@/buzz/workbench-surface';
import { useConnectCompanyApp } from '@/buzz/company-connection-actions';
import type { WorkbenchView } from '@/buzz/workbench';
import { INSTAGRAM_SIGN_IN_REQUIREMENT } from '@/buzz/app-sign-in-copy';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';

function SearchContent({ scope, view, initialQuery = '', onNavigate }: {
  scope: WorkbenchScope; view: WorkbenchView | null; initialQuery?: string; onNavigate?: () => void;
}) {
  const [showOther, setShowOther] = useState(false);
  const [query, setQuery] = useState(initialQuery);
  const [response, setResponse] = useState<{ query: string; rows: WorkbenchAppSearchResult }>({ query: '', rows: [] });
  const [error, setError] = useState<string | null>(null);
  const actions = useConnectCompanyApp(scope);
  const input = query.trim();
  useEffect(() => {
    if (!input) return;
    let live = true;
    const timer = setTimeout(() => {
      void getWorkbenchSource().searchApps({ query: input }).then(rows => {
        if (live) { setResponse({ query: input, rows }); setError(null); }
      }, () => { if (live) { setResponse({ query: input, rows: [] }); setError('App search is unavailable right now'); } });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [input]);
  const results: WorkbenchAppSearchResult = input ? response.query === input ? response.rows : []
    : (view?.companies?.suggestions ?? []).map(company => ({ appKey: company.appKey, name: company.name,
      domain: company.domain, description: company.purpose, company, mark: company.logo }));
  return <View style={styles.content}>
    <HullDialogInput accessibilityLabel="Search connections" testID="connect-app-input" autoCapitalize="none" autoCorrect={false}
      placeholder="Search apps, keys, and websites" value={query} onChangeText={setQuery} variant="search" />
    <RoomListSectionHeader title={input ? 'Search results' : 'Suggested'} inset="content" spacing="flush" />
    {results.some(item => item.company?.appKey === 'instagram') ? <Text style={styles.note}>{INSTAGRAM_SIGN_IN_REQUIREMENT}</Text> : null}
    {results.map(item => <SettingsRow appBoard key={item.companyId ?? item.company?.providerId ?? item.appKey}
      title={item.name} description={item.description} leading={<ServiceMark company={item.name} domain={item.domain} mark={item.mark} />}
      chevron="right" disabled={Boolean(actions.busy)} testID={`connect-app-${item.appKey}`} onPress={() => {
        const row = item.companyId ? view?.companies?.rows.find(company => company.id === item.companyId) : undefined;
        if (row) { onNavigate?.(); void actions.open(row, view?.apps); }
        else if (item.companyId) {
          onNavigate?.(); router.push({ pathname: '/beeline/settings/workbench/service', params: { ...scope, service: item.companyId } } as Href);
        } else if (item.company) void actions.connect(item.company);
      }} />)}
    {input && results.length === 1 && results[0]?.company?.flow === 'app' && results[0].company.alternativeRoutes?.length ? <View>
      <SettingsRow title="Other sign-in or Trusty Squire" chevron={showOther ? 'up' : 'down'} onPress={() => setShowOther(open => !open)} testID="connectors-other-ways" />
      {showOther ? results[0].company.alternativeRoutes.map(route => <SettingsRow key={route} title={route === 'composio' ? 'Sign in another way' : 'Use Trusty Squire'} chevron="right"
        disabled={Boolean(actions.busy)} onPress={() => void actions.connect({ ...results[0]!.company!, preferredRoute: route })} />) : null}
    </View> : null}
    {input && response.query === input && !results.length && !error ? <Text style={styles.note}>No connections found. Trusty Squire can connect to a website for you.</Text> : null}
    {error || actions.error ? <Text accessibilityRole="alert" style={styles.error}>{error ?? actions.error}</Text> : null}
  </View>;
}

export function ConnectorsSearchSheet({ visible, onClose, scope, view }: {
  visible: boolean; onClose: () => void; scope: WorkbenchScope; view: WorkbenchView | null;
}) {
  return <HullActionSheetModal visible={visible} onClose={onClose} title="Search" testID="connectors-search-sheet"
    footer={<HullActionSheetCancel onPress={onClose} />}>
    {visible ? <SearchContent scope={scope} view={view} onNavigate={onClose} /> : null}
  </HullActionSheetModal>;
}
/** Existing deep-link/search flow stays available; the list itself opens the shared search sheet. */
export default function ConnectAppScreen() {
  useLatencyRouteFrame('/beeline/settings/workbench/connect-app');
  const params = useLocalSearchParams<{ workspaceId?: string; viewerId?: string; query?: string }>();
  const scope = { workspaceId: params.workspaceId ?? '', viewerId: params.viewerId ?? '' };
  const { value: view, error } = useSharedWorkbench(scope.viewerId ? scope : null);
  const insets = useSafeAreaInsets();
  return <View style={[styles.screen, { paddingTop: insets.top }]}>
    <PageHeader eyebrow="Connectors" prominent title="Search" onBack={() => router.back()} backAccessibilityLabel="Back to Connectors" testID="connect-app-header" />
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom }} keyboardShouldPersistTaps="handled" testID="connect-app-scroll">
      {error ? <Text accessibilityRole="alert" style={styles.error}>Connections are unavailable right now</Text> : null}
      <SearchContent scope={scope} view={view} initialQuery={params.query} />
    </ScrollView>
  </View>;
}
const styles = StyleSheet.create(theme => ({
  screen: { flex: 1, backgroundColor: theme.buzz.appCanvas },
  content: { paddingHorizontal: theme.buzz.space.lg, paddingTop: theme.buzz.space.md, paddingBottom: theme.buzz.space.lg, gap: theme.buzz.space.sm },
  note: { ...theme.buzz.type.meta, color: theme.buzz.appQuiet }, error: { ...theme.buzz.type.meta, color: theme.buzz.dialogDanger },
}));
