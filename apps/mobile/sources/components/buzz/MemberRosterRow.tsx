import { type AgentUsage, usageDollars, usageTokens } from '@beeline/api-contract/phone';
import { usageTime } from '@/buzz/agent-usage';
import React, { type ReactNode } from 'react';
import {
  Text,
  TouchableOpacity,
  View,
  type AccessibilityRole,
  type AccessibilityState,
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { fallbackMemberHandle } from '@/buzz/member-display';
import { displayModel } from '@/buzz/model-display';
import { Typography } from '@/constants/Typography';
import { IdentityMark } from './IdentityMark';

type SharedRowProps = {
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  title?: string;
  subtitle?: string;
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
        usage?: AgentUsage;
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

/**
 * Usage text appended to an owner's agent row only when it needs attention:
 * a window, allowance or key limit at 80% or more (warning), or a stop (danger).
 */
export function memberRosterUsage(
  usage: AgentUsage | undefined,
): { text: string; tone: 'warning' | 'danger' } | undefined {
  if (!usage) return undefined;
  if (usage.free) {
    const f = usage.free;
    if (f.paused) return { text: `paused · back ${usageTime(f.resetsAt)}`, tone: 'danger' };
    return f.used / f.limit >= 0.8
      ? { text: `${usageTokens(f.used)} of ${usageTokens(f.limit)} today`, tone: 'warning' }
      : undefined;
  }
  if (usage.spend) {
    const s = usage.spend;
    if (!s.limit) return undefined;
    if (s.rejected) return { text: 'key limit reached', tone: 'danger' };
    return 1 - (s.remaining ?? 0) / s.limit >= 0.8
      ? { text: `${usageDollars(s.remaining ?? 0)} of ${usageDollars(s.limit)} left`, tone: 'warning' }
      : undefined;
  }
  const stopped = usage.windows.find((w) => w.status === 'rejected');
  if (stopped)
    return {
      text: `limit reached${stopped.resetsAt ? ` · back ${usageTime(stopped.resetsAt)}` : ''}`,
      tone: 'danger',
    };
  const hot = usage.windows.filter((w) => (w.utilization ?? 0) >= 0.8);
  if (!hot.length) return undefined;
  const short: Record<string, string> = { five_hour: '5h', seven_day: 'week', seven_day_opus: 'Opus week' };
  return {
    text: hot
      .map((w) => `${short[w.rateLimitType] ?? w.rateLimitType.replaceAll('_', ' ')} ${Math.round((w.utilization ?? 0) * 100)}%`)
      .join(' · '),
    tone: 'warning',
  };
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
  const Row = props.onPress ? TouchableOpacity : View;
  const usage = props.kind === 'agent' ? memberRosterUsage(props.usage) : undefined;
  const title = props.title ?? memberRosterTitle(props);
  const subtitle = props.subtitle ?? memberRosterSubtitle(props);
  const model = memberRosterModel(props);
  const address = title.slice(1);
  // Presence is not spoken: it ages out while an idle agent waits on its
  // socket, so only a live turn is named, matching the ring.
  const workingState = props.kind === 'agent' && props.alive ? ', working' : '';

  return (
    <Row
      accessibilityLabel={
        props.accessibilityLabel ??
        `${title}, ${props.kind === 'human' ? 'person' : 'agent'}${workingState}, at ${address}`
      }
      accessibilityRole={props.accessibilityRole ?? (props.onPress ? 'button' : undefined)}
      accessibilityState={props.accessibilityState}
      {...(props.onPress ? { disabled: props.disabled, onPress: props.onPress } : {})}
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
            {usage ? (
              <>
                {subtitle}
                <Text style={usage.tone === 'danger' ? styles.danger : styles.warning}>
                  {` · ${usage.text}`}
                </Text>
              </>
            ) : (
              subtitle
            )}
          </Text>
        ) : null}
      </View>
      {props.trailing}
    </Row>
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
    warning: { color: hull.accent },
    danger: { color: hull.dialogDanger },
    subtitle: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
  };
});
