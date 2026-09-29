import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { RoomViewIdentity } from '@beeline/buzz-client';
import { AGENT_TIERS } from '@beeline/api-contract/phone';

import { ROOM_LABEL } from '@/buzz/vocabulary';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';

export type RoomReviewerUpdate =
  | { roomId: string; reviewerAgentId: string | null }
  | { roomId: string; reviewerClass: string };

type RoomReviewerActionsProps = {
  agents: readonly RoomViewIdentity[];
  canManage: boolean;
  hasRepository: boolean;
  onSaved?: () => void;
  reviewerAgentId?: string;
  /** Set when the reviewer is a class; `reviewerAgentId` is then its current pick. */
  reviewerClass?: string;
  /** Custom tags carried by this Room's agents, offered as classes beside the tiers. */
  loadClassTags?: () => Promise<readonly string[]>;
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
  loadClassTags,
  roomId,
  roomName,
  updateRoom,
}: RoomReviewerActionsProps) {
  const [pickerVisible, setPickerVisible] = useState(false);
  const [selectedReviewerAgentId, setSelectedReviewerAgentId] = useState(reviewerAgentId);
  const [selectedClass, setSelectedClass] = useState(reviewerClass);
  const [classTags, setClassTags] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setSelectedReviewerAgentId(reviewerAgentId), [reviewerAgentId]);
  useEffect(() => setSelectedClass(reviewerClass), [reviewerClass]);
  useEffect(() => {
    if (!pickerVisible || !loadClassTags) return;
    let live = true;
    loadClassTags().then(
      (tags) => live && setClassTags(tags),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [loadClassTags, pickerVisible]);

  const selectedReviewer = useMemo(
    () => agents.find((agent) => agent.pubkey === selectedReviewerAgentId),
    [agents, selectedReviewerAgentId],
  );
  const pickedLabel = selectedReviewer
    ? `@${selectedReviewer.handle ?? selectedReviewer.name}`
    : undefined;
  const reviewerLabel = selectedClass
    ? `Any ${selectedClass}${pickedLabel ? ` · now ${pickedLabel}` : ''}`
    : (pickedLabel ?? 'None');

  const save = useCallback(
    async (input: RoomReviewerUpdate) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await updateRoom(input);
        if ('reviewerClass' in input) {
          // The server picks the class's first reviewer; the refresh names it.
          setSelectedClass(input.reviewerClass);
          setSelectedReviewerAgentId(undefined);
        } else {
          setSelectedClass(undefined);
          setSelectedReviewerAgentId(input.reviewerAgentId ?? undefined);
        }
        setPickerVisible(false);
        onSaved?.();
      } catch (caught) {
        setError(`Could not change ${ROOM_LABEL} reviewer: ${String(caught)}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, onSaved, updateRoom],
  );
  const changeReviewer = useCallback(
    async (nextReviewerAgentId: string | null) => {
      if (!selectedClass && (selectedReviewerAgentId ?? null) === nextReviewerAgentId) {
        setPickerVisible(false);
        return;
      }
      await save({ roomId, reviewerAgentId: nextReviewerAgentId });
    },
    [roomId, save, selectedClass, selectedReviewerAgentId],
  );
  const changeClass = useCallback(
    async (nextClass: string) => {
      if (selectedClass === nextClass) {
        setPickerVisible(false);
        return;
      }
      await save({ roomId, reviewerClass: nextClass });
    },
    [roomId, save, selectedClass],
  );
  const classes = [...AGENT_TIERS, ...classTags.filter((tag) => !AGENT_TIERS.includes(tag as never))];

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
        subtitle="Reviews every pull request opened from the Room. A class picks a healthy agent at random and moves to the next one if it fails."
        testID="room-reviewer-sheet"
        title={`Reviewer for ${roomName}`}
        visible={pickerVisible}
      >
        <HullActionSheetRow
          disabled={busy}
          label="None"
          onPress={() => void changeReviewer(null)}
          selected={!selectedClass && !selectedReviewerAgentId}
          testID="room-reviewer-none"
        />
        {classes.map((agentClass) => (
          <HullActionSheetRow
            disabled={busy}
            key={`class-${agentClass}`}
            label={`Any ${agentClass} agent`}
            metadata="class"
            onPress={() => void changeClass(agentClass)}
            selected={selectedClass === agentClass}
            testID={`room-reviewer-class-${agentClass}`}
          />
        ))}
        {agents.map((agent) => (
          <HullActionSheetRow
            disabled={busy}
            key={agent.pubkey}
            label={`@${agent.handle ?? agent.name}`}
            onPress={() => void changeReviewer(agent.pubkey)}
            selected={!selectedClass && selectedReviewerAgentId === agent.pubkey}
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
    ...theme.buzz.type.meta,
    color: theme.buzz.danger,
    fontFamily: theme.buzz.proseRegular,
  },
}));
