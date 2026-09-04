import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { HullActionSheet } from './HullActionSheet';
import { HullModal } from './HullDialog';
import { IdentityMark } from './IdentityMark';
import { BrassButton, PixelLoader } from './MonoHull';
import {
  RoomMemberPickerActions,
  type MemberPickerKind,
} from './RoomMemberPickerActions';

export type MemberPickerCandidate = {
  pubkey: string;
  name: string;
  handle: string;
  kind: 'person' | 'agent';
  /** People: the chosen face on record. */
  face?: string;
  avatarUrl?: string;
};

export const MEMBER_PICKER_TITLE = 'Add people or agents';

type MemberPickerSheetProps = {
  visible: boolean;
  onClose: () => void;
  /**
   * Workspace people and agents not yet in the Room in scope. `null` while
   * that read is in flight; `undefined` when no Room is in scope (the
   * Workspace Members page), where only the two Workspace-level ways in apply.
   */
  candidates: readonly MemberPickerCandidate[] | null | undefined;
  /** Narrow the checkbox list to one kind (the /invite and /add-agent verbs). */
  kind?: MemberPickerKind;
  /**
   * Everyone of that kind in the Workspace besides the viewer, in-Room or
   * not. An empty list with peers is "already here"; without them it is an
   * empty Workspace (C83).
   */
  workspacePeerCount?: number;
  canManage: boolean;
  busy: boolean;
  error: string | null;
  /** Adds every checked candidate to the Room in scope. */
  onAdd: (pubkeys: string[]) => void;
  onInvitePerson: () => void;
  onConnectAgent: () => void;
  /** The minted `npx usebeeline connect <code>` line once "Connect a new agent…" ran (Members page only). */
  pairCommand?: string | null;
  onCopyPairCommand?: (command: string) => void;
  testID?: string;
};

/**
 * The ONE picker for bringing people and agents in. From a Room it lists the
 * Workspace members not yet in that Room as checkbox rows and adds the
 * checked ones (captain report C74: the path Room → existing Workspace agent
 * → member of THIS Room). From the Members page it carries only the two
 * Workspace-level ways in — an invite link for a person, the pairing command
 * for a new agent — which a Room picker ends with as well (C59).
 */
