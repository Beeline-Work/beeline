import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { WorkspaceMemberGrantView } from '@beeline/api-contract/phone';
import { grantProvenanceLine } from '@/buzz/agent-grant-copy';
import { SettingsRow } from './SettingsRow';
import { IdentityMark } from './IdentityMark';

/** `@handle` when the identity has one, its name otherwise. */
function named(identity: WorkspaceMemberGrantView['requestedBy']): string {
  return identity.handle ? `@${identity.handle}` : identity.name;
}

/**
 * One settled grant on a human profile's read-only ledger — the same
 * disclosure shape as `ToolDetailsCell`: collapsed it is exactly a
 * `SettingsRow` (the agent's mark, the target, the agent's stated reason, and
 * the provenance line), and tapping it reveals the rest beneath.
 *
 * Display only. Nothing here mutates a grant; a decision lives on the card in
 * the Room the grant was asked in.
 */
export function MemberGrantRow({
  grant,
  roomName,
}: {
  readonly grant: WorkspaceMemberGrantView;
  /** The Room's name when the viewer's workspace read carried one; the id is
   *  the honest fallback, never a fabricated label. */
  readonly roomName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const provenance = grantProvenanceLine(grant);
  const script = grant.script;
  return (
    <View testID={`grant-row-${grant.grantId}`}>
      <SettingsRow
        accessibilityLabel={`${grant.target}. ${grant.reason}. ${provenance}. Requested by ${named(grant.requestedBy)}.`}
        chevron={expanded ? 'up' : 'down'}
        description={grant.reason}
        descriptionDetail={provenance}
        leading={
          <IdentityMark
            kind="agent"
            seed={grant.agent.pubkey}
            avatarUrl={grant.agent.avatar}
            face={grant.agent.face}
            name={grant.agent.name}
            size={26}
          />
        }
        onPress={() => setExpanded((open) => !open)}
        testID={`member-grant-${grant.grantId}`}
        title={grant.target}
      />
      {expanded ? (
        <View style={styles.body} testID={`member-grant-${grant.grantId}-details`}>
          <Text style={styles.line}>{`Requested by ${named(grant.requestedBy)}`}</Text>
          <Text style={styles.line}>{`Room ${roomName ?? grant.roomId}`}</Text>
          {script ? (
            <>
              <Text style={styles.line}>{`Script ${script.path} · ${script.bytes} bytes`}</Text>
              <Text selectable style={styles.machine}>
                {script.contents}
              </Text>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    body: {
      paddingBottom: hull.space.md,
      paddingLeft: hull.space.xl,
      paddingRight: hull.space.sm,
      paddingTop: hull.space.sm,
      gap: hull.space.sm,
    },
    line: { ...hull.type.meta, color: hull.textSecondary },
    machine: { ...hull.type.machine, color: hull.textPrimary },
  };
});
