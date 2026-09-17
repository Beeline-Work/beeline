import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import {
  googleEntryConnector,
  googleEntryDescription,
  googleEntryState,
  googleToolStates,
  connectorInstrument,
  type WorkbenchConnector,
} from '@/buzz/workbench';

/**
 * The ONE Google connect entry: the four Google tool connectors (Gmail /
 * Calendar / Drive / YouTube) fold into a single logical row, so one connect
 * flow covers every tool with one Google grant. The server keeps four
 * connector kinds/rows; only consent and connect UX fold.
 *
 * Board revision 2 (PR #1351): while the entry is not fully connected its
 * row carries the ONE compact side Connect button — repair (a partially
 * live grant) connects exactly like a first connect, topping up the tools
 * still missing. The accordion keeps the per-tool state lines so a reader
 * can see what of the one grant is live; connection progress itself is the
 * shared connect checklist screen, reached with the logical `google` id
 * that the source resolves to the first not-yet-connected tool.
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
  const instrument = connectorInstrument(entry.status);

  return (
    <View testID="google-entry">
      <SettingsRow
        actionControl={
          instrument.connect
            ? { label: 'Connect', onPress: onPressConnect, testID: 'google-entry-connect' }
            : undefined
        }
        chevron="down"
        description={googleEntryDescription(connectors, state)}
        onPress={() => setExpanded((value) => !value)}
        statusGlyph={instrument.glyph}
        testID="google-entry-row"
        title={entry.name}
        value={instrument.value}
        valueTone={instrument.valueTone}
      />
      {expanded ? (
        <View style={styles.details} testID="google-entry-details">
          {tools.map((tool) => (
            <Text key={tool.id} style={styles.tool} testID={`google-entry-tool-${tool.id}`}>
              {`· ${tool.name} · ${tool.value}`}
            </Text>
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
      gap: hull.space.xs,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: hull.border,
    },
    tool: { ...hull.type.meta, color: hull.textSecondary },
  };
});
