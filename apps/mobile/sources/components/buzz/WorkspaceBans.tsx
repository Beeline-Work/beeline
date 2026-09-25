import React, { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { Modal } from '@/modal/ModalManager';
import { SettingsRow } from './SettingsRow';
import { MonoButton } from './MonoHull';

type BannedMember = PhoneOperationMap['listWorkspaceBans']['output']['members'][number];
export function WorkspaceBans({ workspaceId }: { workspaceId: string }) {
  const [members, setMembers] = useState<readonly BannedMember[]>([]);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const load = async (offset = 0) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      const page = await monolithPhoneOperation('listWorkspaceBans', { workspaceId, offset });
      setMembers((current) => (offset ? [...current, ...page.members] : page.members));
      setHasMore(page.hasMore);
      setLoaded(true);
    } catch {
      setError('Could not load bans. Try again.');
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  const lift = async (member: BannedMember) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      const confirmed = await Modal.confirm(
        `Lift ban for ${member.name}?`,
        'They can join again with an invite. This does not restore their membership.',
        { cancelText: 'Cancel', confirmText: 'Lift ban' },
      );
      if (!confirmed) return;
      await monolithPhoneOperation('unbanWorkspaceMember', {
        workspaceId,
        memberId: member.pubkey,
      });
      setMembers((current) => current.filter((entry) => entry.pubkey !== member.pubkey));
    } catch {
      setError('Could not lift this ban. Try again.');
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return (
    <View testID="workspace-bans">
      <SettingsRow
        title="Banned members"
        chevron={open ? 'up' : 'down'}
        disabled={busy}
        onPress={() => {
          setOpen(!open);
          if (!open) void load();
        }}
      />
      {open && (
        <>
          {members.map((member) => (
            <SettingsRow
              key={member.pubkey}
              title={member.name}
              description={member.kind === 'agent' ? 'Agent' : 'Person'}
              actionControl={{
                label: 'Lift ban',
                disabled: busy || !member.canLift,
                onPress: () => void lift(member),
              }}
            />
          ))}
          {loaded && !busy && !members.length && (
            <Text style={styles.copy}>No banned members.</Text>
          )}
          {error && (
            <Text style={styles.copy} accessibilityRole="alert">
              {error}
            </Text>
          )}
          {(hasMore || error || busy) && (
            <MonoButton
              label={busy ? 'Loading…' : error ? 'Retry' : 'Show more'}
              loading={busy}
              disabled={busy}
              variant="secondary"
              onPress={() => void load(error ? 0 : members.length)}
            />
          )}
        </>
      )}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  copy: {
    ...theme.buzz.type.body,
    color: theme.buzz.textSecondary,
    paddingVertical: theme.buzz.space.md,
  },
}));
