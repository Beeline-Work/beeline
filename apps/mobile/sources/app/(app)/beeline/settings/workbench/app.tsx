import React, { useCallback, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { AppMark } from '@/components/buzz/AppMark';
import { AppPageHeader } from '@/components/buzz/AppPageHeader';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { openAppSignIn } from '@/buzz/app-sign-in';
import type { WorkbenchApp } from '@/buzz/workbench';
import { appBoardColors } from '@/buzz/app-board-style';

function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }

export default function AppDetailScreen() {
  const params = useLocalSearchParams<{ workspaceId?: string | string[]; viewerId?: string | string[]; appId?: string | string[] }>();
  const workspaceId = first(params.workspaceId) ?? '';
  const viewerId = first(params.viewerId) ?? '';
  const appId = first(params.appId) ?? '';
  const insets = useSafeAreaInsets();
  const [app, setApp] = useState<WorkbenchApp | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    let live = true;
    void getWorkbenchSource().readWorkbench({ workspaceId, viewerId }).then(view => {
      if (live) setApp(view.apps.find(item => item.id === appId) ?? null);
    }).catch(() => { if (live) setError('App unavailable right now'); });
    return () => { live = false; };
  }, [appId, viewerId, workspaceId]));

  const disconnect = async () => {
    if (!app || working) return;
    setWorking(true);
    setError(null);
    try { await getWorkbenchSource().disconnectApp({ workspaceId, appId: app.id }); router.back(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not disconnect app'); }
    finally { setWorking(false); }
  };

  const reconnect = async () => {
    if (!app || working) return;
    setWorking(true);
    setError(null);
    try {
      const started = await getWorkbenchSource().beginAppSignIn({ appId: app.id });
      await openAppSignIn(started.authorizationUrl, { workspaceId, viewerId });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not connect app'); }
    finally { setWorking(false); }
  };

  const lastUsed = app?.lastUse
    ? `Last used by ${app.lastUse.agentName} in ${app.lastUse.roomName.startsWith('#') ? '' : '#'}${app.lastUse.roomName}, ${new Date(app.lastUse.usedAt * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}.`
    : app?.lastUsedAt
      ? `Last used ${new Date(app.lastUsedAt * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}.`
      : 'Not used yet.';

  return <View style={[styles.screen, { paddingTop: insets.top }]} testID="app-detail-screen">
    <AppPageHeader eyebrow="Workbench" title={app?.name ?? 'App'} backLabel="Back to Workbench" onBack={() => router.back()} />
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 24 + insets.bottom }]} testID="app-detail-scroll">
      {app ? <>
        <View style={styles.identity}>
          <AppMark name={app.name} domain={app.domain} size={48} />
          <View style={styles.identityCopy}>
            <Text style={styles.status}>{app.status === 'connected' ? 'Connected' : app.status === 'connecting' ? 'Connecting' : 'Needs attention'}</Text>
            {app.accountLabel ? <Text style={styles.account}>{app.accountLabel}{app.workspaceName ? ` · ${app.workspaceName} workspace` : ''}</Text> : null}
          </View>
        </View>
        <Text style={styles.permission}>Your agents can use {app.name} as you. Other people’s agents ask you first.</Text>
        <Text style={styles.lastUsed}>{lastUsed}</Text>
        {app.status === 'connected' ? <TouchableOpacity accessibilityRole="button" disabled={working} onPress={() => void disconnect()} style={styles.outline} testID="app-detail-disconnect"><Text style={styles.outlineText}>{working ? 'Disconnecting' : 'Disconnect'}</Text></TouchableOpacity> : <TouchableOpacity accessibilityRole="button" disabled={working} onPress={() => void reconnect()} style={styles.ink} testID="app-detail-connect"><Text style={styles.inkText}>{working ? 'Connecting' : `Connect ${app.name}`}</Text></TouchableOpacity>}
      </> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create(theme => {
  const hull = theme.buzz;
  const board = appBoardColors(hull);
  return {
  screen: { flex: 1, backgroundColor: board.canvas },
  content: { paddingHorizontal: 20, paddingVertical: 24, gap: 18 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  identityCopy: { gap: 2 },
  status: { ...Typography.ledger(), ...hull.type.body, color: board.ink },
  account: { ...Typography.ledger(), ...hull.type.meta, color: board.quiet },
  permission: { ...Typography.ledger(), ...hull.type.meta, color: board.secondary },
  lastUsed: { ...Typography.ledger(), ...hull.type.meta, color: board.quiet },
  outline: { alignSelf: 'flex-start', minHeight: 44, paddingHorizontal: 18, justifyContent: 'center', borderRadius: 10, borderWidth: 2, borderColor: board.buttonOutline },
  outlineText: { ...Typography.ledger(), ...hull.type.body, color: board.buttonOutline },
  ink: { alignSelf: 'flex-start', minHeight: 44, paddingHorizontal: 18, justifyContent: 'center', borderRadius: 10, backgroundColor: board.buttonFill },
  inkText: { ...Typography.ledger(), ...hull.type.body, color: board.buttonText },
  error: { ...Typography.default(), color: theme.buzz.dialogDanger },
  };
});
