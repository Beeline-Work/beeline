import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { Typography } from '@/constants/Typography';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RoomViewMember, WorkspaceMemberListView } from '@beeline/api-contract/phone';
import { loadBuzzIdentity, getEffectiveRelayUrl } from '@/auth/buzz-identity-storage';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { ProfileIdentity } from '@/components/buzz/ProfileIdentity';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { Button } from '@/components/buzz/Button';
import { PageHeader } from '@/components/buzz/PageHeader';
import { ProfileActions } from '@/components/buzz/ProfileActions';
import { MemberGrantRow } from '@/components/buzz/MemberGrantRow';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { Modal } from '@/modal/ModalManager';
import { navigateToRoom } from '@/buzz/corner-navigation';
import { displayModel } from '@/buzz/model-display';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import {
  recordWorkspacePage,
  recordWorkspaceRemoval,
  recordWorkspaceRole,
  useWorkspaceRecords,
  workspaceOwnedAgents,
  workspaceRecord,
  workspaceRecordScope,
} from '@/buzz/workspace-records';
import { watchWorkspace } from '@/buzz/workspace-watch';
import { currentSurfaceStamp } from '@/buzz/surface-clock';
import { isWorkspaceMemberListView } from '@beeline/buzz-client';

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
  const [recordScope, setRecordScope] = useState<string | null>(null);
  const [profile, setProfile] = useState<WorkspaceMemberListView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useLatencyRouteFrame('/beeline/human-profile', !loading, true);
  const [busy, setBusy] = useState(false);
  const [agentsHasMore, setAgentsHasMore] = useState(false);
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState<RoomViewMember['role']>('member');
  const [retry, setRetry] = useState(0);
  const mutation = useRef(false);
  // Member, role and owned agents select the shared Workspace records, so a
  // change from Members, another device or a live identity event lands here.
  // Grants select the member profile projection, which the shared Workspace
  // watch refreshes.
  useWorkspaceRecords(recordScope);
  const record = workspaceRecord(recordScope, memberId);
  const member = record ? (record as RoomViewMember) : null;
  const removed = record === null;
  const connectedAgents = workspaceOwnedAgents(recordScope, memberId);
  const viewer = profile?.viewer;
  const grants = profile?.grants ?? [];
  useEffect(() => {
    if (!editing && member) setRole(member.role);
  }, [editing, member?.role]);
  useEffect(() => {
    setEditing(false);
  }, [workspaceId, memberId, retry]);
  useEffect(() => {
    let cancelled = false;
    let stopProfile: (() => void) | undefined;
    let stopWatch: (() => void) | undefined;
    setLoading(true);
    setError(null);
    void (async () => {
      const [identity, baseUrl] = await Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]);
      if (!identity) throw new Error('Sign in to view this profile.');
      if (cancelled) return;
      setRecordScope(workspaceRecordScope(baseUrl, identity.publicKey, workspaceId));
      const address = surfaceAddress(baseUrl, identity.publicKey, '/workspace/:id/members/:memberId',
        { workspaceId, memberId });
      // One read names the person, their grants and the agents they own.
      const http = new RoomViewClient({ identity, baseUrl });
      const read = () => mobileSurfaceCache.fetch(address, isWorkspaceMemberListView,
        () => http.workspaceMembers(workspaceId, { memberId }));
      // The same relay watch Members refreshes from, on the grants' Rooms.
      const watch = watchWorkspace(identity, baseUrl, workspaceId,
        () => void read().catch(() => undefined));
      stopWatch = watch.release;
      const show = (next: WorkspaceMemberListView) => {
        setProfile(next);
        watch.rooms((next.grants ?? []).map((grant) => grant.roomId));
      };
      stopProfile = mobileSurfaceCache.subscribe(address, () => {
        const next = mobileSurfaceCache.peek(address, isWorkspaceMemberListView);
        if (!cancelled && next) show(next);
      });
      const cached = await mobileSurfaceCache.read(address, isWorkspaceMemberListView);
      if (cancelled) return;
      if (cached) {
        show(cached);
        setLoading(false);
      }
      await watch.ready;
      const fresh = await read();
      if (cancelled) return;
      if (fresh) {
        show(fresh);
        setAgentsHasMore(fresh.agentsTruncated);
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
      stopProfile?.();
      stopWatch?.();
    };
  }, [workspaceId, memberId, retry]);
  const displayedError = error ?? (removed ? 'This person is no longer a member of this Workspace.' : null);
  const self = viewer?.identity.pubkey === memberId;
  const manager = Boolean(viewer?.permissions.manage);
  const canEditRole =
    !self &&
    manager &&
    Boolean(member) &&
    ((viewer?.role === 'owner' && member?.role !== 'owner') ||
      (viewer?.role === 'admin' &&
        (member?.role === 'member' || member?.role === 'spectator')));
  const canRemove = canEditRole;
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
  const removeMember = async () => {
    if (!canRemove || !member) return;
    const confirmed = await Modal.confirm(
      `Remove ${member.identity.name}?`,
      'This removes them from every Room and the Workspace. They can rejoin only with a new invite.',
      { cancelText: 'Cancel', confirmText: 'Remove', destructive: true },
    );
    if (confirmed)
      await perform(async () => {
        await monolithPhoneOperation('removeWorkspaceMember', { workspaceId, memberId });
        if (recordScope) recordWorkspaceRemoval(recordScope, memberId);
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
        {displayedError && (
          <View>
            <Text style={styles.copy} accessibilityRole="alert">
              {displayedError}
            </Text>
            {!member && (
              <Button
                label="Retry"
                onPress={() => setRetry((value) => value + 1)}
                variant="secondary"
              />
            )}
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
                                    if (recordScope) recordWorkspaceRole(recordScope, memberId, role);
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
                <RoomListSectionHeader title="Access level" inset="content" />
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
                {canRemove && (
                  <TouchableOpacity
                    accessibilityLabel="Remove from Workspace"
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void removeMember()}
                    style={styles.removeMemberControl}
                    testID="remove-person"
                  >
                    <Text style={styles.removeMemberText}>
                      {busy ? 'Removing…' : 'Remove from Workspace'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
            <RoomListSectionHeader title="Connected agents" inset="content" />
            {connectedAgents.length ? (
              connectedAgents.map((agent) => (
                <SettingsRow
                  key={agent.identity.pubkey}
                  title={agent.identity.handle ? `@${agent.identity.handle}` : 'Handle unavailable'}
                  description={agent.model ? displayModel(agent.model) : undefined}
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
              <Button
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
                    const stamp = currentSurfaceStamp();
                    const page = await client.workspaceMembers(workspaceId, {
                      kind: 'agent',
                      ownerId: memberId,
                      offset: connectedAgents.length,
                    });
                    if (recordScope)
                      recordWorkspacePage(recordScope, page, { kind: 'agent', append: true, stamp });
                    setAgentsHasMore(page.agentsTruncated);
                  })
                }
              />
            )}
            <RoomListSectionHeader title="Grants" inset="content" />
            {grants.length ? (
              grants.map((grant) => (
                <MemberGrantRow
                  key={grant.grantId}
                  grant={grant}
                  roomName={grant.roomName}
                  revokeBusy={busy}
                  onRevoke={grant.kind === 'shared_asset' && grant.status === 'approved' &&
                    (viewer?.role === 'owner' || viewer?.role === 'admin' ||
                      viewer?.identity.pubkey === memberId)
                    ? () => void perform(async () => {
                        await monolithPhoneOperation('revokeAgentGrant', { grantId: grant.grantId });
                        setRetry((value) => value + 1);
                      })
                    : undefined}
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
  useLatencyRouteFrame('/beeline/human-profile');
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
  copy: { ...Typography.default(), ...theme.buzz.type.body, color: theme.buzz.textSecondary },
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
    backgroundColor: theme.buzz.buttonPrimaryFill,
    borderColor: theme.buzz.buttonPrimaryFill,
  },
  roleLabel: {
    ...Typography.default('semiBold'),
    ...theme.buzz.type.meta,
    color: theme.buzz.textSecondary,
  },
  roleLabelSelected: { color: theme.buzz.buttonPrimaryText },
  // Same compact full-width control as the agent profile's removeAgentControl
  // (members.tsx): the red border carries the destructive meaning at the 3:1
  // non-text floor, the label stays primary ink to hold the 4.5:1 text floor.
  removeMemberControl: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: theme.buzz.space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.buzz.dialogDanger,
    borderRadius: theme.buzz.radius,
    marginTop: theme.buzz.space.md,
  },
  removeMemberText: {
    ...Typography.default(),
    ...theme.buzz.type.body,
    color: theme.buzz.textPrimary,
    textAlign: 'center',
  },
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
}));
