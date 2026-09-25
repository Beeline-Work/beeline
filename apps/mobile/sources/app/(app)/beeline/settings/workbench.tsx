import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { useIsDesktop } from '@/utils/responsive';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { ToolDetailsCell } from '@/components/buzz/ToolDetailsCell';
import { NetworkUnavailableState } from '@/components/buzz/NetworkUnavailableState';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { getWalletSource } from '@/buzz/wallet-source';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { GoogleEntryRow } from './workbench/GoogleEntryRow';
import {
  connectionCompany,
  connectionDomainsLine,
  connectionInstrument,
  connectionTitle,
  connectionsForViewer,
  connectorExpandedActions,
  connectorInstrument,
  isGoogleToolConnectorId,
  type WorkbenchView,
} from '@/buzz/workbench';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Workbench — a settings section for every member (report §5, PR 3). Two
 * lists of `SettingsRow`s under small-caps heads: the tools this build knows
 * about (Trusty Squire and Wallet live, Tailscale as `soon`), and the
 * viewer's OWN keys. Captain ruling 2026-09-15 (mock 91aa0358328d716e): a
 * tool is what your agents can use; a key is what that tool holds for you.
 * On a phone the stack header remains the one back control. On desktop the
 * stack header's centered legacy column does not line up with the other
 * sections, so the page draws the shared `PageHeader` (which the layout
 * hides the stack header for).
 * Sovereignty is per human: the projection in `connectionsForViewer` paints
 * only rows the viewer provisioned, matching the server's own enforcement
 * in PR 2. Data-model names (`WorkbenchConnector`, `connections`, …) keep
 * their vocabulary; only user-visible copy speaks Tools and Keys.
 */
