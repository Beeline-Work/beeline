import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import {
  googleEntryConnector,
  googleToolRows,
  connectorInstrument,
  type WorkbenchConnector,
} from '@/buzz/workbench';

/**
 * The ONE Google connect entry: the four Google tool connectors (Gmail /
 * Calendar / Drive / YouTube) fold into a single logical row, so one connect
 * flow covers every tool with one Google grant. The server keeps four
 * connector kinds/rows; only consent and connect UX fold.
 *
 * The row has one state and one valid action. Its disclosure has no glyph and
 * contains only the catalog's existing one-line capability copy.
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
  const instrument = connectorInstrument(entry.status);
  const canConnect = instrument.connect && entry.available;
  const errorText =
    entry.status === 'error'
      ? (entry.errorMessage ?? 'Connection failed')
      : undefined;

  return (
    <View testID="google-entry">
      <SettingsRow
        action={canConnect ? 'Connect' : undefined}
        description={errorText}
        descriptionTone={entry.status === 'error' ? 'danger' : undefined}
        onPress={() => setExpanded((value) => !value)}
        testID="google-entry-row"
        title={entry.name}
        value={instrument.value}
        valueTone={instrument.valueTone}
        trailingPress={
          canConnect
            ? {
                accessibilityLabel: 'Connect Google Workspace',
                onPress: onPressConnect,
                testID: 'google-entry-connect',
              }
            : undefined
        }
      />
      {expanded ? (
        <View style={styles.details} testID="google-entry-details">
          <Text style={styles.tool}>{entry.description}</Text>
          {googleToolRows(connectors).map((tool) => (
            <View key={tool.id} style={styles.toolRow} testID={`google-tool-${tool.id}`}>
              <Text style={styles.tool}>{tool.name}</Text>
              <Text
                style={[
                  styles.tool,
                  tool.status === 'connected'
                    ? styles.toolConnected
                    : tool.status === 'error'
                      ? styles.toolError
                      : undefined,
                ]}
              >
                {tool.status === 'connected'
                  ? 'connected'
                  : tool.status === 'installing'
                    ? 'installing'
                    : tool.status === 'error'
                      ? 'error'
                      : 'not connected'}
              </Text>
            </View>
          ))}
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
      paddingRight: hull.space.sm,
    },
    tool: { ...hull.type.meta, color: hull.textSecondary },
    toolRow: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      gap: hull.space.sm,
    },
    toolConnected: { color: hull.textPrimary },
    toolError: { color: hull.danger },
  };
});
