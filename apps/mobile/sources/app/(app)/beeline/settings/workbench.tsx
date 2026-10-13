import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import React, { useCallback, useEffect, useState } from 'react';
import { Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { useIsDesktop } from '@/utils/responsive';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { ToolDetailsCell } from '@/components/buzz/ToolDetailsCell';
import { NetworkUnavailableState } from '@/components/buzz/NetworkUnavailableState';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { readSharedWorkbench, useSharedWorkbench } from '@/buzz/workbench-surface';
import { publishSharedWallet } from '@/buzz/wallet-surface';
import { getWalletSource } from '@/buzz/wallet-source';
import { resolveWalletWorkspaceId } from '@/buzz/wallet-workspace';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import { PageHeader } from '@/components/buzz/PageHeader';
import { AppMark } from '@/components/buzz/AppMark';
import { appBoardColors } from '@/buzz/app-board-style';
import { TOOL_BRAND_MARKS } from '@/buzz/tool-brand-marks';
import { HullActionSheetModal, HullActionSheetRow, HullActionSheetCancel } from '@/components/buzz/HullActionSheet';
import { keyServiceGroups, squireConnectionState } from '@/buzz/connectors-model';
import { authSessionOptions } from '@/auth/auth-session';
import {
  MonolithPhoneOperationError,
  phoneOperationFailureReason,
} from '@/sync/transport/monolith-operation';
import {
  googleEntryConnector,
} from '@/buzz/workbench';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const RECOMMENDED_CONNECTIONS = [
  { key: 'link', name: 'Link', subtitle: 'Approve agent purchases with Link', domain: 'link.com' },
  { key: 'linear', name: 'Linear', subtitle: 'Sign in to manage issues', domain: 'linear.app' },
  { key: 'instagram', name: 'Instagram', subtitle: 'Sign in to your account', domain: 'instagram.com' },
  { key: 'slack', name: 'Slack', subtitle: 'Sign in to your workspace', domain: 'slack.com' },
  { key: 'calendar', name: 'Calendar', subtitle: 'Sign in to your calendar', domain: 'calendar.google.com' },
  { key: 'drive', name: 'Drive', subtitle: 'Sign in to your files', domain: 'drive.google.com' },
  { key: 'jira', name: 'Jira', subtitle: 'Sign in to manage projects', domain: 'atlassian.com' },
  { key: 'tiktok', name: 'TikTok', subtitle: 'Sign in to TikTok', domain: 'tiktok.com' },
  { key: 'tailscale', name: 'Tailscale', subtitle: 'Connect your network', domain: 'tailscale.com' },
  { key: 'wallet', name: 'Coinbase wallet', subtitle: 'Connect your wallet', domain: 'coinbase.com' },
] as const;

/** Person-owned Connectors settings: key services, sign-ins, and recommendations. */
export default function WorkbenchScreen() {
  useLatencyRouteFrame('/beeline/settings/workbench');
  const params = useLocalSearchParams<{
    workspaceId?: string | string[];
    viewerId?: string | string[];
    googleNotice?: string | string[];
  }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const activeWorkspaceId = useActiveCommunityId();
  const ownerWorkspaceId = workspaceId || activeWorkspaceId || '';
  const viewerId = firstParam(params.viewerId) ?? '';
  const desktop = useIsDesktop();
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const { value: view, error: loadError } = useSharedWorkbench(
    viewerId ? { workspaceId: ownerWorkspaceId, viewerId } : null);
  const [networkFailure, setNetworkFailure] = useState<'load' | 'wallet' | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [linkConnecting, setLinkConnecting] = useState(false);
  const [linkDisconnecting, setLinkDisconnecting] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [walletWorkspaceMissing, setWalletWorkspaceMissing] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [statusAction, setStatusAction] = useState<{ title: string; disconnect: () => void } | null>(null);
  const load = useCallback(
    async (refreshVault = false) => {
      try {
        const next = await readSharedWorkbench({ workspaceId: ownerWorkspaceId, viewerId },
          { refresh: true, refreshVault });
        setNetworkFailure(null);
        return next;
      } catch {
        setNetworkFailure('load');
        return undefined;
      }
    },
    [ownerWorkspaceId, viewerId],
  );

  useEffect(() => { setNetworkFailure((current) =>
    (loadError ? 'load' : current === 'load' ? null : current)); }, [loadError]);

  const apps = view?.apps ?? [];
  const keyGroups = view ? keyServiceGroups(view, viewerId) : [];
  const squireState = view ? squireConnectionState(view) : 'never';
  const connectors = view?.connectors ?? [];

  const connectConnector = useCallback(
    async (connectorId: string) => {
      router.push({
        pathname: '/beeline/settings/workbench/connect',
        params: { workspaceId, viewerId, connectorId },
      } as unknown as Href);
    },
    [workspaceId, viewerId],
  );

  const disconnectConnector = useCallback(
    async (connectorId: string) => {
      if (disconnectingId) return;
      setDisconnectingId(connectorId);
      setNetworkFailure(null);
      try {
        await getWorkbenchSource().disconnectConnector({ workspaceId, connectorId });
        await load();
      } catch {
        setNetworkFailure('load');
      } finally {
        setDisconnectingId(null);
      }
    },
    [disconnectingId, load, workspaceId],
  );

  const openConnectApp = useCallback(() => {
    router.push({
      pathname: '/beeline/settings/workbench/connect-app',
      params: { workspaceId: ownerWorkspaceId, viewerId },
    } as unknown as Href);
  }, [ownerWorkspaceId, viewerId]);

  const openWallet = useCallback(async () => {
    try {
      const selectedId = await resolveWalletWorkspaceId(workspaceId, activeWorkspaceId);
      if (!selectedId) {
        setWalletWorkspaceMissing(true);
        return;
      }
      setWalletWorkspaceMissing(false);
      router.push({
        pathname: '/beeline/settings/workbench/wallet-service',
        params: { workspaceId: selectedId },
      } as unknown as Href);
    } catch {
      setNetworkFailure('wallet');
    }
  }, [activeWorkspaceId, workspaceId]);

  const connectWallet = useCallback(async () => {
    if (walletConnecting) return;
    setWalletConnecting(true);
    setNetworkFailure(null);
    try {
      const selectedId = await resolveWalletWorkspaceId(workspaceId, activeWorkspaceId);
      if (!selectedId) {
        setWalletWorkspaceMissing(true);
        return;
      }
      setWalletWorkspaceMissing(false);
      // Connecting IS the grant: agents may sign only after it lands, so the
      // row reads connected only then.
      const wallet = await getWalletSource().createWallet({ workspaceId: selectedId });
      const grant = await getWalletSource().grantDelegation({ workspaceId: selectedId });
      await publishSharedWallet(selectedId, { ...wallet,
        delegation: { active: true, expiresAt: grant.expiresAt } });
      if (ownerWorkspaceId) await readSharedWorkbench({ workspaceId: ownerWorkspaceId, viewerId },
        { refresh: true });
      router.push({
        pathname: '/beeline/settings/workbench/wallet',
        params: { workspaceId: selectedId },
      } as unknown as Href);
    } catch {
      setNetworkFailure('wallet');
    } finally {
      setWalletConnecting(false);
    }
  }, [activeWorkspaceId, ownerWorkspaceId, viewerId, walletConnecting, workspaceId]);

  const connectLink = useCallback(async () => {
    if (linkConnecting) return;
    setLinkConnecting(true);
    setLinkError(null);
    try {
      const { authorizationUrl } = await getWorkbenchSource().beginLinkSignIn();
      const state = new URL(authorizationUrl).searchParams.get('state') ?? undefined;
      const returnUri = 'beeline://beeline/settings/workbench';
      const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, returnUri,
        authSessionOptions(Platform.OS, returnUri));
      if (result.type !== 'success') await getWorkbenchSource().cancelLinkSignIn(state);
      await load();
    } catch (error) {
      // The server's refusal is the point (a control that refuses without
      // saying why reads as a control that does nothing); a browser-session
      // hiccup keeps the generic retry line.
      setLinkError(error instanceof MonolithPhoneOperationError
        ? phoneOperationFailureReason(error)
        : 'Link sign-in did not finish. Tap Connect to try again.');
    } finally {
      setLinkConnecting(false);
    }
  }, [linkConnecting, load]);

  const disconnectLink = useCallback(async () => {
    if (linkDisconnecting) return;
    setLinkDisconnecting(true);
    try {
      await getWorkbenchSource().disconnectLinkSignIn();
      await load();
    } catch (error) {
      setLinkError(phoneOperationFailureReason(error));
    } finally {
      setLinkDisconnecting(false);
    }
  }, [linkDisconnecting, load]);

  // The screen has three states, and they must not bleed into each other. A
  // failed load used to still render the section chrome and the "None yet"
  // empty state with a red banner pinned to the very bottom (behind the
  // system nav bar), so an error read as a populated-but-empty page. Gate the
  // sections on a real load; show a centered error or loader otherwise.
  const loading = view === null && networkFailure === null;
  const screenStyle = [styles.container, { paddingTop: desktop ? 0 : insets.top }];
  const header = (
    <PageHeader prominent backAccessibilityLabel="Back to Settings" eyebrow="Settings" title="Connectors" testID="workbench-header" onBack={() => router.back()} />
  );

  if (networkFailure) {
    return (
      <View style={screenStyle}>
        {header}
        <NetworkUnavailableState
          onRetry={() => void (networkFailure === 'wallet' ? connectWallet() : load())}
          testID="workbench-network-unavailable"
        />
      </View>
    );
  }

  if (walletWorkspaceMissing) {
    return (
      <View style={screenStyle}>
        {header}
        <Text testID="workbench-wallet-workspace-missing">
          Join or select a Workspace, then open Wallet again.
        </Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={screenStyle}>
        {header}
        <View style={styles.centered} testID="workbench-loading">
          <SurfaceGlyphLoader testID="workbench-loader" />
        </View>
      </View>
    );
  }

  return (
    <View style={screenStyle}>
      {header}
      <ScrollView
        style={styles.content}
        contentContainerStyle={[styles.contentInner, { paddingBottom: theme.buzz.space.xxl + insets.bottom }]}
        testID="workbench-scroll"
      >
        <TouchableOpacity accessibilityRole="button" onPress={openConnectApp} style={styles.searchBox} testID="connectors-search">
          <Text style={styles.searchIcon}>⌕</Text><Text style={styles.searchPlaceholder}>Search apps, keys, and websites</Text>
        </TouchableOpacity>
        <View testID="connectors-your-connections">
          <RoomListSectionHeader title="YOUR CONNECTIONS" inset="content" spacing="flush" />
          {(view?.helpers ?? []).map((helper ) => (
            <SettingsRow appBoard chevron="right" key={`squire:${helper.id}`}
            title={`Trusty Squire · ${helper.name}`}
            description={helper.squire?.errorMessage ?? 'Hands-off sign-in'}
            leading={<ServiceMark company="Trusty Squire" />}
            value={helper.squire?.status === 'connected' ? 'Connected' : helper.squire?.status === 'error' ? 'Error' : 'Not added'}
            statusGlyph={helper.squire?.status === 'connected' ? 'live' : helper.squire?.status === 'error' ? 'failed' : undefined}
            valueTone={helper.squire?.status === 'error' ? 'danger' : undefined}
            onPress={() => router.push({ pathname: '/beeline/settings/workbench/service', params: { workspaceId, viewerId, service: 'trusty-squire', helperId: helper.id } } as unknown as Href)} />
          ))}
          {keyGroups.map((group) => (
            <SettingsRow appBoard chevron="right" key={group.key} title={group.name}
            description={`${group.keys.length === 1 ? 'Key' : `${group.keys.length} keys`} · Trusty Squire`}
            leading={<ServiceMark company={group.name} domain={group.domain} />}
            value={squireState === 'offline' ? 'Offline' : undefined}
            valueTone={squireState === 'offline' ? 'danger' : undefined}
            statusGlyph={squireState === 'offline' ? 'failed' : undefined}
            onPress={() => router.push({ pathname: '/beeline/settings/workbench/service', params: { workspaceId, viewerId, service: group.key } } as unknown as Href)} />))}
          {apps.map((app ) => (
            <SettingsRow appBoard chevron="right" key={app.id} testID={`connectors-app-${app.id}`} title={app.name}
            description="Signed in" leading={<AppMark name={app.name} domain={app.domain} logo={app.logo} />}
            value={app.status === 'connected' ? 'Connected' : app.status === 'error' ? 'Offline' : 'Connecting'}
            statusGlyph={app.status === 'connected' ? 'live' : app.status === 'error' ? 'failed' : 'pulse'}
            valueTone={app.status === 'error' ? 'danger' : undefined}
            onPress={() => router.push({ pathname: '/beeline/settings/workbench/app', params: { workspaceId, viewerId, appId: app.id } } as unknown as Href)} />
          ))}
          {googleEntryConnector(connectors)?.status === 'connected' && !apps.some(app => app.key === 'gmail') ? (
            <SettingsRow appBoard chevron="right" title="Google Workspace" description="Signed in" leading={<ServiceMark company="Google" domain="google.com" />}
              value="Connected" statusGlyph="live" onPress={() => void connectConnector('google')} />
          ) : null}
          {connectors.filter(connector => connector.id === 'tailscale' && connector.status === 'connected').map((connector) => (
              <SettingsRow appBoard chevron="right" key={connector.id} title="Tailscale" description="Network · Tailscale" leading={<ServiceMark company="Tailscale" domain="tailscale.com" />}
              value="Connected" statusGlyph="live" onPress={() => void connectConnector(connector.id)} />
            ))}
          {connectors.some(connector => connector.id === 'wallet' && connector.status === 'connected') ? (
            <SettingsRow appBoard chevron="right" testID="connectors-wallet" title="Coinbase wallet" description="Wallet" leading={<ServiceMark company="Coinbase" domain="coinbase.com" />}
            value="Connected" statusGlyph="live" onPress={() => void openWallet()} />
          ) : null}
          {view?.linkAccount?.connected ? (
            <SettingsRow appBoard chevron="right" title="Link" description="Approve agent purchases with Link" leading={<ServiceMark company="Link" domain="link.com" />}
            value="Connected" statusGlyph="live" trailingPress={{ accessibilityLabel: 'Change Link connection', onPress: () => setStatusAction({ title: 'Link', disconnect: () => void disconnectLink() }) }} />
          ) : null}
        </View>
        <View testID="connectors-recommended">
          <RoomListSectionHeader title="RECOMMENDED" inset="content" spacing="flush" />
          {squireState === 'never' ? (
            <View style={styles.squireHero}>
            <ToolDetailsCell appBoard expanded testID="connectors-squire-hero" title="Trusty Squire" detailText="Signs up and signs in for your agents" action="Connect" onAction={() => void connectConnector('trusty-squire')}
              leading={<View style={styles.squireMark}><Text style={styles.squireMarkText}>{'{ }'}</Text></View>} />
            <Text style={styles.appsNote}>Any website, hands-off. Its vault holds keys when needed.</Text>
          </View>
          ) : null}
          {RECOMMENDED_CONNECTIONS.filter(item => !apps.some(app => app.key === item.key) && !keyGroups.some(group => group.key === item.key) &&
            !(item.key === 'link' && view?.linkAccount?.connected) && !(item.key === 'wallet' && connectors.some(connector => connector.id === 'wallet' && connector.status === 'connected')) &&
            !(item.key === 'tailscale' && connectors.some(connector => connector.id === 'tailscale' && connector.status === 'connected'))).map((item) => (
            <SettingsRow appBoard chevron="right" key={item.key} testID={`connectors-recommended-${item.key}`} title={item.name}
              description={item.key === 'link' && linkError ? linkError : item.subtitle}
              descriptionTone={item.key === 'link' && linkError ? 'danger' : undefined}
              value={item.key === 'link' && linkConnecting ? 'Connecting…' : undefined}
              leading={<ServiceMark company={item.name} domain={item.domain} />}
              onPress={item.key === 'link' ? () => void connectLink() : item.key === 'wallet' ? () => void connectWallet()
                : item.key === 'tailscale' ? () => void connectConnector('tailscale')
                : () => router.push({ pathname: '/beeline/settings/workbench/connect-app', params: { workspaceId, viewerId, query: item.name } } as unknown as Href)} />
          ))}
        </View>
      </ScrollView>
      <HullActionSheetModal visible={statusAction !== null} title={statusAction?.title} onClose={() => setStatusAction(null)}>
        <HullActionSheetRow label="Disconnect" destructive onPress={() => { statusAction?.disconnect(); setStatusAction(null); }} />
        <HullActionSheetCancel onPress={() => setStatusAction(null)} />
      </HullActionSheetModal>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  const board = appBoardColors(hull);
  return {
    container: { flex: 1, backgroundColor: board.canvas },
    content: { flex: 1 },
    contentInner: {
      paddingHorizontal: hull.space.lg,
      gap: hull.layout.sectionGap,
      // Both section heads take the same air above them: the Keys head gets
      // `sectionGap` from the list it follows, so the Tools head takes the
      // screen's own `screenTop` rather than the smaller page padding —
      // which is what made the first head sit tighter than the second.
      paddingTop: hull.layout.screenTop,
      paddingBottom: hull.space.xxl,
    },
    searchBox: { minHeight: 48, backgroundColor: board.tile, borderColor: board.border, borderWidth: 1, borderRadius: 10,
      flexDirection: 'row', alignItems: 'center', paddingHorizontal: hull.space.md, gap: hull.space.sm },
    searchIcon: { ...hull.type.hero, color: board.quiet },
    searchPlaceholder: { ...Typography.ledger(), ...hull.type.body, color: board.quiet },
    squireHero: { backgroundColor: board.card, borderColor: board.strongBorder, borderWidth: 1, borderRadius: hull.radius, padding: hull.space.sm },
    appsNote: { ...Typography.ledger(), ...hull.type.meta, marginTop: hull.space.md, color: board.quiet },
    squireMark: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: TOOL_BRAND_MARKS.squire.ground },
    squireMarkText: { ...Typography.mono(), ...hull.type.machine, color: TOOL_BRAND_MARKS.squire.ink },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: hull.space.xl,
      gap: hull.space.md,
    },
  };
});
