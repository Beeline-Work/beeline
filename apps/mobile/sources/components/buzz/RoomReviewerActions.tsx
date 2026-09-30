import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { RoomViewIdentity } from '@beeline/buzz-client';
import { isClassOrTagReference } from '@beeline/api-contract/phone';

import { ROOM_LABEL } from '@/buzz/vocabulary';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';
import { HullDialog } from './HullDialog';

export type RoomReviewerUpdate = {
  roomId: string;
  reviewerAgentId?: string | null;
  reviewerClass?: string | null;
};

type RoomReviewerActionsProps = {
  agents: readonly RoomViewIdentity[];
  canManage: boolean;
  hasRepository: boolean;
  onSaved?: () => void;
  reviewerAgentId?: string;
  /** A class/tag instead of one fixed agent; mutually exclusive with `reviewerAgentId`. */
  reviewerClass?: string;
  roomId: string;
  roomName: string;
  updateRoom: (input: RoomReviewerUpdate) => Promise<unknown>;
};

/** The repository Room's one reviewer control, shared by phone and desktop sheets. */
export function RoomReviewerActions({
  agents,
  canManage,
  hasRepository,
  onSaved,
  reviewerAgentId,
  reviewerClass,
  roomId,
  roomName,
  updateRoom,
}: RoomReviewerActionsProps) {
  const { theme } = useUnistyles();
  const [pickerVisible, setPickerVisible] = useState(false);
  const [classDialogVisible, setClassDialogVisible] = useState(false);
  const [classDraft, setClassDraft] = useState('');
  const [selectedReviewerAgentId, setSelectedReviewerAgentId] = useState(reviewerAgentId);
  const [selectedReviewerClass, setSelectedReviewerClass] = useState(reviewerClass);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setSelectedReviewerAgentId(reviewerAgentId), [reviewerAgentId]);
  useEffect(() => setSelectedReviewerClass(reviewerClass), [reviewerClass]);

  const selectedReviewer = useMemo(
    () => agents.find((agent) => agent.pubkey === selectedReviewerAgentId),
    [agents, selectedReviewerAgentId],
  );
  const reviewerLabel = selectedReviewer
    ? `@${selectedReviewer.handle ?? selectedReviewer.name}`
    : selectedReviewerClass
      ? `class: ${selectedReviewerClass}`
      : 'None';

  const changeReviewer = useCallback(
    async (next: Omit<RoomReviewerUpdate, 'roomId'>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await updateRoom({ roomId, ...next });
        setSelectedReviewerAgentId(next.reviewerAgentId ?? undefined);
        setSelectedReviewerClass(next.reviewerClass ?? undefined);
        setPickerVisible(false);
        setClassDialogVisible(false);
        onSaved?.();
      } catch (caught) {
        setError(`Could not change ${ROOM_LABEL} reviewer: ${String(caught)}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, onSaved, roomId, updateRoom],
  );

  if (!canManage || !hasRepository) return null;

  return (
    <>
      <HullActionSheetRow
        accessibilityLabel={`Choose reviewer, currently ${reviewerLabel}`}
        chevron="right"
        disabled={busy}
        label="Reviewer"
        metadata={reviewerLabel}
        onPress={() => {
          setError(null);
          setPickerVisible(true);
        }}
        testID="room-reviewer-action"
      />
      <HullActionSheetModal
        accessibilityLabel="Close reviewer picker"
        dismissOnBackdrop={!busy}
        onClose={() => {
          if (!busy) setPickerVisible(false);
        }}
        subtitle="This agent reviews every pull request opened from the Room. A class (a weight tier, harness, provider, model, or custom tag) resolves to a random healthy member carrying it at each dispatch."
        testID="room-reviewer-sheet"
        title={`Reviewer for ${roomName}`}
        visible={pickerVisible}
      >
        <HullActionSheetRow
          disabled={busy}
          label="None"
          onPress={() => void changeReviewer({ reviewerAgentId: null, reviewerClass: null })}
          selected={!selectedReviewerAgentId && !selectedReviewerClass}
          testID="room-reviewer-none"
        />
        {agents.map((agent) => (
          <HullActionSheetRow
            disabled={busy}
            key={agent.pubkey}
            label={`@${agent.handle ?? agent.name}`}
            onPress={() => void changeReviewer({ reviewerAgentId: agent.pubkey, reviewerClass: null })}
            selected={selectedReviewerAgentId === agent.pubkey}
            testID={`room-reviewer-agent-${agent.pubkey}`}
          />
        ))}
        <HullActionSheetRow
          disabled={busy}
          label={selectedReviewerClass ? `Class: ${selectedReviewerClass}` : 'Class…'}
          onPress={() => {
            setClassDraft(selectedReviewerClass ?? '');
            setClassDialogVisible(true);
          }}
          selected={Boolean(selectedReviewerClass)}
          testID="room-reviewer-class"
        />
        {error ? (
          <View accessibilityRole="alert" style={styles.error} testID="room-reviewer-error">
            <Text style={styles.errorText}>! {error}</Text>
          </View>
        ) : null}
        <HullActionSheetCancel
          onPress={() => setPickerVisible(false)}
          testID="room-reviewer-close"
        />
      </HullActionSheetModal>
      <HullDialog
        accessibilityLabel="Close reviewer class dialog"
        body="A word every candidate agent's tag set can match: a weight tier (god, heavy, light), a harness, a provider, an exact model id, or a custom tag."
        dismissOnBackdrop={!busy}
        onRequestClose={() => setClassDialogVisible(false)}
        testID="room-reviewer-class-dialog"
        title="Reviewer class"
        visible={classDialogVisible}
        actions={[
          { label: 'Cancel', onPress: () => setClassDialogVisible(false), disabled: busy },
          {
            label: busy ? 'Saving…' : 'Save',
            onPress: () =>
              void changeReviewer({ reviewerClass: classDraft.trim(), reviewerAgentId: null }),
            busy,
            disabled: busy || !isClassOrTagReference(classDraft.trim()),
            testID: 'room-reviewer-class-save',
          },
        ]}
      >
        <TextInput
          accessibilityLabel="Reviewer class"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          onChangeText={setClassDraft}
          placeholder="heavy"
          placeholderTextColor={theme.buzz.dim}
          style={styles.classInput}
          testID="room-reviewer-class-input"
          value={classDraft}
        />
      </HullDialog>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  error: {
    borderTopColor: theme.buzz.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  errorText: {
    ...theme.buzz.type.meta,
    color: theme.buzz.danger,
    fontFamily: theme.buzz.proseRegular,
  },
  classInput: {
    ...theme.buzz.type.body,
    minHeight: 44,
    paddingHorizontal: theme.buzz.space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.buzz.border,
    borderRadius: theme.buzz.radius,
    color: theme.buzz.textPrimary,
    marginTop: theme.buzz.space.sm,
  },
}));
