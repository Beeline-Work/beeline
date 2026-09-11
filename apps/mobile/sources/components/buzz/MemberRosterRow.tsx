import React, { type ReactNode } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { fallbackMemberHandle } from '@/buzz/member-display';
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
        online?: boolean;
        ownerHandle?: string;
      }
  );

export function memberRosterTitle(identity: { handle?: string; pubkey: string }): string {
  return `@${identity.handle ?? fallbackMemberHandle(identity.pubkey)}`;
}

export function memberRosterSubtitle(
  member:
    { kind: 'human'; role?: string } | { kind: 'agent'; model?: string; ownerHandle?: string },
): string {
  if (member.kind === 'human') return member.role ?? 'member';
  return [member.model ?? '—', member.ownerHandle ? `by @${member.ownerHandle}` : undefined]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

/**
 * The one member-list presentation shared by the Workspace Members page and
 * Room/corner roster sheets. Callers retain only their actions, detail panels,
 * and which edge owns the section divider.
 */
export function MemberRosterRow(props: MemberRosterRowProps) {
  const title = memberRosterTitle(props);
  const subtitle = memberRosterSubtitle(props);
  const address = title.slice(1);
  const onlineState =
    props.kind === 'agent' && props.online !== undefined
      ? props.online
        ? ', online'
        : ', offline'
      : '';

  return (
    <TouchableOpacity
      accessibilityLabel={`${title}, ${props.kind === 'human' ? 'person' : 'agent'}${onlineState}, at ${address}`}
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
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        <Text numberOfLines={1} style={styles.subtitle}>
          {subtitle}
        </Text>
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
    title: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary },
    subtitle: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
  };
});
