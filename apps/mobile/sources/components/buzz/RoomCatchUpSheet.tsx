import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { HullActionSheetModal, HULL_SHEET_INSET } from '@/components/buzz/HullActionSheet';
import { catchUpClock, type CatchUpReport } from '@/buzz/room-catch-up-report';

/**
 * The catch-up sheet: a bottom-anchored modal with an overview and a model
 * request. The overview is optional while older history is loading.
 *
 * 1. Summary — prose over the unread range, the range itself stated in the
 *    sheet head (`Since 08:04 · newest 09:46`);
 * 2. Needs you — decisions and action items in ONE list, each attributed to
 *    whoever is waiting (`Niglet · 09:46`).
 *
 * Selecting an agent prepares an explicit tagged request in the composer, so
 * the reader reviews and sends the model request through the ordinary Room
 * turn path. A draft already in progress stays untouched.
 *
 * Both doors into it — the catch-up strip under the Room header and a
 * long-press on the disc's badge — pass the same report, built once at the
 * one seam (`buzz/room-catch-up-report.ts`).
 */
export function RoomCatchUpSheet({
  agents,
  canDraft,
  onAskAgent,
  onClose,
  report,
  visible,
}: {
  agents: readonly { pubkey: string; name: string; handle: string }[];
  canDraft: boolean;
  onAskAgent: (agent: { pubkey: string; name: string; handle: string }) => void;
  onClose: () => void;
  report: CatchUpReport | null;
  visible: boolean;
}) {
  return (
    <HullActionSheetModal
      accessibilityLabel="Close catch up"
      modalTestID="catch-up-sheet-modal"
      onClose={onClose}
      subtitle={report?.rangeLabel ?? 'From your unread point'}
      testID="catch-up-sheet"
      title="Catch up"
      visible={visible}
    >
      {report && (
        <View style={styles.block} testID="catch-up-sheet-summary">
          <Text style={styles.blockHead}>Summary</Text>
          <Text style={styles.summary}>{report.summary}</Text>
        </View>
      )}
      {report && (
        <View style={styles.block} testID="catch-up-sheet-needs-you">
          <Text style={styles.blockHead}>Needs you</Text>
          {report.needsYou.length === 0 ? (
            <Text style={styles.empty}>Nothing is waiting on you.</Text>
          ) : (
            report.needsYou.map((item) => (
              <View key={item.id} style={styles.item} testID={`catch-up-needs-you-${item.kind}`}>
                <Text style={styles.itemText}>{item.text}</Text>
                <Text style={styles.itemAttribution}>
                  {`${item.requesterName} · ${catchUpClock(item.at)}`}
                </Text>
              </View>
            ))
          )}
        </View>
      )}
      <View style={styles.block} testID="catch-up-sheet-agents">
        <Text style={styles.blockHead}>Ask an agent</Text>
        <Text style={styles.hint}>Choose an agent, then review and send the request.</Text>
        {!canDraft ? (
          <Text style={styles.empty}>Finish your current draft to ask for a catch up.</Text>
        ) : agents.length === 0 ? (
          <Text style={styles.empty}>Add an agent to this Room to get a model catch up.</Text>
        ) : (
          agents.map((agent) => (
            <Pressable
              accessibilityLabel={`Draft catch up request to ${agent.name}`}
              accessibilityRole="button"
              key={agent.pubkey}
              onPress={() => onAskAgent(agent)}
              style={styles.agentAction}
              testID={`catch-up-agent-${agent.pubkey}`}
            >
              <Text style={styles.agentText}>{agent.name}</Text>
            </Pressable>
          ))
        )}
      </View>
    </HullActionSheetModal>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    block: {
      paddingHorizontal: HULL_SHEET_INSET,
      paddingBottom: groknight.space.md,
    },
    blockHead: {
      ...Typography.default('semiBold'),
      ...groknight.type.sectionHead,
      color: groknight.ledgerQuiet,
      paddingBottom: groknight.space.sm,
    },
    summary: {
      ...Typography.default('regular'),
      ...groknight.type.body,
      color: groknight.ledgerBody,
    },
    empty: {
      ...Typography.default('regular'),
      ...groknight.type.meta,
      color: groknight.ledgerGhost,
    },
    hint: {
      ...Typography.default('regular'),
      ...groknight.type.meta,
      color: groknight.ledgerQuiet,
      paddingBottom: groknight.space.sm,
    },
    agentAction: {
      minHeight: 44,
      justifyContent: 'center',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: groknight.border,
    },
    agentText: {
      ...Typography.default('semiBold'),
      ...groknight.type.body,
      color: groknight.accent,
    },
    // One list for decisions and action items alike: what is being asked, and
    // who is waiting. Splitting them was the mock this replaces.
    item: {
      paddingBottom: groknight.space.sm,
    },
    itemText: {
      ...Typography.default('regular'),
      ...groknight.type.body,
      color: groknight.ledgerBody,
    },
    itemAttribution: {
      ...Typography.default('regular'),
      ...groknight.type.meta,
      color: groknight.ledgerQuiet,
      fontVariant: ['tabular-nums'],
    },
  };
});
