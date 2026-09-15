import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { getWorkbenchSource } from '@/buzz/workbench-source';
import {
  connectionHostsLine,
  connectionsForViewer,
  connectorDescription,
  connectorRowValue,
  type WorkbenchView,
} from '@/buzz/workbench';

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

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
  // Every caller reaches this screen WITHOUT params: settings/identity.tsx
  // pushes the bare path, and connect.tsx / connect-signin.tsx both
  // router.replace() it after pairing. The mock source ignored the ids, so
  // empty strings were harmless; the real source sends them to the server and
  // an empty workspace id fails the read, which is why the screen showed
  // "Workbench is unavailable right now" for everyone. Resolve them here the
  // same way identity.tsx does, so the screen works from any entry point, and
  // let explicit params win when a caller does supply them.
  const [resolved, setResolved] = useState<{ workspaceId: string; viewerId: string } | null>(null);
  const paramWorkspaceId = firstParam(params.workspaceId) ?? '';
  const paramViewerId = firstParam(params.viewerId) ?? '';
  const workspaceId = paramWorkspaceId || (resolved?.workspaceId ?? '');
  const viewerId = paramViewerId || (resolved?.viewerId ?? '');

  useEffect(() => {
    if (paramWorkspaceId && paramViewerId) return;
    let cancelled = false;
    void (async () => {
      try {
        // Imported lazily: `buzz-identity-storage` pulls in expo-secure-store,
        // and a static import would drag it into every test that renders this
        // screen without exercising the fallback.
        const [{ getEffectiveRelayUrl, loadBuzzIdentity }, { loadActiveCommunityId }, { RoomViewClient }] =
          await Promise.all([
            import('@/auth/buzz-identity-storage'),
            import('@/buzz/community-storage'),
            import('@/sync/transport/room-view-client'),
          ]);
        const identity = await loadBuzzIdentity();
        if (!identity) return;
        const relayUrl = await getEffectiveRelayUrl();
        const [workspaceList, activeCommunityId] = await Promise.all([
          new RoomViewClient({ baseUrl: relayUrl, identity }).workspaces(),
          loadActiveCommunityId(identity.publicKey),
        ]);
        const communityId = workspaceList.workspaces.some((item) => item.id === activeCommunityId)
          ? (activeCommunityId ?? undefined)
          : workspaceList.workspaces[0]?.id;
        if (!cancelled && communityId) {
          setResolved({ workspaceId: communityId, viewerId: identity.publicKey });
        }
      } catch {
        // Leave the ids empty; `load` below reports the read failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paramWorkspaceId, paramViewerId]);
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

  return (
    <View style={styles.container}>
      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        <View testID="workbench-connectors">
          <Text style={styles.sectionLabel} testID="workbench-tools-head">
            Tools
          </Text>
          <Text style={styles.sectionDesc} testID="workbench-tools-desc">
            Something your agents can use. Pair it once.
          </Text>
          {connectors.map((connector) => (
            <SettingsRow
              key={connector.id}
              description={connectorDescription(connector)}
              disabled={!connector.available || connector.status === 'connected'}
              onPress={
                connector.available && connector.status !== 'connected'
                  ? () =>
                      router.push({
                        pathname: '/beeline/settings/workbench/connect',
                        params: { workspaceId, viewerId, connectorId: connector.id },
                      } as unknown as Href)
                  : undefined
              }
              testID={`workbench-connector-${connector.id}`}
              title={connector.name}
              value={connectorRowValue(connector)}
            />
          ))}
        </View>
        <View testID="workbench-connections">
          <Text style={styles.sectionLabel} testID="workbench-keys-head">
            Keys
          </Text>
          <Text style={styles.sectionDesc} testID="workbench-keys-desc">
            A credential that tool holds for you. Your agents spend it; they never see it.
          </Text>
          {connections.length === 0 ? (
            <SettingsRow
              disabled
              description="Other members’ keys are not listed and cannot be spent."
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
      {error ? (
        <Text accessibilityRole="alert" style={styles.errorText} testID="workbench-error">
          {error}
        </Text>
      ) : null}
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
    sectionDesc: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    errorText: { ...Typography.default(), ...hull.type.meta, color: hull.dialogDanger, padding: hull.space.md },
  };
});
