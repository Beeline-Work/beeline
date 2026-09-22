import React from 'react';
import { Text, TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { RoomViewIdentity } from '@beeline/buzz-client';

import {
  HULL_SHEET_INSET,
  HullActionSheetCancel,
  HullActionSheetModal,
  HullActionSheetRow,
} from './HullActionSheet';

export function MakeCornerAppSheet({
  agents,
  busy,
  error,
  onClose,
  onCreate,
  visible,
}: {
  agents: readonly RoomViewIdentity[];
  busy: boolean;
  error?: string;
  onClose: () => void;
  onCreate: (agentId: string, description: string) => void;
  visible: boolean;
}) {
  const [agentId, setAgentId] = React.useState<string>();
  const [description, setDescription] = React.useState('');

  React.useEffect(() => {
    if (!visible) return;
    setAgentId(agents[0]?.pubkey);
    setDescription('');
  }, [agents, visible]);

  const ready = Boolean(agentId && description.trim());
  return (
    <HullActionSheetModal
      accessibilityLabel="Close Corner App builder"
      dismissOnBackdrop={!busy}
      footer={<HullActionSheetCancel onPress={onClose} testID="make-app-cancel" />}
      onClose={onClose}
      subtitle="A dedicated corner opens while the selected Agent builds and publishes it."
      testID="make-app-sheet"
      title="Make a Corner App"
      visible={visible}
    >
      <Text style={styles.label}>Agent</Text>
      {agents.map((agent) => (
        <HullActionSheetRow
          disabled={busy}
          key={agent.pubkey}
          label={`@${agent.handle ?? agent.name}`}
          onPress={() => setAgentId(agent.pubkey)}
          selected={agentId === agent.pubkey}
          testID={`make-app-agent-${agent.pubkey}`}
        />
      ))}
      <View style={styles.editor}>
        <Text style={styles.label}>App description</Text>
        <TextInput
          accessibilityLabel="Corner App description"
          editable={!busy}
          maxLength={2000}
          multiline
          onChangeText={setDescription}
          placeholder="What should the app help this Room do?"
          placeholderTextColor={styles.placeholder.color}
          style={styles.input}
          testID="make-app-description"
          value={description}
        />
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error} testID="make-app-error">
          {error}
        </Text>
      ) : null}
      <HullActionSheetRow
        disabled={!ready || busy}
        label={busy ? 'Creating corner…' : 'Create and enter corner'}
        onPress={() => agentId && onCreate(agentId, description.trim())}
        testID="make-app-create"
      />
    </HullActionSheetModal>
  );
}

const styles = StyleSheet.create((theme) => ({
  editor: {
    gap: theme.buzz.space.xs,
    paddingHorizontal: HULL_SHEET_INSET,
    paddingVertical: theme.buzz.space.md,
  },
  label: {
    ...theme.buzz.type.meta,
    color: theme.buzz.textSecondary,
    fontFamily: theme.buzz.proseSemibold,
    paddingHorizontal: HULL_SHEET_INSET,
    paddingTop: theme.buzz.space.sm,
  },
  input: {
    minHeight: 104,
    borderWidth: 1,
    borderColor: theme.buzz.border,
    borderRadius: theme.buzz.radius,
    color: theme.buzz.textPrimary,
    fontFamily: theme.buzz.proseRegular,
    padding: theme.buzz.space.md,
    textAlignVertical: 'top',
  },
  placeholder: { color: theme.buzz.textMuted },
  error: {
    color: theme.buzz.danger,
    fontFamily: theme.buzz.proseRegular,
    paddingHorizontal: HULL_SHEET_INSET,
    paddingBottom: theme.buzz.space.sm,
  },
}));
