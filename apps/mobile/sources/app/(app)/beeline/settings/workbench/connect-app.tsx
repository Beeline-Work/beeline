import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import Svg, { Circle, Path } from 'react-native-svg';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { AppMark } from '@/components/buzz/AppMark';
import { AppPageHeader } from '@/components/buzz/AppPageHeader';
import { POPULAR_APPS } from '@/buzz/app-catalog';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import type { WorkbenchApp, WorkbenchHelper } from '@/buzz/workbench';
import { openAppSignIn } from '@/buzz/app-sign-in';
import { appBoardColors } from '@/buzz/app-board-style';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { INSTAGRAM_SIGN_IN_REQUIREMENT } from '@/buzz/app-sign-in-copy';

function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }

export default function ConnectAppScreen() {
  const params = useLocalSearchParams<{ workspaceId?: string | string[]; viewerId?: string | string[] }>();
  const workspaceId = first(params.workspaceId) ?? '';
  const viewerId = first(params.viewerId) ?? '';
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [apps, setApps] = useState<readonly WorkbenchApp[]>([]);
  const [appCatalog, setAppCatalog] = useState<readonly { appKey: string; description?: string; logo?: string }[]>([]);
  const [helpers, setHelpers] = useState<readonly WorkbenchHelper[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getWorkbenchSource().readWorkbench({ workspaceId, viewerId }).then(view => {
      if (live) { setApps(view.apps); setAppCatalog(view.appCatalog ?? []); setHelpers(view.helpers); }
    }).catch(() => { if (live) setError('Apps are unavailable right now'); });
    return () => { live = false; };
  }, [viewerId, workspaceId]);

  const filtered = useMemo(() => {
    const matched = POPULAR_APPS.filter(app => app.name.toLowerCase().includes(query.trim().toLowerCase()));
    if (!query.trim() || matched.length) return matched;
    return [{ name: query.trim(), domain: undefined }];
  }, [query]);

  const connect = async (name: string) => {
    if (busy) return;
    const existing = apps.find(app => app.name.toLowerCase() === name.toLowerCase());
    if (existing?.status === 'connected') return;
    const helper = helpers.find(item => item.online);
    if (!helper) { setError('Connect a helper to use this app'); return; }
    setBusy(name);
    setError(null);
    try {
      const started = await getWorkbenchSource().connectApp({ workspaceId, app: name, helperId: helper.id, ...(existing?.status === 'error' ? { reconnect: true } : {}) });
      if (started.authorizationUrl) await openAppSignIn(started.authorizationUrl, { workspaceId, viewerId, appId: started.appId });
      else router.back();
    } catch (cause) { setError(appErrorCopy(cause instanceof Error ? cause.message : 'Connecting failed')); }
    finally { setBusy(null); }
  };

  const disconnect = async (app: WorkbenchApp) => {
    if (busy) return;
    setBusy(app.name);
    setError(null);
    try {
      await getWorkbenchSource().disconnectApp({ workspaceId, appId: app.id });
      setApps(current => current.filter(item => item.id !== app.id));
    } catch (cause) { setError(appErrorCopy(cause instanceof Error ? cause.message : 'Could not disconnect app')); }
    finally { setBusy(null); }
  };

  return <View style={[styles.screen, { paddingTop: insets.top }]} testID="connect-app-screen">
    <AppPageHeader eyebrow="Workbench" title="Connect an app" backLabel="Back to Workbench" testID="connect-app-header" onBack={() => router.back()} />
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom }} keyboardShouldPersistTaps="handled" testID="connect-app-scroll">
      <View style={styles.searchWrap}>
        <View style={styles.search}>
          <Svg width={18} height={18} viewBox="0 0 24 24" fill="none"><Circle cx={11} cy={11} r={7} stroke={styles.placeholder.color} strokeWidth={2} /><Path d="M20 20l-3.5-3.5" stroke={styles.placeholder.color} strokeWidth={2} strokeLinecap="round" /></Svg>
          <TextInput accessibilityLabel="Search apps" testID="connect-app-input" autoCapitalize="none" autoCorrect={false} placeholder="Search 1,500+ apps" placeholderTextColor={styles.placeholder.color} value={query} onChangeText={setQuery} style={styles.input} />
        </View>
      </View>
      <Text style={styles.section}>POPULAR</Text>
      <View style={styles.list}>
        {filtered.map(app => {
          const existing = apps.find(item => item.name.toLowerCase() === app.name.toLowerCase());
          const key = app.name.toLowerCase().replaceAll(' ', '');
          const metadata = appCatalog.find(item => item.appKey === key);
          return <View key={app.name} style={styles.row} testID={`connect-app-${app.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}>
            <AppMark name={app.name} domain={app.domain} logo={metadata?.logo ?? existing?.logo} size={34} />
            <View style={styles.name}><Text style={styles.nameText} numberOfLines={1}>{app.name}</Text>{key === 'instagram' ? <Text style={styles.description}>{INSTAGRAM_SIGN_IN_REQUIREMENT}</Text> : metadata?.description ? <Text style={styles.description} numberOfLines={2}>{metadata.description}</Text> : null}</View>
            {existing?.status === 'connected' ? <Text style={styles.connected}>connected</Text> : <TouchableOpacity accessibilityRole="button" disabled={busy !== null} onPress={() => void connect(app.name)} style={styles.button}><Text style={styles.buttonText}>{busy === app.name ? 'Connecting' : existing?.status === 'error' ? 'Retry' : 'Connect'}</Text></TouchableOpacity>}
            {existing ? <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Disconnect ${app.name}`} disabled={busy !== null} onPress={() => void disconnect(existing)} testID={`disconnect-app-${app.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}><Text style={styles.connected}>Disconnect</Text></TouchableOpacity> : null}
          </View>;
        })}
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create(theme => {
  const hull = theme.buzz;
  const board = appBoardColors(hull);
  return {
  screen: { flex: 1, backgroundColor: board.canvas },
  searchWrap: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 6 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 48, paddingHorizontal: 14, borderWidth: 1, borderColor: board.strongBorder, borderRadius: 12, backgroundColor: board.tile },
  input: { ...Typography.ledger(), ...hull.type.body, flex: 1, color: board.ink, paddingVertical: 0 },
  placeholder: { color: board.quiet },
  section: { ...Typography.default(), ...hull.type.sectionHead, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4, color: board.quiet },
  list: { paddingHorizontal: 20 },
  row: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: board.border },
  name: { flex: 1 },
  nameText: { ...Typography.ledger(), ...hull.type.body, color: board.ink },
  description: { ...Typography.ledger(), ...hull.type.meta, color: board.quiet },
  connected: { ...Typography.ledger(), ...hull.type.meta, color: board.quiet },
  button: { minHeight: 36, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 9, backgroundColor: board.buttonFill },
  buttonText: { ...Typography.ledger(), ...hull.type.body, color: board.buttonText },
  error: { ...Typography.default(), margin: 20, color: theme.buzz.dialogDanger },
  };
});
