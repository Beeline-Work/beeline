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
 * One Google account with four separately installed tools. The disclosure
 * shows each tool's status and its own Connect action.
 *
 * The row has one state and one valid action. Its disclosure has no glyph and
 * contains only the catalog's existing one-line capability copy.
 */
export function GoogleEntryRow({
  connectors,
  onPressConnect,
}: {
  connectors: readonly WorkbenchConnector[];
  onPressConnect: (id: WorkbenchConnector['id']) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const entry = googleEntryConnector(connectors);
  if (!entry) return null;
  const instrument = connectorInstrument(entry.status);
  const errorText =
    entry.status === 'error'
      ? (entry.errorMessage ?? 'Connection failed')
      : undefined;

  return (
    <View testID="google-entry">
      <SettingsRow
        description={errorText}
        descriptionTone={entry.status === 'error' ? 'danger' : undefined}
        onPress={() => setExpanded((value) => !value)}
        testID="google-entry-row"
        title={entry.name}
        value={instrument.value}
        valueTone={instrument.valueTone}
      />
      {expanded ? (
        <View style={styles.details} testID="google-entry-details">
          <Text style={styles.tool}>{entry.description}</Text>
          {googleToolRows(connectors).map((tool) => {
            const toolInstrument = connectorInstrument(tool.status);
            const canConnect = tool.available && toolInstrument.connect;
            return <SettingsRow
              key={tool.id}
              testID={`google-tool-${tool.id}`}
              title={tool.name}
              value={toolInstrument.value}
              valueTone={toolInstrument.valueTone}
              action={canConnect ? 'Connect' : undefined}
              description={tool.status === 'error' ? tool.errorMessage : undefined}
              descriptionTone={tool.status === 'error' ? 'danger' : undefined}
              trailingPress={canConnect ? {
                accessibilityLabel: `Connect ${tool.name}`,
                onPress: () => onPressConnect(tool.id),
                testID: `google-tool-${tool.id}-connect`,
              } : undefined}
            />;
          })}
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
