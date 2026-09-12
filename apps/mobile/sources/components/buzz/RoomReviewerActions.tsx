import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { RoomViewIdentity } from '@beeline/buzz-client';

import { ROOM_LABEL } from '@/buzz/vocabulary';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';

export type RoomReviewerUpdate = {
  roomId: string;
  reviewerAgentId: string | null;
};

type RoomReviewerActionsProps = {
  agents: readonly RoomViewIdentity[];
  canManage: boolean;
  hasRepository: boolean;
  onSaved?: () => void;
  reviewerAgentId?: string;
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
  roomId,
  roomName,
  updateRoom,
}: RoomReviewerActionsProps) {
  const [pickerVisible, setPickerVisible] = useState(false);
  const [selectedReviewerAgentId, setSelectedReviewerAgentId] = useState(reviewerAgentId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setSelectedReviewerAgentId(reviewerAgentId), [reviewerAgentId]);

  const selectedReviewer = useMemo(
    () => agents.find((agent) => agent.pubkey === selectedReviewerAgentId),
    [agents, selectedReviewerAgentId],
  );
  const reviewerLabel = selectedReviewer
    ? `@${selectedReviewer.handle ?? selectedReviewer.name}`
    : 'None';

  const changeReviewer = useCallback(
    async (nextReviewerAgentId: string | null) => {
      if (busy) return;
      if ((selectedReviewerAgentId ?? null) === nextReviewerAgentId) {
        setPickerVisible(false);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await updateRoom({ roomId, reviewerAgentId: nextReviewerAgentId });
        setSelectedReviewerAgentId(nextReviewerAgentId ?? undefined);
        setPickerVisible(false);
        onSaved?.();
      } catch (caught) {
        setError(`Could not change ${ROOM_LABEL} reviewer: ${String(caught)}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, onSaved, roomId, selectedReviewerAgentId, updateRoom],
  );

  if (!canManage || !hasRepository) return null;

  return (
    <>
      <HullActionSheetRow
        accessibilityLabel={`Choose reviewer, currently ${reviewerLabel}`}
        chevron="right"
        description="Reviews every pull request opened from this Room."
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
        subtitle="This agent reviews every pull request opened from the Room."
        testID="room-reviewer-sheet"
        title={`Reviewer for ${roomName}`}
        visible={pickerVisible}
      >
        <HullActionSheetRow
          disabled={busy}
          label="None"
          onPress={() => void changeReviewer(null)}
          selected={!selectedReviewerAgentId}
          testID="room-reviewer-none"
        />
        {agents.map((agent) => (
          <HullActionSheetRow
            disabled={busy}
            key={agent.pubkey}
            label={`@${agent.handle ?? agent.name}`}
            onPress={() => void changeReviewer(agent.pubkey)}
            selected={selectedReviewerAgentId === agent.pubkey}
            testID={`room-reviewer-agent-${agent.pubkey}`}
          />
        ))}
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
    color: theme.buzz.danger,
    fontSize: 12,
    lineHeight: 17,
  },
}));
