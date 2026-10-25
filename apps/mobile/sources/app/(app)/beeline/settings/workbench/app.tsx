import { useIsDesktop as useDesktopPageLayout } from '@/utils/responsive';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { AppMark } from '@/components/buzz/AppMark';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { HullActionSheetModal, HullActionSheetRow, HullActionSheetCancel } from '@/components/buzz/HullActionSheet';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { useSharedWorkbench } from '@/buzz/workbench-surface';
import { appNeedsSquire, reconnectWorkbenchApp } from '@/buzz/app-reconnect';
import type { WorkbenchApp } from '@/buzz/workbench';
import { appBoardColors } from '@/buzz/app-board-style';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { INSTAGRAM_SIGN_IN_REQUIREMENT } from '@/buzz/app-sign-in-copy';

function first(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }

export default function AppDetailScreen() {
  useLatencyRouteFrame('/beeline/settings/workbench/app');
  const params = useLocalSearchParams<{ workspaceId?: string | string[]; viewerId?: string | string[]; appId?: string | string[] }>();
  const workspaceId = first(params.workspaceId) ?? '';
  const viewerId = first(params.viewerId) ?? '';
  const appId = first(params.appId) ?? '';
  const insets = useSafeAreaInsets();
  const desktopPageLayout = useDesktopPageLayout();
  const { value: view, error: loadError } = useSharedWorkbench({ workspaceId, viewerId });
  const [appOverride, setAppOverride] = useState<WorkbenchApp | null>(null);
  const app = appOverride ?? view?.apps.find(item => item.id === appId) ?? null;
  useEffect(() => { setAppOverride(null); }, [view]);
  useLatencyRouteFrame('/beeline/settings/workbench/app', app !== null, true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const needsSquire = app ? appNeedsSquire(app) : false;

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
    if (needsSquire) {
      router.push({ pathname: '/beeline/settings/workbench/connect',
        params: { workspaceId, viewerId, connectorId: 'trusty-squire' } });
      return;
    }
    setWorking(true);
    setError(null);
    setConnectionNotice(null);
    try { setConnectionNotice(await reconnectWorkbenchApp(app, { workspaceId, viewerId })); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not connect app';
      setError(appErrorCopy(message));
      setAppOverride(app ? { ...app, status: 'error', errorMessage: message } : null);
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

  return (
    <View style={[styles.screen, desktopPageLayout && { width: '100%', maxWidth: 640, alignSelf: 'center' }, { paddingTop: insets.top }]} testID="app-detail-screen">
      <PageHeader eyebrow="Connectors" prominent title={app?.name ?? 'App'} backAccessibilityLabel="Back to Connectors" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 24 + insets.bottom }]} testID="app-detail-scroll">
        {app ? (
          <>
            <View style={styles.identity}><AppMark name={app.name} domain={app.domain} logo={app.logo} size={36} />
          <Text style={styles.account}>{app.status === 'connected' ? app.key === 'gmail' ? 'Signed in · Google' : 'Signed in' : app.status === 'connecting' ? 'Connecting' : 'Offline'}</Text>
        </View>
            <SettingsRow title="Status" value={app.status === 'connected' ? 'Connected' : app.status === 'connecting' ? 'Connecting' : 'Offline'}
          statusGlyph={app.status === 'connected' ? 'live' : app.status === 'connecting' ? 'pulse' : 'failed'}
          valueTone={app.status === 'error' ? 'danger' : undefined}
          trailingPress={{ accessibilityLabel: 'Change connection', onPress: () => setStatusOpen(true) }} />
            {app.status === 'error' && app.transport !== 'composio' ? (
              // The computer that will retry, with the retry one tap away.
              <SettingsRow title={needsSquire ? 'Trusty Squire' : app.helperName ?? 'Your computer'}
                description={needsSquire ? 'Connect Trusty Squire first' : `Retries ${app.name} on this computer`}
                action={working ? undefined : needsSquire ? 'Connect' : 'Reconnect'} disabled={working}
                onPress={() => void reconnect()} testID="app-detail-reconnect" />
            ) : null}
            <View>
              <RoomListSectionHeader title="WHAT YOUR AGENTS CAN DO" inset="content" spacing="flush" />
              <Text style={styles.permission}>{app.key === 'gmail' ? 'Let agents work with your mail when you ask them to.' :
            `Let agents use ${app.name} when you ask them to.`}</Text>
              {(app.key === 'gmail' ? ['Find the latest invoice', 'Draft a reply to Alex', 'Send the reply I approved'] :
            [`Use ${app.name} for this task`]).map((example) => (
                <Text key={example} style={styles.example}>“{example}”</Text>
              ))}
            </View>
            {description ? <Text style={styles.permission}>{description}</Text> : null}
            {app.key === 'instagram' && app.status !== 'connected' ? (
              <Text style={styles.permission}>{INSTAGRAM_SIGN_IN_REQUIREMENT}</Text>
            ) : null}
            <Text style={styles.lastUsed}>{lastUsed}</Text>
            {connectionNotice ? (
              <Text accessibilityLiveRegion="polite" style={styles.permission} testID="app-detail-connection-notice">{connectionNotice}</Text>
            ) : null}
          </>
        ) : null}
        {error || loadError || (app?.status === 'error' && app.errorMessage) ? (
          <Text accessibilityRole="alert" style={styles.error}>{error ?? (loadError ? 'App unavailable right now' : null) ?? (app && needsSquire
        ? `${app.name} connects through Trusty Squire. Connect Trusty Squire, then return here to connect ${app.name}.`
        : app?.transport !== 'composio' && app?.errorMessage === 'App sign-in is unavailable for this person'
          ? `${app.name} connects through your helper. Retry to ask your helper to finish connecting it.`
          : appErrorCopy(app?.errorMessage ?? ''))}</Text>
        ) : null}
      </ScrollView>
      <HullActionSheetModal visible={statusOpen} title={app?.name} onClose={() => setStatusOpen(false)}>
        {app?.status !== 'connected' ? (
          <HullActionSheetRow label={needsSquire ? 'Reconnect Trusty Squire' : 'Reconnect'} disabled={working} onPress={() => { setStatusOpen(false); void reconnect(); }} />
        ) : null}
        <HullActionSheetRow label="Disconnect" destructive disabled={working} onPress={() => { setStatusOpen(false); void disconnect(); }} />
        <HullActionSheetCancel onPress={() => setStatusOpen(false)} />
      </HullActionSheetModal>
    </View>
  );
}

const styles = StyleSheet.create(theme => {
  const hull = theme.buzz;
  const board = appBoardColors(hull);
  return {
  screen: { flex: 1, backgroundColor: board.canvas },
  content: { paddingHorizontal: hull.space.lg, paddingVertical: 24, gap: hull.space.md },
  identity: { flexDirection: 'row', alignItems: 'center', gap: hull.space.md },
  example: { ...Typography.ledger(), ...hull.type.body, color: board.ink, borderLeftWidth: 2, borderLeftColor: board.brass,
    paddingLeft: hull.space.md, paddingVertical: hull.space.sm },
  account: { ...Typography.ledger(), ...hull.type.meta, color: board.quiet },
  permission: { ...Typography.ledger(), ...hull.type.meta, color: board.secondary },
  lastUsed: { ...Typography.ledger(), ...hull.type.meta, color: board.quiet },
  error: { ...Typography.default(), color: theme.buzz.dialogDanger },
  identityCopy: { gap: hull.space.xs },
status: { ...Typography.ledger(), ...hull.type.body, color: board.ink },
action: { alignSelf: 'flex-start' },
};
});
