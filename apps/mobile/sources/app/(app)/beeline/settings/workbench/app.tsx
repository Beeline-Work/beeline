import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { AppMark } from '@/components/buzz/AppMark';
import { Button } from '@/components/buzz/Button';
import { AppPageHeader } from '@/components/buzz/AppPageHeader';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { openAppSignIn } from '@/buzz/app-sign-in';
import type { WorkbenchApp } from '@/buzz/workbench';
import { appBoardColors } from '@/buzz/app-board-style';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { INSTAGRAM_SIGN_IN_REQUIREMENT } from '@/buzz/app-sign-in-copy';

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
    catch (cause) { setError(appErrorCopy(cause instanceof Error ? cause.message : 'Could not disconnect app')); }
    finally { setWorking(false); }
  };

  const reconnect = async () => {
    if (!app || working) return;
    setWorking(true);
    setError(null);
    try {
      const started = await getWorkbenchSource().beginAppSignIn({ appId: app.id });
      await openAppSignIn(started.authorizationUrl, { workspaceId, viewerId, appId: app.id });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not connect app';
      setError(appErrorCopy(message));
      setApp(current => current ? { ...current, status: 'error', errorMessage: message } : current);
    }
    finally { setWorking(false); }
  };

  const lastUsed = app?.lastUse
    ? `Last used by ${app.lastUse.agentName} in ${app.lastUse.roomName.startsWith('#') ? '' : '#'}${app.lastUse.roomName}, ${new Date(app.lastUse.usedAt * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}.`
    : app?.lastUsedAt
      ? `Last used ${new Date(app.lastUsedAt * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}.`
      : 'Not used yet.';
  const providerDescription = app?.description?.trim();
  const description = providerDescription && !/^use\s+.+\s+tools\.?$/i.test(providerDescription)
    ? providerDescription
    : app?.key === 'neon'
      ? 'Neon provides serverless Postgres databases for applications.'
      : null;

  return <View style={[styles.screen, { paddingTop: insets.top }]} testID="app-detail-screen">
    <AppPageHeader eyebrow="Workbench" title={app?.name ?? 'App'} backLabel="Back to Workbench" onBack={() => router.back()} />
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 24 + insets.bottom }]} testID="app-detail-scroll">
      {app ? <>
        <View style={styles.identity}>
          <AppMark name={app.name} domain={app.domain} logo={app.logo} size={48} />
          <View style={styles.identityCopy}>
            <Text style={styles.status}>{app.status === 'connected' ? 'Connected' : app.status === 'connecting' ? 'Connecting' : 'Connection failed'}</Text>
            {app.accountLabel ? <Text style={styles.account}>{app.accountLabel}{app.workspaceName ? ` · ${app.workspaceName} workspace` : ''}</Text> : null}
          </View>
        </View>
        {description ? <Text style={styles.permission}>{description}</Text> : null}
        {app.key === 'instagram' && app.status !== 'connected' ? <Text style={styles.permission}>{INSTAGRAM_SIGN_IN_REQUIREMENT}</Text> : null}
        <Text style={styles.permission}>Your agents can use {app.name} as you. Other people’s agents ask you first.</Text>
        <Text style={styles.lastUsed}>{lastUsed}</Text>
        {app.status !== 'connected' ? <Button disabled={working} label={working ? 'Connecting' : app.status === 'error' ? `Retry ${app.name}` : `Connect ${app.name}`} onPress={() => void reconnect()} style={styles.action} testID="app-detail-connect" /> : null}
        <Button disabled={working} label={working ? 'Disconnecting' : 'Disconnect'} onPress={() => void disconnect()} style={styles.action} testID="app-detail-disconnect" variant="secondary" />
      </> : null}
      {error || app?.status === 'error' && app.errorMessage ? <Text accessibilityRole="alert" style={styles.error}>{error ?? appErrorCopy(app?.errorMessage ?? '')}</Text> : null}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create(theme => {
  const hull = theme.buzz;
  const board = appBoardColors(hull);
  return {
  screen: { flex: 1, backgroundColor: board.canvas },
  content: { paddingHorizontal: hull.space.lg, paddingVertical: 24, gap: hull.space.md },
  identity: { flexDirection: 'row', alignItems: 'center', gap: hull.space.md },
  identityCopy: { gap: hull.space.xs },
  status: { ...Typography.ledger(), ...hull.type.body, color: board.ink },
  account: { ...Typography.ledger(), ...hull.type.meta, color: board.quiet },
  permission: { ...Typography.ledger(), ...hull.type.meta, color: board.secondary },
  lastUsed: { ...Typography.ledger(), ...hull.type.meta, color: board.quiet },
  action: { alignSelf: 'flex-start' },
  error: { ...Typography.default(), color: theme.buzz.dialogDanger },
  };
});
