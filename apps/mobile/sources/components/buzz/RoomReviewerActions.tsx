import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { RoomViewIdentity } from '@beeline/buzz-client';

import { ROOM_LABEL } from '@/buzz/vocabulary';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';

export type RoomReviewerUpdate = {
  roomId: string;
  reviewerAgentId: string | null;
  reviewerFallbackIds: string[];
};

type RoomReviewerActionsProps = {
  agents: readonly RoomViewIdentity[];
  canManage: boolean;
  hasRepository: boolean;
  onSaved?: () => void;
  reviewerAgentId?: string;
  /** Agents tried in order after `reviewerAgentId`. */
  reviewerFallbackIds?: readonly string[];
  roomId: string;
  roomName: string;
  updateRoom: (input: RoomReviewerUpdate) => Promise<unknown>;
};

function reviewerOrder(reviewerAgentId?: string, reviewerFallbackIds?: readonly string[]): string[] {
  if (!reviewerAgentId) return [];
  return [reviewerAgentId, ...(reviewerFallbackIds ?? []).filter((id) => id !== reviewerAgentId)];
}

/**
 * The repository Room's reviewer control, shared by phone and desktop sheets:
 * an ordered list of agents. Tapping an agent adds it to the end of the list
 * or takes it off.
 */
export function RoomReviewerActions({
  agents,
  canManage,
  hasRepository,
  onSaved,
  reviewerAgentId,
  reviewerFallbackIds,
  roomId,
  roomName,
  updateRoom,
}: RoomReviewerActionsProps) {
  const [pickerVisible, setPickerVisible] = useState(false);
  const [order, setOrder] = useState(() => reviewerOrder(reviewerAgentId, reviewerFallbackIds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const savedOrderKey = reviewerOrder(reviewerAgentId, reviewerFallbackIds).join(',');
  useEffect(() => setOrder(savedOrderKey ? savedOrderKey.split(',') : []), [savedOrderKey]);

  const handleOf = useCallback(
    (id: string) => {
      const agent = agents.find((candidate) => candidate.pubkey === id);
      return agent ? `@${agent.handle ?? agent.name}` : null;
    },
    [agents],
  );
  const reviewerLabel = useMemo(() => {
    const handles = order.map(handleOf).filter((handle): handle is string => handle !== null);
    return handles.length ? handles.join(', then ') : 'None';
  }, [handleOf, order]);

  const changeReviewers = useCallback(
    async (next: string[]) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await updateRoom({
          roomId,
          reviewerAgentId: next[0] ?? null,
          reviewerFallbackIds: next.slice(1),
        });
        setOrder(next);
        if (!next.length) setPickerVisible(false);
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
        accessibilityLabel={`Choose reviewers, currently ${reviewerLabel}`}
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
        subtitle="The first healthy agent on this list reviews every pull request opened from the Room. If its review fails or goes silent, the next one takes over. Tap an agent to add it to the end of the list or take it off."
        testID="room-reviewer-sheet"
        title={`Reviewers for ${roomName}`}
        visible={pickerVisible}
      >
        <HullActionSheetRow
          disabled={busy}
          label="None"
          onPress={() => void changeReviewers([])}
          selected={!order.length}
          testID="room-reviewer-none"
        />
        {agents.map((agent) => {
          const position = order.indexOf(agent.pubkey);
          return (
            <HullActionSheetRow
              accessibilityLabel={
                position >= 0
                  ? `@${agent.handle ?? agent.name}, reviewer ${position + 1} of ${order.length}. Take off the list`
                  : `@${agent.handle ?? agent.name}. Add to the end of the list`
              }
              disabled={busy}
              key={agent.pubkey}
              label={`@${agent.handle ?? agent.name}`}
              metadata={position >= 0 ? `#${position + 1}` : undefined}
              onPress={() =>
                void changeReviewers(
                  position >= 0
                    ? order.filter((id) => id !== agent.pubkey)
                    : [...order, agent.pubkey],
                )
              }
              testID={`room-reviewer-agent-${agent.pubkey}`}
            />
          );
        })}
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
