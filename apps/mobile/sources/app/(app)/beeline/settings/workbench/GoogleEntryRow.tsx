import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { ServiceMark } from '@/components/buzz/ServiceMark';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import {
  GOOGLE_ENTRY_FAVICON_DOMAIN,
  GOOGLE_ENTRY_ID,
  googleEntryConnector,
  googleToolRows,
  connectorExpandedActions,
  connectorInstrument,
  type WorkbenchConnector,
} from '@/buzz/workbench';

/**
 * One Google account with four separately installed tools. The disclosure
 * shows each tool's status and its own Connect action.
 *
 * The row wears the same company mark and trailing status as every other
 * tool. Its disclosure has no extra glyph and contains only the catalog's
 * existing one-line capability copy.
 */
export function GoogleEntryRow({
  connectors,
  onPressConnect,
  onPressDisconnect,
}: {
  connectors: readonly WorkbenchConnector[];
  onPressConnect: (id: WorkbenchConnector['id']) => void;
  onPressDisconnect: (id: WorkbenchConnector['id']) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const entry = googleEntryConnector(connectors);
  if (!entry) return null;
  const instrument = connectorInstrument(
    entry.available ? entry.status : 'soon',
    entry.id,
  );
  const canConnect = instrument.connect && entry.available;
  const errorText =
    entry.status === 'error' ? (entry.errorMessage ?? 'Connection failed') : undefined;

  return (
    <View testID="google-entry">
      <SettingsRow
        action={canConnect ? 'Connect' : undefined}
        description={errorText}
        descriptionTone={entry.status === 'error' ? 'danger' : undefined}
        leading={
          <ServiceMark
            company={GOOGLE_ENTRY_ID}
            domain={GOOGLE_ENTRY_FAVICON_DOMAIN}
            testID="google-entry-mark"
          />
        }
        onPress={() => setExpanded((value) => !value)}
        testID="google-entry-row"
        title={entry.name}
        trailingPress={
          canConnect
            ? {
                accessibilityLabel: 'Connect Google Workspace',
                onPress: () => onPressConnect(GOOGLE_ENTRY_ID),
                testID: 'google-entry-connect',
              }
            : undefined
        }
        value={instrument.value}
        valueTone={instrument.valueTone}
      />
      {expanded ? (
        <View style={styles.details} testID="google-entry-details">
          <Text style={styles.tool}>{entry.description}</Text>
          {googleToolRows(connectors).flatMap((tool) => {
            const toolInstrument = connectorInstrument(tool.status, tool.id);
            const canConnect = tool.available && toolInstrument.connect;
            const extras = connectorExpandedActions(toolInstrument);
            return [
              <SettingsRow
                leading={
                  <IdentityMark
                    kind="human"
                    seed={tool.id}
                    name={tool.name}
                    avatarUrl={`${getBuzzRuntimeConfig().monolithUrl}/v1/connectors/logo/${tool.id}.svg`}
                    size={26}
                  />
                }
                key={tool.id}
                testID={`google-tool-${tool.id}`}
                title={tool.name}
                value={toolInstrument.value}
                valueTone={toolInstrument.valueTone}
                action={canConnect ? 'Connect' : undefined}
                description={tool.status === 'error' ? tool.errorMessage : undefined}
                descriptionTone={tool.status === 'error' ? 'danger' : undefined}
                trailingPress={
                  canConnect
                    ? {
                        accessibilityLabel: `Connect ${tool.name}`,
                        onPress: () => onPressConnect(tool.id),
                        testID: `google-tool-${tool.id}-connect`,
                      }
                    : undefined
                }
              />,
              ...extras.map((control) => (
                <SettingsRow
                  key={`${tool.id}-${control.action}`}
                  testID={`google-tool-${tool.id}-${control.action}`}
                  title={control.label}
                  tone={control.action === 'disconnect' ? 'destructive' : 'action'}
                  onPress={() =>
                    control.action === 'disconnect'
                      ? onPressDisconnect(tool.id)
                      : onPressConnect(tool.id)
                  }
                />
              )),
            ];
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
