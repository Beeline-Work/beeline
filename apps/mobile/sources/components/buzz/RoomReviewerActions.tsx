import { appErrorCopy } from '@/buzz/app-error-copy';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { RoomViewIdentity } from '@beeline/buzz-client';

import { ROOM_LABEL } from '@/buzz/vocabulary';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';

export type RoomReviewerUpdate = {
  roomId: string;
  reviewerAgentId: string | null;
};

const AUTO_MERGE_REVIEWER_WARNING =
  "This repository allows auto-merge. If auto-merge is turned on for a corner's pull request, GitHub merges it as soon as checks pass, before the Beeline reviewer is asked to look. Turn off auto-merge in this repository's GitHub settings to protect reviewer approval.";

export function RoomReviewerAutoMergeNotice({
  visible,
  surface = false,
  testID,
}: {
  visible: boolean;
  surface?: boolean;
  testID: string;
}) {
  if (!visible) return null;
  return (
    <View
      accessibilityRole="alert"
      style={surface ? styles.surfaceWarning : styles.error}
      testID={testID}
    >
      <Text style={styles.errorText}>! {AUTO_MERGE_REVIEWER_WARNING}</Text>
    </View>
  );
}

export function RoomReviewerSurfaceNotice({
  allowAutoMerge,
  canManage,
  isCorner,
  reviewerAgentId,
}: {
  allowAutoMerge?: boolean;
  canManage: boolean;
  isCorner: boolean;
  reviewerAgentId?: string;
}) {
  return (
    <RoomReviewerAutoMergeNotice
      visible={Boolean(allowAutoMerge && canManage && !isCorner && reviewerAgentId)}
      surface
      testID="room-auto-merge-reviewer-notice"
    />
  );
}

type RoomReviewerActionsProps = {
  agents: readonly RoomViewIdentity[];
  /** GitHub's repository-level auto-merge toggle for this Room's repo. */
  allowAutoMerge?: boolean;
  canManage: boolean;
  hasRepository: boolean;
  onSaved?: (reviewerAgentId: string | null) => void;
  reviewerAgentId?: string;
  roomId: string;
  roomName: string;
  updateRoom: (input: RoomReviewerUpdate) => Promise<unknown>;
};

/** HullActionSheetRow's minimum height; the list window is sized in rows. */
const REVIEWER_ROW_HEIGHT = 52;
/** Rows visible at once; the rest of the list scrolls. */
const REVIEWER_VISIBLE_ROWS = 5;

/**
 * The repository Room's reviewer control, shared by phone and desktop sheets:
 * one agent, or none.
 */
export function RoomReviewerActions({
  agents,
  allowAutoMerge,
  canManage,
  hasRepository,
  onSaved,
  reviewerAgentId,
  roomId,
  roomName,
  updateRoom,
}: RoomReviewerActionsProps) {
  const [pickerVisible, setPickerVisible] = useState(false);
  const [reviewer, setReviewer] = useState<string | null>(reviewerAgentId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setReviewer(reviewerAgentId ?? null), [reviewerAgentId]);

  const handleOf = useCallback(
    (id: string) => {
      const agent = agents.find((candidate) => candidate.pubkey === id);
      return agent ? `@${agent.handle ?? agent.name}` : null;
    },
    [agents],
  );
  const reviewerLabel = useMemo(() => (reviewer ? handleOf(reviewer) : null) ?? 'None', [handleOf, reviewer]);

  const changeReviewer = useCallback(
    async (next: string | null) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await updateRoom({ roomId, reviewerAgentId: next });
        setReviewer(next);
        setPickerVisible(false);
        onSaved?.(next);
      } catch (caught) {
        setError(appErrorCopy(caught, `Could not change ${ROOM_LABEL} reviewer.`));
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
      <RoomReviewerAutoMergeNotice
        visible={Boolean(allowAutoMerge && reviewer)}
        testID="room-reviewer-auto-merge-warning"
      />
      <HullActionSheetModal
        accessibilityLabel="Close reviewer picker"
        dismissOnBackdrop={!busy}
        footer={
          <>
            <RoomReviewerAutoMergeNotice
              visible={Boolean(allowAutoMerge)}
              testID="room-reviewer-auto-merge-picker-warning"
            />
            {error ? (
              <View accessibilityRole="alert" style={styles.error} testID="room-reviewer-error">
                <Text style={styles.errorText}>! {error}</Text>
              </View>
            ) : null}
            <HullActionSheetCancel
              label="Done"
              onPress={() => setPickerVisible(false)}
              testID="room-reviewer-close"
            />
          </>
        }
        onClose={() => {
          if (!busy) setPickerVisible(false);
        }}
        scrollBody={false}
        subtitle="This agent reviews every pull request opened from the Room."
        testID="room-reviewer-sheet"
        title={`Reviewer for ${roomName}`}
        visible={pickerVisible}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          style={{ flexGrow: 0, maxHeight: REVIEWER_VISIBLE_ROWS * REVIEWER_ROW_HEIGHT }}
          testID="room-reviewer-list"
        >
          <HullActionSheetRow
            disabled={busy}
            label="None"
            onPress={() => void changeReviewer(null)}
            selected={!reviewer}
            testID="room-reviewer-none"
          />
          {agents.map((agent) => (
            <HullActionSheetRow
              disabled={busy}
              key={agent.pubkey}
              label={`@${agent.handle ?? agent.name}`}
              onPress={() => void changeReviewer(agent.pubkey)}
              selected={reviewer === agent.pubkey}
              testID={`room-reviewer-agent-${agent.pubkey}`}
            />
          ))}
        </ScrollView>
      </HullActionSheetModal>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  error: {
    borderTopColor: theme.buzz.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: theme.buzz.space.md,
    paddingVertical: theme.buzz.space.sm,
  },
  surfaceWarning: {
    borderBottomColor: theme.buzz.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: theme.buzz.space.md,
    paddingVertical: theme.buzz.space.sm,
    backgroundColor: theme.buzz.bgHighlight,
  },
  errorText: {
    ...theme.buzz.type.meta,
    color: theme.buzz.danger,
    fontFamily: theme.buzz.proseRegular,
  },
}));
