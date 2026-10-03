import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { useIsDesktop } from '@/utils/responsive';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { ToolDetailsCell } from '@/components/buzz/ToolDetailsCell';
import { NetworkUnavailableState } from '@/components/buzz/NetworkUnavailableState';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { getWalletSource } from '@/buzz/wallet-source';
import { resolveWalletWorkspaceId } from '@/buzz/wallet-workspace';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { PageHeader } from '@/components/buzz/PageHeader';
import { AppMark } from '@/components/buzz/AppMark';
import { appBoardColors } from '@/buzz/app-board-style';
import { ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { authSessionOptions } from '@/auth/auth-session';
import {
  MonolithPhoneOperationError,
  phoneOperationFailureReason,
} from '@/sync/transport/monolith-operation';
import {
  appInstrument,
  connectionCompany,
  connectionDomainsLine,
  connectionInstrument,
  connectionTitle,
  connectionsForViewer,
  connectorExpandedActions,
  connectorInstrument,
  keysOutsideApps,
  type WorkbenchView,
} from '@/buzz/workbench';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const VAULT_REFRESH_POLL_MS = 500;

/**
 * Workbench — a settings section for every member (report §5, PR 3). Two
 * lists of `SettingsRow`s under small-caps heads: the tools this build knows
 * about (Trusty Squire and Wallet live, Tailscale as `soon`), and the
 * viewer's OWN keys. Captain ruling 2026-09-15 (mock 91aa0358328d716e): a
 * tool is what your agents can use; a key is what that tool holds for you.
 * The page draws the shared `PageHeader` on every surface — small Settings
 * over large Workbench — the same ladder Bookmarks already uses. The layout
 * hides the stack header so that title is not drawn twice.
 * Sovereignty is per human: the projection in `connectionsForViewer` paints
 * only rows the viewer provisioned, matching the server's own enforcement
 * in PR 2. Data-model names (`WorkbenchConnector`, `connections`, …) keep
 * their vocabulary; only user-visible copy speaks Tools and Keys.
 */
export default function WorkbenchScreen() {
  const params = useLocalSearchParams<{
    workspaceId?: string | string[];
    viewerId?: string | string[];
    googleNotice?: string | string[];
  }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const viewerId = firstParam(params.viewerId) ?? '';
  const desktop = useIsDesktop();
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [view, setView] = useState<WorkbenchView | null>(null);
  const [networkFailure, setNetworkFailure] = useState<'load' | 'wallet' | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [linkConnecting, setLinkConnecting] = useState(false);
  const [linkDisconnecting, setLinkDisconnecting] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [walletWorkspaceMissing, setWalletWorkspaceMissing] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [foregroundGeneration, setForegroundGeneration] = useState(0);
  const load = useCallback(
    async (refreshVault = false) => {
      try {
        const next = await getWorkbenchSource().readWorkbench({
          workspaceId,
          viewerId,
          ...(refreshVault ? { refreshVault: true } : {}),
        });
        setView(next);
        setNetworkFailure(null);
        return next;
      } catch {
        setNetworkFailure('load');
        return undefined;
      }
    },
    [workspaceId, viewerId],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setForegroundGeneration((generation) => generation + 1);
    });
    return () => subscription.remove();
  }, []);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const refresh = async (requestVault: boolean) => {
        const next = await load(requestVault);
        if (cancelled || !next) return;
        if (next.connections.some((connection) => connection.stale)) {
          timer = setTimeout(() => void refresh(false), VAULT_REFRESH_POLL_MS);
        }
      };
      void foregroundGeneration;
      void refresh(true);
      return () => {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    }, [foregroundGeneration, load]),
  );

  const apps = view?.apps ?? [];
  // A key an app row already holds is stated on that row, not listed twice.
  const connections = view ? keysOutsideApps(view, connectionsForViewer(view, viewerId)) : [];
  const connectors = view?.connectors ?? [];
  const connectorLogoUrl = (id: string) =>
    `${getBuzzRuntimeConfig().monolithUrl}/v1/connectors/logo/${id}.svg`;

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
      params: { workspaceId, viewerId },
    } as unknown as Href);
  }, [workspaceId, viewerId]);

  const openWallet = useCallback(async () => {
    try {
      const selectedId = await resolveWalletWorkspaceId(workspaceId);
      if (!selectedId) {
        setWalletWorkspaceMissing(true);
        return;
      }
      setWalletWorkspaceMissing(false);
      router.push({
        pathname: '/beeline/settings/workbench/wallet',
        params: { workspaceId: selectedId },
      } as unknown as Href);
    } catch {
      setNetworkFailure('wallet');
    }
  }, [workspaceId]);

  const connectWallet = useCallback(async () => {
    if (walletConnecting) return;
    setWalletConnecting(true);
    setNetworkFailure(null);
    try {
      const selectedId = await resolveWalletWorkspaceId(workspaceId);
      if (!selectedId) {
        setWalletWorkspaceMissing(true);
        return;
      }
      setWalletWorkspaceMissing(false);
      // Connecting IS the grant: agents may sign only after it lands, so the
      // row reads connected only then.
      await getWalletSource().createWallet({ workspaceId: selectedId });
      await getWalletSource().grantDelegation({ workspaceId: selectedId });
      router.push({
        pathname: '/beeline/settings/workbench/wallet',
        params: { workspaceId: selectedId },
      } as unknown as Href);
    } catch {
      setNetworkFailure('wallet');
    } finally {
      setWalletConnecting(false);
    }
  }, [walletConnecting, workspaceId]);

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
    <PageHeader prominent backAccessibilityLabel="Back to Settings" eyebrow="Settings" title="Workbench" testID="workbench-header" onBack={() => router.back()} />
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
        <View testID="workbench-connectors">
          <Text style={styles.sectionLabel} testID="workbench-tools-head">
            TOOLS
          </Text>
          <ToolDetailsCell
            appBoard
            testID="workbench-link"
            title="Link"
            leading={<ServiceMark company="Link" domain="link.com" testID="workbench-link-mark" />}
            detailText={view?.linkAccount?.ineligible
              ? 'Link agent payments are available only to consumers in the US or Canada.'
              : 'Approve each purchase in Link before your agents use a one-time payment card.'}
            descriptionText={view?.linkAccount?.ineligible
              ? 'Your Link account is not eligible. Available only in the US or Canada.'
              : !view?.linkAccount?.connected ? 'Available to consumers in the US or Canada.'
                : undefined}
            errorText={linkError ?? undefined}
            action={!view?.linkAccount?.connected && !view?.linkAccount?.pending
              ? (linkConnecting ? 'Connecting' : 'Connect') : undefined}
            actionDisabled={linkConnecting}
            actionTestID="workbench-link-connect"
            onAction={() => void connectLink()}
            extraActions={view?.linkAccount?.connected ? [{ label: 'Disconnect',
              testID: 'workbench-link-disconnect', tone: 'destructive',
              disabled: linkDisconnecting,
              onPress: () => void disconnectLink() }] : []}
            value={view?.linkAccount?.connected ? 'connected'
              : view?.linkAccount?.pending ? 'installing' : undefined}
          />
          {connectors.filter(connector => !connector.id.startsWith('google-') && connector.id !== 'tailscale').map(connector => {
            const instrument = connectorInstrument(connector.available ? connector.status : 'soon', connector.id);
            const canConnect = instrument.connect && connector.available;
            const isWallet = connector.id === 'wallet';
            return <ToolDetailsCell
              appBoard
              key={connector.id}
              action={canConnect ? (isWallet && walletConnecting ? 'Connecting'
                : isWallet && connector.status === 'error' ? 'Reconnect' : 'Connect') : undefined}
              actionDisabled={isWallet && walletConnecting}
              actionTestID={`workbench-connector-${connector.id}-connect`}
              detailText={connector.description}
              errorText={connector.status === 'error' ? connector.errorMessage : undefined}
              extraActions={connectorExpandedActions(instrument).map(entry => ({
                label: entry.label,
                testID: `workbench-connector-${connector.id}-${entry.action}`,
                tone: entry.action === 'disconnect' ? 'destructive' as const : 'action' as const,
                disabled: disconnectingId === connector.id,
                onPress: entry.action === 'disconnect' ? () => void disconnectConnector(connector.id) : () => connectConnector(connector.id),
              }))}
              leading={<View style={[styles.toolMark, isWallet ? styles.walletMark : styles.squireMark]}><Text style={[styles.toolMarkText, !isWallet && styles.squireMarkText]}>{isWallet ? 'C' : '{ }'}</Text></View>}
              onAction={canConnect ? isWallet ? () => void connectWallet() : () => connectConnector(connector.id) : undefined}
              onToggle={isWallet && connector.status === 'connected' ? openWallet : undefined}
              testID={`workbench-connector-${connector.id}`}
              title={isWallet ? 'Wallet' : connector.name}
              value={instrument.value}
              valueTone={instrument.valueTone}
            />;
          })}
        </View>
        <View testID="workbench-apps">
          <Text style={styles.sectionLabel} testID="workbench-apps-head">
            APPS
          </Text>
          {apps.map(app => <WorkbenchIndexRow key={app.id} leading={<AppMark name={app.name} domain={app.domain} logo={app.logo} />} onPress={() => router.push({ pathname: '/beeline/settings/workbench/app', params: { workspaceId, viewerId, appId: app.id } } as unknown as Href)} testID={`workbench-app-${app.key}`} title={app.name} value={appInstrument(app.status).value} />)}
          <WorkbenchIndexRow onPress={openConnectApp} testID="workbench-connect-app" title="Connect an app" action />
          <Text style={styles.appsNote}>Agents can also connect an app for you from a conversation when they need one.</Text>
        </View>
        {connections.length > 0 ? <View testID="workbench-connections">
          <Text style={styles.sectionLabel} testID="workbench-keys-head">
            KEYS
          </Text>
          {connections.map((connection) => {
              const instrument = connectionInstrument(connection.state);
              const domains = connectionDomainsLine(connection);
              return (
                <SettingsRow
                  key={connection.ref}
                  chevron="right"
                  description={domains || undefined}
                  leading={
                    <ServiceMark
                      company={connectionCompany(connection)}
                      domain={connection.faviconDomain}
                      testID={`workbench-connection-${connection.ref}-mark`}
                    />
                  }
                  onPress={() =>
                    router.push({
                      pathname: '/beeline/settings/workbench/connection',
                      params: { workspaceId, viewerId, connectionId: connection.connectionId },
                    } as unknown as Href)
                  }
                  statusGlyph={instrument.glyph}
                  testID={`workbench-connection-${connection.ref}`}
                  title={connectionTitle(connection, connections)}
                  value={instrument.value}
                  valueTone={instrument.valueTone}
                />
              );
            })}
        </View> : null}
      </ScrollView>
    </View>
  );
}

