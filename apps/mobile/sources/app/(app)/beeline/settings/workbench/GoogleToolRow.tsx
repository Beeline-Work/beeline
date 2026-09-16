import React, { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import {
  connectorRowValue,
  googleToolCapabilities,
  type WorkbenchConnector,
} from '@/buzz/workbench';

/**
 * One Google Workspace tool row (Gmail / Calendar / Drive / YouTube).
 *
 * The Workbench UI pattern for account-backed tools: the collapsed row never
 * connects — it only expands. The details pane carries the tool's capability
 * copy and the ONE connect action lives inside the expanded pane, so nobody
 * pairs a Google grant by accident from the tool list. Connection progress
 * itself is the connect checklist screen (the shared connect pipeline); this
 * row hands off to it with the tool's id.
 */
export function GoogleToolRow({
  connector,
  onPressConnect,
}: {
  connector: WorkbenchConnector;
  onPressConnect: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const connected = connector.status === 'connected';
  const capabilities = googleToolCapabilities(connector.id);

  return (
    <View testID={`google-tool-${connector.id}`}>
      <SettingsRow
        chevron="down"
        description={connectorDescription(connector)}
        onPress={() => setExpanded((value) => !value)}
        testID={`google-tool-${connector.id}-row`}
        title={connector.name}
        value={connectorRowValue(connector)}
        valueTone={connector.status === 'error' ? 'danger' : undefined}
      />
      {expanded ? (
        <View style={styles.details} testID={`google-tool-${connector.id}-details`}>
          {capabilities.map((capability) => (
            <Text key={capability} style={styles.capability} testID={`google-tool-${connector.id}-capability`}>
              {`· ${capability}`}
            </Text>
          ))}
          {connected ? (
            <Text style={styles.connectedNote} testID={`google-tool-${connector.id}-connected`}>
              Connected{connector.signedInAs ? ` as ${connector.signedInAs}` : ''}
            </Text>
          ) : (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={onPressConnect}
              style={styles.connectButton}
              testID={`google-tool-${connector.id}-connect`}
            >
              <Text style={styles.connectText}>Connect</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : null}
    </View>
  );
}

function connectorDescription(connector: WorkbenchConnector): string {
  if (connector.status === 'connected') {
    return [
      `on ${connector.helperName ?? 'a helper'}`,
      connector.signedInAs ? `signed in as ${connector.signedInAs}` : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  return connector.description;
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    details: {
      paddingLeft: hull.space.md,
      paddingBottom: hull.space.sm,
      gap: hull.space.xs,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: hull.border,
    },
    capability: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
    connectedNote: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    connectButton: {
      minHeight: hull.layout.row,
      borderWidth: 1,
      borderColor: hull.accent,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: hull.space.md,
      marginTop: hull.space.xs,
    },
    connectText: { ...Typography.default(), ...hull.type.body, color: hull.accent },
  };
});
