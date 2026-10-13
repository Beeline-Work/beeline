import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { HullDialogInput } from '@/components/buzz/HullDialog';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { useTextDraft } from '@/buzz/use-text-draft';
import React, { useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import Svg, { Circle, Path } from 'react-native-svg';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { AppMark } from '@/components/buzz/AppMark';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { keyServiceGroups, type KeyServiceGroup } from '@/buzz/connectors-model';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import type { WorkbenchAppSearchResult } from '@beeline/api-contract/workbench';
import { useSharedConnectApp } from '@/buzz/workbench-surface';
import { openAppSignIn } from '@/buzz/app-sign-in';
import { appBoardColors } from '@/buzz/app-board-style';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { INSTAGRAM_SIGN_IN_REQUIREMENT } from '@/buzz/app-sign-in-copy';

function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }

export default function ConnectAppScreen() {
  useLatencyRouteFrame('/beeline/settings/workbench/connect-app');
  const params = useLocalSearchParams<{ workspaceId?: string | string[]; viewerId?: string | string[]; query?: string | string[] }>();
  const workspaceId = first(params.workspaceId) ?? '';
  const viewerId = first(params.viewerId) ?? '';
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useTextDraft(`app-search:${workspaceId}`, first(params.query) ?? '', viewerId);
  const { view, suggestions, error: ownerError } = useSharedConnectApp({ workspaceId, viewerId });
  const apps = view?.apps ?? [];
  const helpers = view?.helpers ?? [];
  const keyGroups: readonly KeyServiceGroup[] = view ? keyServiceGroups(view, viewerId) : [];
  const [searchResults, setSearchResults] = useState<WorkbenchAppSearchResult>([]);
  const [resultsQuery, setResultsQuery] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOther, setShowOther] = useState(false);

  const searchQuery = query.trim();
  useEffect(() => {
    if (!searchQuery) return;
    let live = true;
    const timer = setTimeout(() => {
      void getWorkbenchSource().searchApps({ query: searchQuery }).then(results => {
        if (live) { setSearchResults(results); setResultsQuery(searchQuery); }
      }).catch(() => {
        if (live) { setSearchResults([]); setResultsQuery(searchQuery); setError('App search is unavailable right now'); }
      });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [searchQuery]);
  const filtered = searchQuery
    ? resultsQuery === searchQuery ? searchResults : []
    : (suggestions ?? []);
  const byKey = new Map<string, WorkbenchAppSearchResult[number][]>();
  for (const result of filtered) byKey.set(result.appKey, [...(byKey.get(result.appKey) ?? []), result]);
  const recommendations = [...byKey.values()].map(options =>
    options.find(option => option.registryServerName) ?? options[0]!).filter(Boolean);
  const matchingKey = searchQuery ? keyGroups.find(group => group.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    group.key.includes(searchQuery.toLowerCase())) : undefined;
  if (matchingKey && !byKey.has(matchingKey.key)) recommendations.unshift({ appKey: matchingKey.key,
    name: matchingKey.name, ...(matchingKey.domain ? { domain: matchingKey.domain } : {}) });

  const connect = async (selected: WorkbenchAppSearchResult[number], preferredRoute?: 'composio' | 'squire-api') => {
    if (busy) return;
    const name = selected.name;
    const existing = apps.find(app => app.key === selected.appKey);
    const existingKey = keyGroups.find(group => group.key === selected.appKey);
    if (existingKey) { router.push({ pathname: '/beeline/settings/workbench/service', params: { workspaceId, viewerId, service: existingKey.key } }); return; }
    if (existing) { router.push({ pathname: '/beeline/settings/workbench/app', params: { workspaceId, viewerId, appId: existing.id } }); return; }
    const helper = helpers.find(item => item.online);
    if (!helper) { setError('Connect a helper to use this app'); return; }
    setBusy(name);
    setError(null);
    try {
      const started = await getWorkbenchSource().connectApp({ workspaceId, app: name, helperId: helper.id,
        ...(!preferredRoute && selected.registryServerName ? { registryServerName: selected.registryServerName } : {}),
        ...(!preferredRoute && selected.registryVersion ? { registryVersion: selected.registryVersion } : {}),
        ...(preferredRoute ? { preferredRoute } : {}) });
      if (started.authorizationUrl) await openAppSignIn(started.authorizationUrl, { workspaceId, viewerId, appId: started.appId });
      else router.back();
    } catch (cause) { setError(appErrorCopy(cause instanceof Error ? cause.message : 'Connecting failed')); }
    finally { setBusy(null); }
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]} testID="connect-app-screen">
      <PageHeader eyebrow="Connectors" prominent title="Search" backAccessibilityLabel="Back to Connectors" testID="connect-app-header" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom }} keyboardShouldPersistTaps="handled" testID="connect-app-scroll">
        <View style={styles.searchWrap}>
          <View style={styles.search}>
            <Svg width={18} height={18} viewBox="0 0 24 24" fill="none"><Circle cx={11} cy={11} r={7} stroke={styles.placeholder.color} strokeWidth={2} /><Path d="M20 20l-3.5-3.5" stroke={styles.placeholder.color} strokeWidth={2} strokeLinecap="round" /></Svg>
            <HullDialogInput
              accessibilityLabel="Search connections" testID="connect-app-input" autoCapitalize="none" autoCorrect={false} placeholder="Search apps, keys, and websites" placeholderTextColor={styles.placeholder.color} value={query} onChangeText={setQuery} style={styles.input} variant="boxed"
            />
          </View>
        </View>
        <RoomListSectionHeader
          title={searchQuery ? `RECOMMENDED FOR ${searchQuery.toUpperCase()}` : 'RECOMMENDED'}
        />
        <View style={styles.list}>
          {recommendations.map((app) => {
            const existing = apps.find(item => item.key === app.appKey);
            const connected = existing || keyGroups.some(group => group.key === app.appKey);
            return (
              <TouchableOpacity accessibilityRole="button" key={app.appKey} onPress={() => void connect(app)} style={styles.recommendation} testID={`connect-app-${app.appKey}`}>
            <ServiceMark company={app.name} domain={app.domain} />
            <View style={styles.name}><Text style={styles.nameText}>{connected ? app.name : `Sign in to ${app.name}`}</Text>
              <Text style={styles.description}>{connected ? 'Connected' : app.appKey === 'instagram' ? INSTAGRAM_SIGN_IN_REQUIREMENT : 'Review and approve access'}</Text></View>
            <ChevronGlyph direction="right" size={18} color={styles.connected.color} />
          </TouchableOpacity>
            );
          })}
          {resultsQuery === searchQuery && searchQuery && recommendations.length === 0 ? (
            <Text style={styles.description}>No connections found. Trusty Squire can connect to a website for you.</Text>
          ) : null}
          {searchQuery && recommendations.length > 0 && !apps.some(app => app.key === recommendations[0]?.appKey) && !matchingKey ? (
            <>
              <TouchableOpacity accessibilityRole="button" onPress={() => setShowOther(open => !open)} style={styles.otherWays} testID="connectors-other-ways">
            <Text style={styles.otherWaysLabel}>Other sign-in or Trusty Squire</Text>
            <Text style={styles.otherWaysCount}>{recommendations[0]?.registryServerName && byKey.get(recommendations[0].appKey)?.some(option => !option.registryServerName) ? '2 ways' : '1 way'}</Text>
            <ChevronGlyph direction={showOther ? 'up' : 'down'} size={18} color={styles.connected.color} />
          </TouchableOpacity>
              {showOther ? (
                <>
                  {byKey.get(recommendations[0]!.appKey)?.some(option => !option.registryServerName) && recommendations[0]?.registryServerName ? (
                    <SettingsRow chevron="right" title="Sign in another way" onPress={() => void connect(recommendations[0]!, 'composio')} />
                  ) : null}
                  <SettingsRow chevron="right" title="Use Trusty Squire" onPress={() => void connect(recommendations[0]!, 'squire-api')} />
                </>
              ) : null}
            </>
          ) : null}
        </View>
        {error || ownerError ? (
          <Text accessibilityRole="alert" style={styles.error}>{error ?? 'Apps are unavailable right now'}</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create(theme => {
  const hull = theme.buzz;
  const board = appBoardColors(hull);
  return {
  screen: { flex: 1, backgroundColor: board.canvas },
  searchWrap: { paddingHorizontal: hull.space.lg, paddingTop: 16, paddingBottom: hull.space.sm },
  search: { flexDirection: 'row', alignItems: 'center', gap: hull.space.sm, height: 48, paddingHorizontal: hull.space.md, borderWidth: 1, borderColor: board.strongBorder, borderRadius: theme.buzz.radius, backgroundColor: board.tile },
  input: { ...Typography.ledger(), ...hull.type.body, flex: 1, color: board.ink, paddingVertical: 0 },
  placeholder: { color: board.quiet },
  list: { paddingHorizontal: hull.space.lg },
  recommendation: { minHeight: 88, flexDirection: 'row', alignItems: 'center', gap: hull.space.md,
    borderWidth: 1, borderColor: board.strongBorder, borderRadius: hull.radius, backgroundColor: board.card,
    paddingHorizontal: hull.space.md, marginBottom: hull.space.md },
  name: { flex: 1 },
  nameText: { ...Typography.ledger(), ...hull.type.body, color: board.ink },
  description: { ...Typography.ledger(), ...hull.type.meta, color: board.quiet },
  connected: { ...Typography.ledger(), ...hull.type.meta, color: board.quiet },
  otherWays: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: hull.space.sm,
    borderBottomWidth: 1, borderBottomColor: board.border, paddingHorizontal: hull.space.sm },
  otherWaysLabel: { ...Typography.ledger(), ...hull.type.meta, color: board.ink, flex: 1 },
  otherWaysCount: { ...Typography.ledger(), ...hull.type.meta, color: board.quiet },
  error: { ...Typography.default(), margin: hull.space.lg, color: theme.buzz.dialogDanger },
  row: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: hull.space.md, paddingVertical: hull.space.sm, borderBottomWidth: 1, borderBottomColor: board.border },
};
});