function WorkbenchIndexRow({ leading, title, value, onPress, testID, action = false }: {
  leading?: React.ReactNode; title: string; value?: string; onPress?: () => void; testID: string; action?: boolean;
}) {
  const body = <>{leading}<Text numberOfLines={1} style={[styles.rowTitle, action && styles.rowAction]}>{title}</Text>{value ? <Text style={styles.rowValue}>{value}</Text> : null}{action ? <ChevronGlyph direction="right" size={18} color={styles.rowValue.color} /> : null}</>;
  return onPress ? <TouchableOpacity accessibilityRole="button" onPress={onPress} style={styles.indexRow} testID={testID}>{body}</TouchableOpacity> : <View style={styles.indexRow} testID={testID}>{body}</View>;
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  const board = appBoardColors(hull);
  return {
    container: { flex: 1, backgroundColor: board.canvas },
    content: { flex: 1 },
    contentInner: {
      paddingHorizontal: 20,
      gap: 22,
      // Both section heads take the same air above them: the Keys head gets
      // `sectionGap` from the list it follows, so the Tools head takes the
      // screen's own `screenTop` rather than the smaller page padding —
      // which is what made the first head sit tighter than the second.
      paddingTop: 22,
      paddingBottom: hull.space.xxl,
    },
    sectionLabel: { ...Typography.default(), ...hull.type.sectionHead, color: board.quiet, paddingBottom: 6 },
    appsNote: { ...Typography.ledger(), ...hull.type.meta, marginTop: 18, color: board.quiet },
    indexRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: board.border },
    rowTitle: { ...Typography.ledger(), ...hull.type.body, flex: 1, color: board.ink },
    rowAction: { color: board.brass },
    rowValue: { ...Typography.ledger(), ...hull.type.meta, color: board.quiet },
    toolMark: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    squireMark: { backgroundColor: '#141210' },
    walletMark: { backgroundColor: '#1652F0' },
    toolMarkText: { ...Typography.mono(), ...hull.type.machine, color: '#FFFFFF' },
    squireMarkText: { color: '#9AA7FF' },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: hull.space.xl,
      gap: hull.space.md,
    },
  };
});
