import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { Typography } from '@/constants/Typography';
import { GoogleMark } from '@/components/buzz/GoogleMark';
import { googleEntryConnector, googleEntryState, type WorkbenchConnector } from '@/buzz/workbench';

export function GoogleEntryRow({
  connectors,
  onPressConnect,
  onPressDisconnect,
  notice,
}: {
  connectors: readonly WorkbenchConnector[];
  onPressConnect: (id: WorkbenchConnector['id']) => void;
  onPressDisconnect: (id: WorkbenchConnector['id']) => void;
  notice?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const entry = googleEntryConnector(connectors);
  if (!entry) return null;
  const state = googleEntryState(connectors);
  const available = entry.available;
  const connected = state === 'connected';
  const pending = state === 'installing';
  return <View testID="google-entry">
    <SettingsRow
      leading={<GoogleMark />}
      title="Google Workspace"
      action={available && !connected && !pending ? 'Connect' : undefined}
      trailingPress={available && !connected && !pending ? {
        accessibilityLabel: 'Connect Google Workspace',
        onPress: () => onPressConnect('google'),
        testID: 'google-entry-connect',
      } : undefined}
      value={connected ? 'connected' : pending ? 'connecting' : undefined}
      description={connected
        ? `${entry.signedInAs ?? 'Google account'} · Gmail, Calendar, Drive and YouTube`
        : notice ?? 'Gmail, Calendar, Drive and YouTube. One sign-in connects all four.'}
      onPress={connected ? () => setExpanded((value) => !value) : undefined}
      testID="google-entry-row"
    />
    {connected ? <Text style={styles.notice} testID="google-entry-confirmation">
      ✓ Google connected. Agents can use all four tools.
    </Text> : null}
    {connected && expanded ? <SettingsRow
      title="Disconnect Google Workspace"
      description="Removes access to all four Google tools."
      tone="destructive"
      onPress={() => onPressDisconnect('google-gmail')}
      testID="google-entry-disconnect"
    /> : null}
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  notice: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.textMuted,
    paddingHorizontal: theme.buzz.space.md, paddingBottom: theme.buzz.space.sm },
}));
