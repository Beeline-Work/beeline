import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { WorkflowOwnershipView } from '@beeline/api-contract/phone';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { IdentityMark } from './IdentityMark';

export function WorkflowOwnership({
  roomId,
  name,
  ownership,
  onChange,
}: {
  roomId: string;
  name: string;
  ownership: WorkflowOwnershipView;
  onChange: () => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assign = async (ownerId: string) => {
    setBusy(true);
    setError(null);
    try {
      await monolithPhoneOperation('transferWorkflowOwner', { roomId, name, ownerId });
      setChoosing(false);
      onChange();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.body} testID="workflow-ownership">
      <View style={styles.row}>
        <Text style={styles.label}>Owner</Text>
        {ownership.owner ? (
          <>
            <IdentityMark
              seed={ownership.owner.id}
              name={ownership.owner.name}
              kind="agent"
              avatarUrl={ownership.owner.avatarUrl}
              size={26}
            />
            <Text style={styles.name}>{ownership.owner.name}</Text>
          </>
        ) : (
          <Text accessibilityRole="alert" style={styles.warning}>
            no owner, starts blocked
          </Text>
        )}
        {ownership.canTransfer ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => setChoosing((open) => !open)}
            style={styles.action}
            testID="workflow-change-owner"
          >
            <Text style={styles.actionText}>
              {ownership.owner ? 'Change owner' : 'Assign owner'}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {choosing ? (
        <View testID="workflow-owner-picker">
          <Text style={styles.label}>Choose an agent in this Room</Text>
          {ownership.ownerCandidates?.map((agent) => (
            <Pressable
              key={agent.id}
              accessibilityRole="button"
              accessibilityLabel={`Make ${agent.name} the workflow owner`}
              disabled={busy}
              onPress={() => void assign(agent.id)}
              style={styles.candidate}
            >
              <IdentityMark
                seed={agent.id}
                kind="agent"
                avatarUrl={agent.avatarUrl}
                name={agent.name}
                size={26}
              />
              <Text style={styles.name}>{agent.name}</Text>
            </Pressable>
          ))}
          {!ownership.ownerCandidates?.length ? (
            <Text style={styles.label}>No agents in this Room.</Text>
          ) : null}
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.warning}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { paddingHorizontal: theme.buzz.space.md, paddingVertical: theme.buzz.space.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.buzz.space.sm },
  label: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
  name: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  warning: { ...theme.buzz.type.meta, color: theme.buzz.danger },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.buzz.space.sm },
  actionText: { ...theme.buzz.type.meta, color: theme.buzz.accent },
  candidate: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
}));
