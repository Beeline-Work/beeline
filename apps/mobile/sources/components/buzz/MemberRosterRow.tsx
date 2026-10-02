import React, { type ReactNode } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { fallbackMemberHandle } from '@/buzz/member-display';
import { displayModel } from '@/buzz/model-display';
import { Typography } from '@/constants/Typography';
import { IdentityMark } from './IdentityMark';

type SharedRowProps = {
  avatarUrl?: string;
  disabled?: boolean;
  divider: 'top' | 'bottom';
  face?: string;
  handle?: string;
  name: string;
  onPress?: () => void;
  pubkey: string;
  seed?: string;
  testID: string;
  trailing?: ReactNode;
};

export type MemberRosterRowProps = SharedRowProps &
  (
    | {
        kind: 'human';
        role?: string;
      }
    | {
        alive?: boolean;
        kind: 'agent';
        model?: string;
        ownerHandle?: string;
      }
  );

export function memberRosterTitle(identity: { handle?: string; pubkey: string }): string {
  return `@${identity.handle ?? fallbackMemberHandle(identity.pubkey)}`;
}

/** The second line: a person's Room role, or an agent's owner when it has a handle. */
export function memberRosterSubtitle(
  member: { kind: 'human'; role?: string } | { kind: 'agent'; ownerHandle?: string },
): string | undefined {
  if (member.kind === 'human') return member.role ?? 'member';
  return member.ownerHandle ? `@${member.ownerHandle}` : undefined;
}

/** An agent's model, right-aligned on the handle line. */
export function memberRosterModel(member: { kind: 'human' } | { kind: 'agent'; model?: string }) {
  return member.kind === 'agent' && member.model ? displayModel(member.model) : undefined;
}

/**
 * The one member-list presentation shared by the Workspace Members page and
 * Room/corner roster sheets. Callers retain only their actions, detail panels,
 * and which edge owns the section divider.
 */
export function MemberRosterRow(props: MemberRosterRowProps) {
  const title = memberRosterTitle(props);
  const subtitle = memberRosterSubtitle(props);
  const model = memberRosterModel(props);
  const address = title.slice(1);
  // Presence is not spoken: it ages out while an idle agent waits on its
  // socket, so only a live turn is named, matching the ring.
  const workingState = props.kind === 'agent' && props.alive ? ', working' : '';

  return (
    <TouchableOpacity
      accessibilityLabel={`${title}, ${props.kind === 'human' ? 'person' : 'agent'}${workingState}, at ${address}`}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.row, props.divider === 'top' ? styles.dividerTop : styles.dividerBottom]}
      testID={props.testID}
    >
      <IdentityMark
        kind={props.kind}
        seed={props.seed ?? props.pubkey}
        avatarUrl={props.avatarUrl}
        face={props.face}
        name={props.name}
        size={38}
        alive={props.kind === 'agent' ? props.alive : undefined}
      />
      <View style={styles.copy}>
        <View style={styles.titleLine}>
          <Text numberOfLines={1} style={styles.title}>
            {title}
          </Text>
          {model ? (
            <Text numberOfLines={1} style={styles.model}>
              {model}
            </Text>
          ) : null}
        </View>
        {subtitle !== undefined ? (
          <Text numberOfLines={1} style={styles.subtitle}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {props.trailing}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create((theme) => {
  const { buzz: hull } = theme;
  return {
    row: {
      minHeight: hull.layout.row,
      paddingHorizontal: hull.space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.md,
    },
    dividerTop: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    dividerBottom: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    copy: { flex: 1, minWidth: 0 },
    titleLine: { flexDirection: 'row', alignItems: 'baseline', gap: hull.space.sm },
    title: { ...Typography.default(), ...hull.type.body, flexShrink: 1, color: hull.textPrimary },
    model: {
      ...Typography.default(),
      ...hull.type.meta,
      flexShrink: 0,
      marginLeft: 'auto',
      maxWidth: '50%',
      textAlign: 'right',
      color: hull.textMuted,
    },
    subtitle: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
  };
});
