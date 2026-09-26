import { Typography } from '@/constants/Typography';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type {
  RoomViewMember,
  WorkspaceMemberGrantView,
  WorkspaceView,
} from '@beeline/api-contract/phone';
import { loadBuzzIdentity, getEffectiveRelayUrl } from '@/auth/buzz-identity-storage';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { ProfileIdentity } from '@/components/buzz/ProfileIdentity';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { MonoButton } from '@/components/buzz/MonoHull';
import { PageHeader } from '@/components/buzz/PageHeader';
import { ProfileActions } from '@/components/buzz/ProfileActions';
import { MemberGrantRow } from '@/components/buzz/MemberGrantRow';
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
  const [connectedAgents, setConnectedAgents] = useState<WorkspaceView['agents']>([]);
  const [grants, setGrants] = useState<readonly WorkspaceMemberGrantView[]>([]);
  const [agentsHasMore, setAgentsHasMore] = useState(false);
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
      const [surface, page, owned] = await Promise.all([
        client.workspace(workspaceId),
        client.workspaceMembers(workspaceId, { memberId }),
        client.workspaceMembers(workspaceId, { kind: 'agent', ownerId: memberId }),
      ]);
      const person = page.members.find((entry) => entry.identity.pubkey === memberId);
      if (!person) throw new Error('This person is no longer a member of this Workspace.');
      if (!cancelled) {
        if (surface.viewer.identity.pubkey === memberId) {
          router.replace('/beeline/settings');
          return;
        }
        setWorkspace(surface);
        setConnectedAgents(owned.agents);
        setGrants(page.grants ?? []);
        setAgentsHasMore(owned.agentsTruncated);
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
    ((workspace?.viewer.role === 'owner' && member?.role !== 'owner') ||
      (workspace?.viewer.role === 'admin' &&
        (member?.role === 'member' || member?.role === 'spectator')));
  const canBan = canEditRole;
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
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
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
      <PageHeader
        backAccessibilityLabel="Back"
        backTestID="close-human-profile"
        onBack={() => void close()}
        prominent
        testID="human-profile-header"
        title="Profile"
      />
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
            <ProfileIdentity
              identity={member.identity}
              role={member.role}
              actions={
                !self ? (
                  <ProfileActions
                    actions={[
                      {
                        label: 'Message',
                        disabled: busy,
                        testID: 'human-profile-message',
                        onPress: () =>
                          void perform(async () => {
                            if (!(await confirmDiscard())) return;
                            const room = await monolithPhoneOperation('resolveDirectMessage', {
                              workspaceId,
                              participantId: memberId,
                            });
                            allowNavigation.current = true;
                            navigateToRoom(router, room.id);
                          }),
                      },
                      ...(canEditRole
                        ? editing
                          ? [
                              {
                                label: 'Cancel',
                                disabled: busy,
                                onPress: () => {
                                  setRole(member.role);
                                  setEditing(false);
                                },
                                testID: 'cancel-person-role',
                              },
                              {
                                label: busy ? 'Saving…' : 'Save',
                                disabled: busy,
                                testID: 'save-person-role',
                                onPress: () =>
                                  void perform(async () => {
                                    await monolithPhoneOperation('addWorkspaceMember', {
                                      workspaceId,
                                      memberId,
                                      role,
                                    });
                                    setMember({ ...member, role });
                                    setEditing(false);
                                  }),
                              },
                            ]
                          : [
                              {
                                label: 'Edit',
                                disabled: busy,
                                onPress: () => setEditing(true),
                                testID: 'edit-person-role',
                              },
                            ]
                        : []),
                    ]}
                  />
                ) : undefined
              }
            />
            {self && (
              <SettingsRow
                title="Edit your profile"
                tone="action"
                chevron="right"
                onPress={() => router.push('/beeline/settings/identity')}
              />
            )}
            {editing && canEditRole && (
              <View testID="person-role-editor">
                <Text style={styles.section}>Access level</Text>
                <View
                  accessibilityRole="radiogroup"
                  style={styles.roleToggle}
                  testID="person-role-selector"
                >
                  {(['member', 'admin'] as const).map((choice) => {
                    const selected = role === choice;
                    return (
                      <TouchableOpacity
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected, disabled: busy }}
                        disabled={busy}
                        key={choice}
                        onPress={() => setRole(choice)}
                        style={[styles.roleChoice, selected && styles.roleChoiceSelected]}
                        testID={`person-role-${choice}`}
                      >
                        <Text style={[styles.roleLabel, selected && styles.roleLabelSelected]}>
                          {choice === 'admin' ? 'Admin' : 'Member'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <SettingsRow
                  title="Ban from Workspace"
                  tone="destructive"
                  disabled={busy}
                  testID="ban-person"
                  onPress={() => void ban()}
                />
              </View>
            )}
            <Text style={styles.section}>Connected agents</Text>
            {connectedAgents.length ? (
              connectedAgents.map((agent) => (
                <SettingsRow
                  key={agent.identity.pubkey}
                  title={agent.identity.handle ? `@${agent.identity.handle}` : 'Handle unavailable'}
                  description={agent.model}
                  chevron="right"
                  onPress={() =>
                    router.push({
                      pathname: '/beeline/agent-profile',
                      params: { communityId: workspaceId, agentId: agent.identity.pubkey },
                    })
                  }
                />
              ))
            ) : (
              <Text style={styles.copy}>No connected agents in this Workspace.</Text>
            )}
            {agentsHasMore && (
              <MonoButton
                label="More"
                disabled={busy}
                testID="more-connected-agents"
                onPress={() =>
                  void perform(async () => {
                    const identity = await loadBuzzIdentity();
                    if (!identity) throw new Error('Sign in to continue.');
                    const client = new RoomViewClient({
                      identity,
                      baseUrl: await getEffectiveRelayUrl(),
                    });
                    const page = await client.workspaceMembers(workspaceId, {
                      kind: 'agent',
                      ownerId: memberId,
                      offset: connectedAgents.length,
                    });
                    setConnectedAgents((current) => [...current, ...page.agents]);
                    setAgentsHasMore(page.agentsTruncated);
                  })
                }
              />
            )}
            <Text style={styles.section}>Grants</Text>
            {grants.length ? (
              grants.map((grant) => (
                <MemberGrantRow
                  key={grant.grantId}
                  grant={grant}
                  roomName={
                    workspace?.managerSettings?.rooms?.find((room) => room.id === grant.roomId)
                      ?.name
                  }
                />
              ))
            ) : (
              <Text style={styles.copy} testID="member-grants-empty">
                No grants to show.
              </Text>
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
  // The segmented control is sized to its two labels, never stretched across
  // the content column: `alignSelf` keeps it a label-width plate on the
  // section head's left edge, and the two options carry no `flex`. At desktop
  // width a `flex: 1` option filled the whole profile column for two short
  // words (captain report, profile follow-up).
  roleToggle: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: theme.buzz.space.sm,
    paddingVertical: theme.buzz.space.sm,
  },
  roleChoice: {
    alignItems: 'center',
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.radius,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: theme.buzz.space.md,
  },
  roleChoiceSelected: {
    backgroundColor: theme.buzz.accent,
    borderColor: theme.buzz.accent,
  },
  roleLabel: {
    ...Typography.default('semiBold'),
    ...theme.buzz.type.meta,
    color: theme.buzz.textSecondary,
  },
  roleLabelSelected: { color: theme.buzz.textInverted },
}));