export default function WorkbenchScreen() {
  const params = useLocalSearchParams<{
    workspaceId?: string | string[];
    viewerId?: string | string[];
  }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const viewerId = firstParam(params.viewerId) ?? '';
  const desktop = useIsDesktop();
  const [view, setView] = useState<WorkbenchView | null>(null);
  const [networkFailure, setNetworkFailure] = useState<'load' | 'wallet' | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setView(await getWorkbenchSource().readWorkbench({ workspaceId, viewerId }));
      setNetworkFailure(null);
    } catch {
      setNetworkFailure('load');
    }
  }, [workspaceId, viewerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const connections = view ? connectionsForViewer(view, viewerId) : [];
  const connectors = view?.connectors ?? [];
  const connectorLogoUrl = (id: string) =>
    `${getBuzzRuntimeConfig().monolithUrl}/v1/connectors/logo/${id}.svg`;

  const connectConnector = useCallback(
    (connectorId: string) => {
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

  const openWallet = useCallback(() => {
    router.push({
      pathname: '/beeline/settings/workbench/wallet',
      params: { workspaceId },
    } as unknown as Href);
  }, [workspaceId]);

  const connectWallet = useCallback(async () => {
    if (walletConnecting) return;
    setWalletConnecting(true);
    setNetworkFailure(null);
    try {
      await getWalletSource().createWallet({ workspaceId });
      openWallet();
    } catch {
      setNetworkFailure('wallet');
    } finally {
      setWalletConnecting(false);
    }
  }, [openWallet, walletConnecting, workspaceId]);

  // The screen has three states, and they must not bleed into each other. A
  // failed load used to still render the section chrome and the "None yet"
  // empty state with a red banner pinned to the very bottom (behind the
  // system nav bar), so an error read as a populated-but-empty page. Gate the
  // sections on a real load; show a centered error or loader otherwise.
  const loading = view === null && networkFailure === null;
  const header = desktop ? <PageHeader testID="workbench-header" title="Workbench" /> : null;

  if (networkFailure) {
    return (
      <View style={styles.container}>
        {header}
        <NetworkUnavailableState
          onRetry={() => void (networkFailure === 'wallet' ? connectWallet() : load())}
          testID="workbench-network-unavailable"
        />
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.centered} testID="workbench-loading">
          <SurfaceGlyphLoader testID="workbench-loader" />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {header}
      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        <View testID="workbench-connectors">
          <Text style={styles.sectionLabel} testID="workbench-tools-head">
            Tools
          </Text>
          {connectors.map((connector, index) => {
            const instrument = connectorInstrument(
              connector.available ? connector.status : 'soon',
              connector.id,
            );
            const canConnect = instrument.connect && connector.available;
            const extraActions = connectorExpandedActions(instrument).map((entry) => ({
              label: entry.label,
              testID: `workbench-connector-${connector.id}-${entry.action}`,
              tone: entry.action === 'disconnect' ? ('destructive' as const) : ('action' as const),
              disabled: disconnectingId === connector.id,
              onPress:
                entry.action === 'disconnect'
                  ? () => void disconnectConnector(connector.id)
                  : () => connectConnector(connector.id),
            }));
            const isWallet = connector.id === 'wallet';
            if (isWallet) {
              return (
                <ToolDetailsCell
                  key={connector.id}
                  action={canConnect ? (walletConnecting ? 'Connecting' : 'Connect') : undefined}
                  actionDisabled={walletConnecting}
                  actionTestID="workbench-connector-wallet-connect"
                  detailText={connector.description}
                  logoUrl={connectorLogoUrl(connector.id)}
                  onAction={canConnect ? () => void connectWallet() : undefined}
                  onToggle={connector.status === 'connected' ? openWallet : undefined}
                  testID={`workbench-connector-${connector.id}`}
                  title={connector.name}
                  value={instrument.value}
                  valueTone={instrument.valueTone}
                />
              );
            }
            // The ONE Google connect entry: the four google tool connectors
            // fold into a single logical row (first google entry renders it;
            // its siblings render nothing). Its side Connect button hands
            // off with the logical `google` id, which the source resolves to
            // the first not-yet-connected tool.
            if (isGoogleToolConnectorId(connector.id)) {
              if (connectors.findIndex((entry) => isGoogleToolConnectorId(entry.id)) !== index) {
                return null;
              }
              return (
                <GoogleEntryRow
                  key="google"
                  connectors={connectors}
                  onPressConnect={(id) => connectConnector(id)}
                  onPressDisconnect={(id) => void disconnectConnector(id)}
                />
              );
            }
            return (
              <ToolDetailsCell
                key={connector.id}
                action={canConnect ? 'Connect' : undefined}
                actionTestID={`workbench-connector-${connector.id}-connect`}
                detailText={connector.description}
                logoUrl={connectorLogoUrl(connector.id)}
                errorText={
                  connector.status === 'error'
                    ? (connector.errorMessage ?? 'Connection failed')
                    : undefined
                }
                extraActions={extraActions}
                onAction={canConnect ? () => connectConnector(connector.id) : undefined}
                testID={`workbench-connector-${connector.id}`}
                title={connector.name}
                value={instrument.value}
                valueTone={instrument.valueTone}
              />
            );
          })}
        </View>
        <View testID="workbench-connections">
          <Text style={styles.sectionLabel} testID="workbench-keys-head">
            Keys
          </Text>
          {connections.length === 0 ? (
            <SettingsRow
              disabled
              testID="workbench-connections-empty"
              title="None yet"
              tone="quiet"
            />
          ) : (
            connections.map((connection) => {
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
                      params: { workspaceId, viewerId, ref: connection.ref },
                    } as unknown as Href)
                  }
                  statusGlyph={instrument.glyph}
                  testID={`workbench-connection-${connection.ref}`}
                  title={connectionTitle(connection, connections)}
                  value={instrument.value}
                  valueTone={instrument.valueTone}
                />
              );
            })
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    content: { flex: 1 },
    contentInner: {
      padding: hull.space.md,
      gap: hull.layout.sectionGap,
      // Both section heads take the same air above them: the Keys head gets
      // `sectionGap` from the list it follows, so the Tools head takes the
      // screen's own `screenTop` rather than the smaller page padding —
      // which is what made the first head sit tighter than the second.
      paddingTop: hull.layout.screenTop,
      paddingBottom: hull.space.xxl,
    },
    sectionLabel: { ...Typography.default(), ...hull.type.sectionHead, color: hull.textMuted },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: hull.space.xl,
      gap: hull.space.md,
    },
  };
});
