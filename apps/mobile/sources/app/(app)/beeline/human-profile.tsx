import { Typography } from '@/constants/Typography';
import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RoomViewMember, WorkspaceView } from '@beeline/api-contract/phone';
import { loadBuzzIdentity, getEffectiveRelayUrl } from '@/auth/buzz-identity-storage';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { MonoButton } from '@/components/buzz/MonoHull';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { Modal } from '@/modal/ModalManager';
import { navigateToRoom } from '@/buzz/corner-navigation';

export function HumanProfile({
  workspaceId,
  memberId,
  onClose,
}: {
  workspaceId: string;
  memberId: string;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const allowNavigation = useRef(false);
  const [member, setMember] = useState<RoomViewMember | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState<RoomViewMember['role']>('member');
  const [retry, setRetry] = useState(0);
  const mutation = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMember(null);
    setWorkspace(null);
    setError(null);
    setEditing(false);
    void (async () => {
      const identity = await loadBuzzIdentity();
      if (!identity) throw new Error('Sign in to view this profile.');
      const baseUrl = await getEffectiveRelayUrl();
      const client = new RoomViewClient({ identity, baseUrl });
      const [surface, page] = await Promise.all([
        client.workspace(workspaceId),
        client.workspaceMembers(workspaceId, { memberId }),
      ]);
      const person = page.members.find((entry) => entry.identity.pubkey === memberId);
      if (!person) throw new Error('This person is no longer a member of this Workspace.');
      if (!cancelled) {
        setWorkspace(surface);
        setMember(person);
        setRole(person.role);
      }
    })()
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, memberId, retry]);
  const self = workspace?.viewer.identity.pubkey === memberId;
  const manager = Boolean(workspace?.viewer.permissions.manage);
  const canEditRole =
    !self &&
    manager &&
    Boolean(member) &&
    (workspace?.viewer.role === 'owner' || member?.role === 'member');
  const canBan = canEditRole && member?.role !== 'owner';
  const perform = async (action: () => Promise<void>) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  };
  const dirty = editing && member !== null && role !== member.role;
  const confirmDiscard = async () =>
    !dirty ||
    (await Modal.confirm('Discard role change?', 'The new role has not been saved.', {
      cancelText: 'Keep editing',
      confirmText: 'Discard',
      destructive: true,
    }));
  const close = async () => {
    if (busy || !(await confirmDiscard())) return;
    allowNavigation.current = true;
    onClose();
  };
  useEffect(() => {
    if (!dirty) return;
    return navigation.addListener('beforeRemove', (event) => {
      if (allowNavigation.current) return;
      event.preventDefault();
      void confirmDiscard().then((confirmed) => {
        if (confirmed) {
          allowNavigation.current = true;
          navigation.dispatch(event.data.action);
        }
      });
    });
  }, [navigation, dirty]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void close();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [dirty, busy, onClose]);
  const ban = async () => {
    if (!canBan || !member) return;
    const confirmed = await Modal.confirm(
      `Ban ${member.identity.name}?`,
      'They will lose access to this Workspace and every Room in it. Invites cannot bring them back until a manager lifts the ban.',
      { cancelText: 'Cancel', confirmText: 'Ban', destructive: true },
    );
    if (confirmed)
      await perform(async () => {
        await monolithPhoneOperation('banWorkspaceMember', { workspaceId, memberId });
        onClose();
      });
  };
  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="human-profile">
      <View style={styles.header}>
        <MonoButton label="Back" variant="secondary" onPress={() => void close()} disabled={busy} />
        <Text style={styles.title}>Profile</Text>
        {canEditRole && !editing && (
          <MonoButton
            label="Edit"
            variant="secondary"
            onPress={() => setEditing(true)}
            testID="edit-person-role"
          />
        )}
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        {loading && <SurfaceGlyphLoader />}
        {error && (
          <View>
            <Text style={styles.copy} accessibilityRole="alert">
              {error}
            </Text>
            {!member && <MonoButton label="Retry" onPress={() => setRetry((value) => value + 1)} />}
          </View>
        )}
        {member && (
          <>
            <View style={styles.identity}>
              <IdentityMark
                kind="human"
                seed={memberId}
                name={member.identity.name}
                face={member.identity.face}
                avatarUrl={member.identity.avatar}
                size={72}
              />
              <Text style={styles.name}>{member.identity.name}</Text>
              {member.identity.handle && <Text style={styles.copy}>@{member.identity.handle}</Text>}
            </View>
            {!self && (
              <SettingsRow
                title="Message"
                tone="action"
                chevron="right"
                disabled={busy}
                testID="human-profile-message"
                onPress={() =>
                  void perform(async () => {
                    if (!(await confirmDiscard())) return;
                    const room = await monolithPhoneOperation('resolveDirectMessage', {
                      workspaceId,
                      participantId: memberId,
                    });
                    allowNavigation.current = true;
                    navigateToRoom(router, room.id);
                  })
                }
              />
            )}
            {self && (
              <SettingsRow
                title="Edit your profile"
                tone="action"
                chevron="right"
                onPress={() => router.push('/beeline/settings/identity')}
              />
            )}
            <Text style={styles.section}>Workspace</Text>
            <SettingsRow
              title="Role"
              value={
                member.role === 'owner' ? 'Owner' : member.role === 'admin' ? 'Admin' : 'Member'
              }
            />
            {editing && canEditRole && (
              <View testID="person-role-editor">
                {(
                  [
                    'member',
                    'admin',
                    ...(workspace?.viewer.role === 'owner' ? ['owner'] : []),
                  ] as RoomViewMember['role'][]
                ).map((choice) => (
                  <SettingsRow
                    key={choice}
                    title={choice === 'owner' ? 'Owner' : choice === 'admin' ? 'Admin' : 'Member'}
                    value={role === choice ? 'Selected' : undefined}
                    disabled={busy}
                    testID={`person-role-${choice}`}
                    onPress={() => setRole(choice)}
                  />
                ))}
                <View style={styles.actions}>
                  <MonoButton
                    label="Cancel"
                    variant="secondary"
                    disabled={busy}
                    onPress={() => {
                      setRole(member.role);
                      setEditing(false);
                    }}
                  />
                  <MonoButton
                    label="Save"
                    disabled={busy}
                    loading={busy}
                    testID="save-person-role"
                    onPress={() =>
                      void perform(async () => {
                        await monolithPhoneOperation('addWorkspaceMember', {
                          workspaceId,
                          memberId,
                          role,
                        });
                        setMember({ ...member, role });
                        setEditing(false);
                      })
                    }
                  />
                </View>
              </View>
            )}
            {canBan && (
              <SettingsRow
                title="Ban from Workspace"
                tone="destructive"
                disabled={busy}
                testID="ban-person"
                onPress={() => void ban()}
              />
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
export default function HumanProfileRoute() {
  const { communityId, memberId } = useLocalSearchParams<{
    communityId: string;
    memberId: string;
  }>();
  return (
    <HumanProfile
      key={`${communityId}:${memberId}`}
      workspaceId={communityId}
      memberId={memberId}
      onClose={() => router.back()}
    />
  );
}
const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minWidth: 0, backgroundColor: theme.buzz.bgBase },
  header: {
    minHeight: 60,
    paddingHorizontal: theme.buzz.space.md,
    flexDirection: 'row',
    gap: theme.buzz.space.md,
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  title: {
    ...Typography.default(),
    ...theme.buzz.type.bodyStrong,
    color: theme.buzz.textPrimary,
    flex: 1,
  },
  content: { paddingHorizontal: theme.buzz.space.md },
  identity: {
    alignItems: 'center',
    paddingVertical: theme.buzz.space.lg,
    gap: theme.buzz.space.md,
  },
  name: {
    ...Typography.default(),
    ...theme.buzz.type.hero,
    color: theme.buzz.textPrimary,
    textAlign: 'center',
  },
  copy: { ...Typography.default(), ...theme.buzz.type.body, color: theme.buzz.textSecondary },
  section: {
    ...Typography.default(),
    ...theme.buzz.type.sectionHead,
    color: theme.buzz.textMuted,
    paddingTop: theme.buzz.space.md,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.buzz.space.md,
    paddingVertical: theme.buzz.space.md,
  },
}));