export function MemberPickerSheet({
  visible,
  onClose,
  candidates,
  kind = null,
  workspacePeerCount = 0,
  canManage,
  busy,
  error,
  onAdd,
  onInvitePerson,
  onConnectAgent,
  pairCommand = null,
  onCopyPairCommand,
  testID = 'member-picker-sheet',
}: MemberPickerSheetProps) {
  const insets = useSafeAreaInsets();
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!visible) setChecked(new Set());
  }, [visible]);

  const visibleCandidates = useMemo(
    () => (candidates ?? []).filter((candidate) => !kind || candidate.kind === kind),
    [candidates, kind],
  );
  const roomInScope = candidates !== undefined;
  const chosen = visibleCandidates.filter((candidate) => checked.has(candidate.pubkey));

  const toggle = (pubkey: string) =>
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(pubkey)) next.delete(pubkey);
      else next.add(pubkey);
      return next;
    });

  return (
    <HullModal
      accessibilityLabel="Close member picker"
      contentStyle={styles.modalContent}
      onRequestClose={onClose}
      placement="bottom"
      visible={visible}
    >
      <HullActionSheet
        style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 10) }]}
        testID={testID}
        title={MEMBER_PICKER_TITLE}
      >
        <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {roomInScope && candidates === null && (
            <View style={styles.loading} testID="member-picker-loading">
              <PixelLoader />
            </View>
          )}
          {visibleCandidates.map((candidate) => {
            const isChecked = checked.has(candidate.pubkey);
            return (
              <Pressable
                accessibilityLabel={`${candidate.name}, ${candidate.kind}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isChecked, disabled: busy }}
                disabled={busy}
                key={candidate.pubkey}
                onPress={() => toggle(candidate.pubkey)}
                style={styles.row}
                testID={`member-picker-candidate-${candidate.pubkey}`}
              >
                {candidate.kind === 'agent' ? (
                  <IdentityMark
                    kind="agent"
                    seed={candidate.pubkey}
                    avatarUrl={candidate.avatarUrl}
                    name={candidate.name}
                    size={38}
                  />
                ) : (
                  <IdentityMark
                    kind="human"
                    seed={candidate.pubkey}
                    avatarUrl={candidate.avatarUrl}
                    face={candidate.face}
                    name={candidate.name}
                    size={38}
                  />
                )}
                <View style={styles.copy}>
                  <Text numberOfLines={1} style={styles.name}>
                    {candidate.name}
                  </Text>
                  <Text numberOfLines={1} style={styles.meta}>
                    @{candidate.handle}
                  </Text>
                </View>
                <View
                  style={[styles.check, isChecked && styles.checkOn]}
                  testID={`member-picker-check-${candidate.pubkey}`}
                />
              </Pressable>
            );
          })}
          <RoomMemberPickerActions
            addableCount={visibleCandidates.length}
            busy={busy}
            canManage={canManage}
            kind={kind}
            workspacePeerCount={workspacePeerCount}
            onAddAgent={onConnectAgent}
            onInvitePerson={onInvitePerson}
            showEmpty={roomInScope && candidates !== null}
          />
          {pairCommand && (
            <View style={styles.pairing} testID="invite-agent-flow">
              <Text style={styles.meta}>
                Run this where the new agent will live. It joins every Room you're in.
              </Text>
              <TouchableOpacity
                accessibilityLabel="Copy connect command"
                onPress={() => onCopyPairCommand?.(pairCommand)}
                style={styles.commandRow}
              >
                <Text selectable style={styles.command} testID="pair-agent-command">
                  {pairCommand}
                </Text>
                <Text style={styles.copyLabel}>Copy</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
        {chosen.length > 0 && (
          <View style={styles.footer}>
            <BrassButton
              label={`Add ${chosen.length}`}
              loading={busy}
              onPress={() => onAdd(chosen.map((candidate) => candidate.pubkey))}
              testID="member-picker-add"
            />
          </View>
        )}
        {error && (
          <Text accessibilityRole="alert" style={styles.error} testID="member-picker-error">
            ! {error}
          </Text>
        )}
      </HullActionSheet>
    </HullModal>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    modalContent: { paddingHorizontal: 0, maxHeight: '82%' },
    sheet: { maxHeight: '100%' },
    loading: { paddingVertical: hull.space.lg, alignItems: 'center' },
    row: {
      minHeight: hull.layout.row,
      paddingHorizontal: hull.space.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    copy: { flex: 1, minWidth: 0 },
    name: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary },
    meta: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    // The unread square's vocabulary: a box lights brass when it is chosen.
    check: {
      width: 18,
      height: 18,
      borderRadius: hull.radius,
      borderWidth: 1,
      borderColor: hull.borderStrong,
    },
    checkOn: { backgroundColor: hull.accent, borderColor: hull.accent },
    pairing: {
      paddingHorizontal: hull.space.md,
      paddingVertical: hull.space.md,
      gap: hull.space.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    commandRow: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
      paddingHorizontal: hull.space.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
      borderRadius: hull.radius,
    },
    command: { ...Typography.mono(), ...hull.type.machine, color: hull.textPrimary, flex: 1 },
    copyLabel: { ...Typography.default(), ...hull.type.meta, color: hull.accent },
    footer: {
      paddingHorizontal: hull.space.md,
      paddingTop: hull.space.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    error: {
      ...Typography.default(),
      ...hull.type.meta,
      paddingHorizontal: hull.space.md,
      paddingTop: hull.space.sm,
      color: hull.danger,
    },
  };
});
