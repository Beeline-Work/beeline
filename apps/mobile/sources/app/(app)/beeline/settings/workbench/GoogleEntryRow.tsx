import React, { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import {
  googleEntryConnector,
  googleEntryDescription,
  googleEntryState,
  googleEntryValue,
  googleToolStates,
  type WorkbenchConnector,
} from '@/buzz/workbench';

/**
 * The ONE Google connect entry: the four Google tool connectors (Gmail /
 * Calendar / Drive / YouTube) fold into a single logical row, so one connect
 * flow covers every tool with one Google grant. The server keeps four
 * connector kinds/rows; only consent and connect UX fold.
 *
 * The Workbench UI pattern for account-backed tools: the collapsed row never
 * connects — it only expands. The details pane carries the per-tool state
 * lines (what the one grant already covers) and the ONE connect action lives
 * inside the expanded pane, so nobody pairs a Google grant by accident from
 * the tool list. Connection progress itself is the connect checklist screen
 * (the shared connect pipeline); this row hands off to it with the logical
 * `google` id, which the source resolves to the first not-yet-connected tool.
 */
export function GoogleEntryRow({
  connectors,
  onPressConnect,
}: {
  connectors: readonly WorkbenchConnector[];
  onPressConnect: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const entry = googleEntryConnector(connectors);
  if (!entry) return null;
  const state = googleEntryState(connectors);
  const tools = googleToolStates(connectors);
  const connected = state === 'connected';

  return (
    <View testID="google-entry">
      <SettingsRow
        chevron="down"
        description={googleEntryDescription(connectors, state)}
        onPress={() => setExpanded((value) => !value)}
        testID="google-entry-row"
        title={entry.name}
        value={googleEntryValue(state)}
        valueTone={state === 'error' ? 'danger' : undefined}
      />
      {expanded ? (
        <View style={styles.details} testID="google-entry-details">
          {tools.map((tool) => (
            <Text key={tool.id} style={styles.tool} testID={`google-entry-tool-${tool.id}`}>
              {`· ${tool.name} · ${tool.value}`}
            </Text>
          ))}
          {connected ? (
            <Text style={styles.connectedNote} testID="google-entry-connected">
              Connected{entry.signedInAs ? ` as ${entry.signedInAs}` : ''}
            </Text>
          ) : (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={onPressConnect}
              style={styles.connectButton}
              testID="google-entry-connect"
            >
              <Text style={styles.connectText}>Connect</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : null}
    </View>
  );
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
    tool: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
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
