import { type AgentUsage, usageDollars, usageTokens } from '@beeline/api-contract/phone';
import { usageTime } from '@/buzz/agent-usage';
import React, { type ReactNode } from 'react';
import { Text, type AccessibilityRole, type AccessibilityState } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { fallbackMemberHandle } from '@/buzz/member-display';
import { displayModel } from '@/buzz/model-display';
import { Typography } from '@/constants/Typography';
import { IdentityMark } from './IdentityMark';
import { IndexRow, type IndexRowProps } from './IndexRow';

type SharedRowProps = {
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  title?: string;
  subtitle?: string;
  avatarUrl?: string;
  chevron?: IndexRowProps['chevron'];
  /** `sheet` rows sit in a sheet: the sheet row height and edge. */
  density?: IndexRowProps['density'];
  disabled?: boolean;
  divider: 'top' | 'bottom';
  face?: string;
  handle?: string;
  inset?: IndexRowProps['inset'];
  name: string;
  onPress?: () => void;
  pubkey: string;
  seed?: string;
  testID: string;
  trailing?: ReactNode;
  /** A quiet state on the trailing axis (`Opening…`). */
  value?: string;
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

/** The second line: a person's Workspace role, or an agent's owner when it has a handle. */
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
    if (s.rejected) return { text: 'key limit reached', tone: 'danger' };
    if (!s.limit) return undefined;
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
 * The roster preset of the one index row (`IndexRow`): a leading identity
 * mark, the handle, and a quiet role or owner line. Shared by the Workspace
 * Members page and Room/corner roster sheets; callers retain only their
 * actions, detail panels, and which edge owns the section divider.
 */
export function MemberRosterRow(props: MemberRosterRowProps) {
  const usage = props.kind === 'agent' ? memberRosterUsage(props.usage) : undefined;
  const title = props.title ?? memberRosterTitle(props);
  const subtitle = props.subtitle ?? memberRosterSubtitle(props);
  const address = title.slice(1);
  // Presence is not spoken: it ages out while an idle agent waits on its
  // socket, so only a live turn is named, matching the ring.
  const workingState = props.kind === 'agent' && props.alive ? ', working' : '';

  return (
    <IndexRow
      accessibilityLabel={
        props.accessibilityLabel ??
        `${title}, ${props.kind === 'human' ? 'person' : 'agent'}${workingState}, at ${address}`
      }
      accessibilityRole={props.accessibilityRole}
      accessibilityState={props.accessibilityState}
      chevron={props.chevron}
      density={props.density}
      description={subtitle}
      descriptionContent={
        subtitle !== undefined && usage ? (
          <Text numberOfLines={1} style={styles.subtitle}>
            {subtitle}
            <Text style={usage.tone === 'danger' ? styles.danger : styles.warning}>
              {` · ${usage.text}`}
            </Text>
          </Text>
        ) : undefined
      }
      disabled={props.disabled}
      divider={props.divider}
      inset={props.inset}
      leading={
        <IdentityMark
          kind={props.kind}
          seed={props.seed ?? props.pubkey}
          avatarUrl={props.avatarUrl}
          face={props.face}
          name={props.name}
          size={38}
          alive={props.kind === 'agent' ? props.alive : undefined}
        />
      }
      onPress={props.onPress}
      testID={props.testID}
      title={title}
      titleAside={memberRosterModel(props)}
      trailing={props.trailing}
      value={props.value}
    />
  );
}

const styles = StyleSheet.create((theme) => {
  const { buzz: hull } = theme;
  return {
    warning: { color: hull.accent },
    danger: { color: hull.dialogDanger },
    subtitle: { ...Typography.default(), ...hull.type.meta, flex: 1, minWidth: 0, color: hull.textMuted },
  };
});
