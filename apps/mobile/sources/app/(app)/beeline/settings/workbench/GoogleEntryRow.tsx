import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import {
  googleEntryConnector,
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

  return (
    <View testID="google-entry">
      <SettingsRow
        action={canConnect ? 'Connect' : undefined}
        description={
          entry.status === 'error' ? (entry.errorMessage ?? 'Connection failed') : undefined
        }
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
  };
});
