import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { ToolDetailsCell } from '@/components/buzz/ToolDetailsCell';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import { GoogleEntryRow } from './workbench/GoogleEntryRow';
import {
  connectionHostsLine,
  connectionsForViewer,
  connectorDescription,
  connectorInstrument,
  isGoogleToolConnectorId,
  type WorkbenchView,
} from '@/buzz/workbench';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The expanded value proposition of the Coinbase Wallet tool (captain copy,
 *  2026-09): what it subsidizes and what it reaches. */
const WALLET_DETAILS = [
  {
    name: 'Gas Subsidies',
    line: 'USDC transactions are subsidized on Base L2.',
  },
  {
    name: 'Multi-Chain Support',
    line: '16 EVM-compatible chains (Base, Arbitrum, Avalanche, Robinhood Chain, and more) plus Solana.',
  },
] as const;

/** The expanded value proposition of the Trusty Squire tool (PR 1338):
 *  what sign-in covers and what spending it enables. Same vocabulary as
 *  `WALLET_DETAILS` — the one `ToolDetailsCell` detail shape. */
const SQUIRE_DETAILS = [
  {
    name: 'Authentication',
    line: 'Handles auth for your agents: you sign in once with Google and Trusty Squire grants access to your other services on their behalf.',
  },
  {
    name: 'Payments',
    line: 'Enables payments when a card is stored or uploaded to Trusty Squire. Agents can only spend within the grants you set.',
  },
] as const;

/**
 * Workbench — a settings section for every member (report §5, PR 3). Two
 * lists of `SettingsRow`s under small-caps heads: the tools this build knows
 * about (Trusty Squire live, Wallet and Tailscale as `soon`), and the
 * viewer's OWN keys. Captain ruling 2026-09-15 (mock 91aa0358328d716e): a
 * tool is what your agents can use; a key is what that tool holds for you.
 * Like `schedules`, the screen draws no header of its own: the stack header
 * is the one back control, and the layout names the screen Workbench.
 * Sovereignty is per human: the projection in `connectionsForViewer` paints
 * only rows the viewer provisioned, matching the server's own enforcement
 * in PR 2. Data-model names (`WorkbenchConnector`, `connections`, …) keep
 * their vocabulary; only user-visible copy speaks Tools and Keys.
 */
export default function WorkbenchScreen() {
  const params = useLocalSearchParams<{ workspaceId?: string | string[]; viewerId?: string | string[] }>();
  const workspaceId = firstParam(params.workspaceId) ?? '';
  const viewerId = firstParam(params.viewerId) ?? '';
  const [view, setView] = useState<WorkbenchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setView(await getWorkbenchSource().readWorkbench({ workspaceId, viewerId }));
      setError(null);
    } catch {
      setError('Workbench is unavailable right now');
    }
  }, [workspaceId, viewerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const connections = view ? connectionsForViewer(view, viewerId) : [];
  const connectors = view?.connectors ?? [];

  const connectConnector = useCallback(
    (connectorId: string) => {
      router.push({
        pathname: '/beeline/settings/workbench/connect',
        params: { workspaceId, viewerId, connectorId },
      } as unknown as Href);
    },
    [workspaceId, viewerId],
  );

  // The screen has three states, and they must not bleed into each other. A
  // failed load used to still render the section chrome and the "None yet"
  // empty state with a red banner pinned to the very bottom (behind the
  // system nav bar), so an error read as a populated-but-empty page. Gate the
  // sections on a real load; show a centered error or loader otherwise.
  const loading = view === null && error === null;

  if (error) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text accessibilityRole="alert" style={styles.centeredMessage} testID="workbench-error">
          {error}
        </Text>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => {
            setError(null);
            void load();
          }}
          testID="workbench-retry"
        >
          <Text style={styles.retry}>Tap to try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.centeredMessage} testID="workbench-loading">
          Loading…
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        <View testID="workbench-connectors">
          <Text style={styles.sectionLabel} testID="workbench-tools-head">
            Tools
          </Text>
          {connectors.map((connector, index) => {
            // Board revision 2 (PR #1351): every tool cell carries ONE
            // compact Connect button on the row's side while it is not
            // connected — the large full-width Connect button that used to
            // live in the expanded pane is gone. The accordion mechanics
            // (facts in the pane) are unchanged.
            const instrument = connectorInstrument(
              connector.available ? connector.status : 'soon',
            );
            const connectControl =
              instrument.connect && connector.available
                ? {
                    label: 'Connect',
                    onPress: () => connectConnector(connector.id),
                    testID: `workbench-connector-${connector.id}-connect`,
                  }
                : undefined;
            const isWallet = connector.id === 'wallet';
            if (isWallet) {
              return (
                <ToolDetailsCell
                  key={connector.id}
                  actionControl={
                    // The wallet opens its own dashboard rather than the
                    // shared connect pipeline.
                    connectControl && {
                      ...connectControl,
                      onPress: () =>
                        router.push({
                          pathname: '/beeline/settings/workbench/wallet',
                          params: { workspaceId },
                        } as unknown as Href),
                    }
                  }
                  description={connectorDescription(connector)}
                  details={WALLET_DETAILS}
                  statusGlyph={instrument.glyph}
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
              if (
                connectors.findIndex((entry) => isGoogleToolConnectorId(entry.id)) !== index
              ) {
                return null;
              }
              return (
                <GoogleEntryRow
                  key="google"
                  connectors={connectors}
                  onPressConnect={() => connectConnector('google')}
                />
              );
            }
            const isSquire = connector.id === 'trusty-squire';
            if (isSquire) {
              return (
                <ToolDetailsCell
                  key={connector.id}
                  actionControl={connectControl}
                  description={connectorDescription(connector)}
                  details={SQUIRE_DETAILS}
                  statusGlyph={instrument.glyph}
                  testID={`workbench-connector-${connector.id}`}
                  title={connector.name}
                  value={instrument.value}
                  valueTone={instrument.valueTone}
                />
              );
            }
            return (
              <SettingsRow
                key={connector.id}
                actionControl={connectControl}
                chevron={connectControl ? 'right' : undefined}
                description={connectorDescription(connector)}
                disabled={!connector.available}
                onPress={
                  connectControl ? undefined : connector.available ? () => connectConnector(connector.id) : undefined
                }
                statusGlyph={instrument.glyph}
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
            connections.map((connection) => (
              <SettingsRow
                key={connection.ref}
                chevron="right"
                description={[connection.kind, connectionHostsLine(connection)].join(' · ')}
                onPress={() =>
                  router.push({
                    pathname: '/beeline/settings/workbench/connection',
                    params: { workspaceId, viewerId, ref: connection.ref },
                  } as unknown as Href)
                }
                testID={`workbench-connection-${connection.ref}`}
                title={connection.name}
                value={connection.state}
              />
            ))
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
    contentInner: { padding: hull.space.md, gap: hull.layout.sectionGap, paddingBottom: hull.space.xxl },
    sectionLabel: { ...Typography.default(), ...hull.type.sectionHead, color: hull.textMuted },
    centered: { alignItems: 'center', justifyContent: 'center', padding: hull.space.xl, gap: hull.space.md },
    centeredMessage: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      textAlign: 'center',
    },
    retry: { ...Typography.default(), ...hull.type.meta, color: hull.accent },
  };
});
