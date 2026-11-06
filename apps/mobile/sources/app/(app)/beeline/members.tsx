import { useMembersRouteState } from './useMembersRouteState';
import { useMembersReads } from './useMembersReads';
import { useMembersMembership } from './useMembersMembership';
import { useMembersSoul } from './useMembersSoul';
import { useMembersConfiguration } from './useMembersConfiguration';
import { useMembersPresentation } from './useMembersPresentation';
import { ErrorBanner } from '@/components/buzz/ErrorBanner';
import { useSurfaceFocus } from '@/buzz/use-surface-focus';
import { presentPersonInvite } from '@/components/buzz/PersonInviteSheet';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop } from '@/utils/responsive';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { HullDialogInput } from '@/components/buzz/HullDialog';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { useTextDraft } from '@/buzz/use-text-draft';
import { SettingsRow } from '@/components/buzz/SettingsRow';
import { HullActionSheetModal, HullActionSheetRow, HullActionSheetCancel } from '@/components/buzz/HullActionSheet';
import { AgentProfileView } from '@/components/buzz/AgentProfileView';
import { USAGE_REFRESH_CLIENT_TIMEOUT_MS } from '@/components/buzz/AgentUsageSection';
// Members is the canonical combined People + Agents surface. It lives in its
// own route file: Expo Router routes every default-exporting file under `app/`,
// so a screen beside its route is a second URL for the same screen.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, Switch, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router, useLocalSearchParams, useNavigation, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AGENT_NAME_MAX_LENGTH, isAgentDetailView, isAllowedAgentModelConfigCategory, isReasonableAgentName, isWorkspaceView, type AgentDetailView, type AgentModelConfigInput, type AgentModelConfigOption, type Identity, type WorkspaceView, } from '@beeline/buzz-client';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { createCommunityInviteUrl, resolveCommunityInvitePublicOrigin, } from '@/buzz/community-invite';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { agentPairingCommand } from '@/buzz/agent-pairing-command';
import { defaultAgentPersona } from '@/buzz/agent-persona';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { useSurfaceSnapshot } from '@/buzz/use-shared-surface';

import { MemberRosterRow } from '@/components/buzz/MemberRosterRow';
import { MemberPickerSheet } from '@/components/buzz/MemberPickerSheet';
import { navigateToRoom } from '@/buzz/corner-navigation';
import { displayModel } from '@/buzz/model-display';
import { modelChoiceLabel, modelPickerChoiceLabel } from '@beeline/api-contract/phone';
import { Button } from '@/components/buzz/Button';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { MEMBERS_LABEL } from '@/buzz/vocabulary';
import { BuzzRigTransport } from '@/sync/transport';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { Typography } from '@/constants/Typography';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { workspaceRailItem } from '@/buzz/room-view-presentation';
import {
  recordWorkspacePage,
  recordWorkspaceRemoval,
  useWorkspaceRecords,
  workspaceRecordScope,
  workspaceRows,
  workspacePage,
} from '@/buzz/workspace-records';
import { watchWorkspace } from '@/buzz/workspace-watch';
import { currentSurfaceStamp } from '@/buzz/surface-clock';
import {
  effortConfigAxis,
  fastModeConfigAxis,
  filterAgentModelOptions,
} from '@/buzz/agent-model-picker';
import { Modal } from '@/modal/ModalManager';
import { PageHeader } from '@/components/buzz/PageHeader';

async function copyText(value: string): Promise<void> {
  await (await import('expo-clipboard')).setStringAsync(value);
}

export type MembersAction =
  | 'invite-person'
  | 'pair-agent'
  | 'person-role'
  | 'remove-person'
  | 'message-person'
  | 'save-agent-soul'
  | 'remove-agent'
  | 'model-config'
  | 'model-catalog'
  | 'agent-yolo'
  | 'agent-access';

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function newerConfigVersion(candidate: string, current: string | undefined): boolean {
  return (
    !current ||
    candidate.length > current.length ||
    (candidate.length === current.length && candidate > current)
  );
}

export function ownerByline(
  owner: NonNullable<WorkspaceView['agents'][number]['owner']>,
): string | undefined {
  return owner.handle ? `by @${owner.handle}` : undefined;
}

export type ModelAxisKind = 'model' | 'effort';

export const MODEL_APPLIES_NOTE_MS = 4_000;
const UNSET_VALUE = '—';

function axisValue(
  detail: AgentDetailView,
  kind: ModelAxisKind,
  axis: AgentModelConfigOption | undefined,
): string | undefined {
  if (kind === 'model') {
    return detail.selected?.model ?? detail.runtimeSelection?.model ?? axis?.currentValue;
  }
  return detail.selected?.effort ?? detail.runtimeSelection?.effort ?? axis?.currentValue;
}

/** The server's own refusal text when it sent one; otherwise the thrown reason. */
/**
 * The soul text this agent is running under: its own if a manager has written
 * one, otherwise the soul seeded from its animal. `defaultAgentPersona` remains
 * the last resort for a stack that does not index a seeded soul.
 */
export function agentSoulCopy(detail: AgentDetailView): string {
  return (
    detail.soul?.instructions ??
    detail.seededSoul ??
    defaultAgentPersona(detail.agent.identity.pubkey).soul
  );
}

/**
 * What the access switch means right now, naming the owner the way the Room's
 * own system lines do — by @handle, never by a display name. This is the ONLY
 * gate before an agent acts on its owner's machine, so the "everyone" state
 * says exactly what that grants, not just who may ask.
 */
function accessCaption(access: AgentDetailView['access'], agentName: string): string {
  const change = 'Only the owner can change this.';
  if (access?.policy === 'everyone')
    return (
      `Anyone in the Room can have ${agentName} run commands, install software and change ` +
      `configuration on your machine. Turn this off and only you may ask them.`
    );
  if (access?.policy === 'allowlist') return `Only allowed members may ask this agent. ${change}`;
  const owner = access?.owner?.handle ? `@${access.owner.handle}` : 'the owner';
  return `Only ${owner} may ask this agent; everyone else is told to ask ${owner} here. ${change}`;
}

/** What yolo means for this agent specifically, and the two things that still ask. */
function yoloCaption(agentName: string, forcedOff = false): string {
  if (forcedOff) return 'Yolo is forced off while this workspace is public.';
  return (
    `${agentName} acts without stopping to ask. Two things still ask you: anything that names ` +
    `one of your credentials, and a script nobody has read.`
  );
}

function yoloSetByLine(yolo: NonNullable<AgentDetailView['yolo']>): string | null {
  if (!yolo.enabled || !yolo.setBy) return null;
  const date =
    yolo.setAt === undefined
      ? null
      : new Date(yolo.setAt * 1000).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });
  return date ? `Set by ${yolo.setBy.name} · ${date}` : `Set by ${yolo.setBy.name}`;
}

/**
 * A model's effort choices can be model-specific. The catalog only proves an
 * effort compatible with its own current model, so a change to any other
 * model must explicitly clear the old human pick. That lets the next cold
 * activation use the target model's native default instead of inheriting an
 * invalid launch argument. This remains provider-neutral: Codex and Claude
 * receive the same safe reset, while re-selecting the catalog's live model
 * keeps its advertised default atomically.
 */
export function modelSelectionInput(
  detail: AgentDetailView,
  axis: AgentModelConfigOption | undefined,
  model: string,
): AgentModelConfigInput {
  if (!axis) {
    return axisValue(detail, 'model', undefined) === model ? { model } : { model, effort: null };
  }
  if (axis.currentValue !== model) return { model, effort: null };
  const effortAxis = effortConfigAxis(detail.catalog);
  const effort = effortAxis?.currentValue;
  return effort && effortAxis.options.some((choice) => choice.id === effort)
    ? { model, effort }
    : { model, effort: null };
}

export default function BuzzMembers({
  profileAgentId,
  workspaceIdOverride,
  profileRoomId,
  onClose,
}: {
  profileAgentId?: string;
  workspaceIdOverride?: string;
  profileRoomId?: string;
  onClose?: () => void;
} = {}) {
  const [
    identity, relayUrl, recordScope, setRosterQuery, workspaceId, focused, setIdentity, setRelayUrl,
    focusedRef, setWorkspaceError, readWorkspaceRef, agentRequestGenerationRef, retryGeneration,
    setSelectedAgent, setEditingAgentSoul, setOpenModelAxis, setModelAppliesNote, setYoloError,
    setAccessError, setLocalAgentId, setError, profileRetryGeneration, surface, setWorking,
    setPickerOpen, setPairCommand, requestedActionHandledRef, requestedAction, memberQuery,
    setRosterLoading, rosterLoading, selectedAgent, ownsSelectedAgent, editingAgentSoul,
    allowProfileNavigationRef, nameDraft, soulDraft, agentNameDraft, agentSoulDraft, navigation,
    pendingConfigWriteRef, applyAgentReceipt, finishConfigWrite, modelAppliesTimerRef,
    setModelAxisError, waitingForEffortCatalogRef, canRemoveSelectedAgent, error, workspaceError,
    working, setRetryGeneration, setProfileRetryGeneration, setAgentNameDraft, setAgentSoulDraft,
    params, openModelAxis, modelSearchQuery, setModelSearchQuery, modelAppliesNote, modelAxisError,
    selectedAgentOwnerByline, theme, accessError, yoloError, insets, rosterQuery, desktop,
    setMemberQuery, pickerOpen, pairCommand,
  ] = useMembersRouteState([
    workspaceIdOverride, profileAgentId,
  ]);

  const [
    writeClient, readMemberPage, applyMemberPage, closeAgentSettings,
  ] = useMembersReads([
    identity, relayUrl, recordScope, setRosterQuery, workspaceId, focused, profileAgentId,
    setIdentity, setRelayUrl, focusedRef, setWorkspaceError, readWorkspaceRef,
    agentRequestGenerationRef, retryGeneration, setSelectedAgent, setEditingAgentSoul,
    setOpenModelAxis, setModelAppliesNote, setYoloError, setAccessError, setLocalAgentId, setError,
    profileRetryGeneration,
  ]);

  const [
    messagePerson, invitePerson, loadMoreMembers, connectAgent, closePicker,
  ] = useMembersMembership([
    surface, workspaceId, relayUrl, setWorking, setError, writeClient, setPickerOpen,
    setSelectedAgent, setPairCommand, focused, requestedActionHandledRef, requestedAction, identity,
    memberQuery, setRosterQuery, setRosterLoading, readMemberPage, applyMemberPage, rosterLoading,
    recordScope,
  ]);

  const [
    closeAgentProfile, messageSelectedAgent, requestSoulAvatar, beginAgentSoulEdit, saveAgentSoul,
  ] = useMembersSoul([
    identity, workspaceId, selectedAgent, ownsSelectedAgent, editingAgentSoul,
    allowProfileNavigationRef, nameDraft, soulDraft, setEditingAgentSoul, agentNameDraft,
    agentSoulDraft, onClose, messagePerson, profileAgentId, navigation, setError, setWorking,
    pendingConfigWriteRef, writeClient, applyAgentReceipt, finishConfigWrite,
  ]);

  const [
    toggleModelAxis, setModelOption, setFastMode, toggleAnswersEveryone, toggleYolo,
    removeSelectedAgent,
  ] = useMembersConfiguration([
    modelAppliesTimerRef, setModelAppliesNote, selectedAgent, ownsSelectedAgent, () => modelAxes,
    setWorking, pendingConfigWriteRef, setError, writeClient, applyAgentReceipt, setOpenModelAxis,
    finishConfigWrite, setModelAxisError, waitingForEffortCatalogRef, setSelectedAgent,
    setYoloError, setAccessError, canRemoveSelectedAgent, workspaceId, recordScope,
    closeAgentSettings, profileAgentId, onClose,
  ]);

  const [
    modelAxes, displayedError, busy, openRosterPerson, openRosterAgent,
  ] = useMembersPresentation([
    selectedAgent, error, workspaceError, working, surface, workspaceId,
  ]);

  if (profileAgentId) {
    return (
      <AgentProfileView
        detail={selectedAgent}
        loading={!selectedAgent && !displayedError}
        error={displayedError}
        onRetry={() => {

          setError(null);
          if (workspaceError) void readWorkspaceRef.current?.();
          setWorkspaceError(null);
          if (!identity || !relayUrl) setRetryGeneration((value) => value + 1);
          else setProfileRetryGeneration((value) => value + 1);
        }}
        onClose={() => void closeAgentProfile()}
        onMessage={() => void messageSelectedAgent()}
        canManage={Boolean(selectedAgent && canRemoveSelectedAgent)}
        canEdit={ownsSelectedAgent}
        avatarDisabled={busy}
        onGenerateAvatar={requestSoulAvatar}
        refreshUsage={async () => {
          const outcome = await monolithPhoneOperation('refreshAgentUsage', {
            workspaceId: selectedAgent!.workspaceId, agentId: profileAgentId,
          }, { timeoutMs: USAGE_REFRESH_CLIENT_TIMEOUT_MS });
          // The canonical usage cell arrives on the existing source feed.
          return outcome;
        }}
        loadMoreWork={async (cursor) => {
          if (!identity || !relayUrl || !workspaceId)
            throw new Error('Workspace connection unavailable');
          return new RoomViewClient({ baseUrl: relayUrl, identity }).agent(
            workspaceId,
            profileAgentId,
            cursor,
          );
        }}
        editing={editingAgentSoul}
        saving={working === 'save-agent-soul'}
        nameDraft={agentNameDraft}
        soulDraft={agentSoulDraft}
        onNameChange={setAgentNameDraft}
        onSoulChange={setAgentSoulDraft}
        onEdit={beginAgentSoulEdit}
        onSave={() => void saveAgentSoul()}
        onCancel={() => setEditingAgentSoul(false)}
        soul={selectedAgent ? agentSoulCopy(selectedAgent) : ''}
        saveWake={async (url, key) => {
          if (!selectedAgent) return;
          const receipt = await monolithPhoneOperation('updateAgentWake', {
            workspaceId: selectedAgent.workspaceId,
            agentId: selectedAgent.agent.identity.pubkey,
            url, ...(key ? { key } : {}),
          });
          applyAgentReceipt(receipt);
        }}
        voiceApi={
          identity && relayUrl && workspaceId
            ? {
                contextKey: `${workspaceId}:${profileRoomId ?? first(params.roomId) ?? ''}:${identity.publicKey}`,
                read: () =>
                  new RoomViewClient({ baseUrl: relayUrl, identity }).agentVoices(
                    workspaceId,
                    profileAgentId,
                    profileRoomId ?? first(params.roomId),
                  ),
                save: (voiceId) =>
                  new RoomViewClient({ baseUrl: relayUrl, identity }).setAgentVoice(
                    workspaceId,
                    profileAgentId,
                    voiceId,
                  ),
                preview: (voiceId) =>
                  new RoomViewClient({ baseUrl: relayUrl, identity }).previewAgentVoice(
                    workspaceId,
                    profileAgentId,
                    voiceId,
                  ),
              }
            : undefined
        }
        voiceRevision={(undefined)}
        modelManagement={
          selectedAgent ? (
            <>
              {ownsSelectedAgent && (
                <View>
                  {(['model', 'effort'] as const).map((kind) => {
                    const axis = kind === 'model' ? modelAxes.model : modelAxes.effort;
                    const current = axisValue(selectedAgent, kind, axis);
                    const open = openModelAxis === kind;
                    const choices = axis?.options ?? [];
                    const visibleChoices =
                      kind === 'model'
                        ? filterAgentModelOptions(choices, modelSearchQuery)
                        : choices;
                    return (
                      <View key={kind}>
                        <SettingsRow
                          title={kind === 'model' ? 'Model' : 'Thinking level'}
                          value={kind === 'model'
                            ? displayModel(modelChoiceLabel(axis, current) ?? '') || UNSET_VALUE
                            : working === 'model-catalog' ? 'Refreshing…' : (current ?? UNSET_VALUE)}
                          disabled={busy || (kind === 'model' && !axis)}
                          onPress={() => void toggleModelAxis(kind, open, axis)}
                          chevron="right"
                          testID={`model-axis-${kind}`}
                        />
                        {(selectedAgent.modelUnavailable === kind ||
                          selectedAgent.modelUnavailable === 'selection') && (
                          <Text
                            accessibilityLabel={`${kind} unavailable`}
                            style={styles.axisValue}
                            testID={`model-unavailable-${kind}`}
                          >
                            !
                          </Text>
                        )}
                        <HullActionSheetModal
                          title={kind === 'model' ? 'Model' : 'Thinking level'}
                          visible={open}
                          onClose={() => setOpenModelAxis(null)}
                          testID={`model-options-${kind}`}
                          sticky={kind === 'model' ? (
                            <HullDialogInput
                              variant="sheetSearch"
                              accessibilityLabel="Search models"
                              autoCapitalize="none"
                              autoCorrect={false}
                              editable={!busy}
                              onChangeText={setModelSearchQuery}
                              placeholder="Search models"
                              returnKeyType="search"
                              testID="model-search-model"
                              value={modelSearchQuery}
                            />
                          ) : undefined}
                          footer={<HullActionSheetCancel onPress={() => setOpenModelAxis(null)} />}
                        >
                          {visibleChoices.map((choice) => (
                            <HullActionSheetRow
                              key={choice.id}
                              disabled={busy}
                              onPress={() => void setModelOption(kind, choice.id)}
                              testID={`model-option-${kind}-${choice.id}`}
                              label={kind === 'model' && axis ? modelPickerChoiceLabel(axis, choice) : (choice.name ?? choice.id)}
                              selected={choice.id === current}
                            />
                          ))}
                        </HullActionSheetModal>
                        {modelAppliesNote === kind && (
                          <Text style={styles.profileSettingCopy} testID={`model-applies-${kind}`}>
                            Applies at the next session
                          </Text>
                        )}
                        {modelAxisError === kind && (
                          <ErrorBanner inline title={(axis
                              ? 'Could not open these choices. Try again.'
                              : 'Could not load effort choices for this model. Make sure the agent is online, then try again or choose another model.')} titleTestID={`model-axis-error-${kind}`} />
                        )}
                      </View>
                    );
                  })}
                  {modelAxes.fast && (
                    <SettingsRow
                      title="Fast mode"
                      description="Faster responses use more ChatGPT credits where available."
                      testID="fast-mode-setting"
                      toggle={{
                        value: selectedAgent.fastMode === true,
                        disabled: busy,
                        onValueChange: (enabled) => void setFastMode(enabled),
                      }}
                    />
                  )}
                </View>
              )}
            </>
          ) : null
        }
        management={
          selectedAgent ? (
            <View
              style={styles.detailPanel}
              testID={`agent-${selectedAgent.agent.identity.pubkey}-model-config`}
            >
              {selectedAgentOwnerByline && (
                <Text style={styles.profileSettingCopy} testID="agent-owner">
                  {selectedAgentOwnerByline}
                </Text>
              )}
              {ownsSelectedAgent && (
                <Text style={styles.profileSettingCopy}>
                  Model, access and Yolo changes apply immediately.
                </Text>
              )}
              {ownsSelectedAgent && (
                <View style={styles.switchSection} testID="agent-access">
                  <View style={styles.switchRow}>
                    <Text style={styles.profileSettingLabel} testID="agent-access-label">
                      Answers everyone
                    </Text>
                    <Switch
                      accessibilityLabel="Answers everyone"
                      disabled={!selectedAgent.access?.canChange || busy}
                      onValueChange={(everyone) => void toggleAnswersEveryone(everyone)}
                      testID="agent-access-switch"
                      thumbColor={theme.buzz.bgBase}
                      {...(Platform.OS === 'web' ? { activeThumbColor: theme.buzz.bgBase } : {})}
                      trackColor={{ false: theme.buzz.bgRaised, true: theme.buzz.accent }}
                      value={selectedAgent.access?.policy === 'everyone'}
                    />
                  </View>
                  <Text style={styles.profileSettingCopy} testID="agent-access-caption">
                    {accessCaption(selectedAgent.access, selectedAgent.agent.identity.name)}
                  </Text>
                  {accessError && (
                    <ErrorBanner inline title={accessError} titleTestID="agent-access-error" />
                  )}
                </View>
              )}
              {ownsSelectedAgent && (
                <View style={styles.switchSection} testID="agent-yolo">
                  <View style={styles.switchRow}>
                    <Text
                      style={[
                        styles.profileSettingLabel,
                        selectedAgent.yolo?.enabled && styles.switchLabelOn,
                      ]}
                      testID="agent-yolo-label"
                    >
                      Yolo
                    </Text>
                    <Switch
                      accessibilityLabel="Yolo"
                      disabled={
                        !selectedAgent.yolo?.canChange || selectedAgent.yolo?.forcedOff || busy
                      }
                      onValueChange={(enabled) => void toggleYolo(enabled)}
                      testID="agent-yolo-switch"
                      thumbColor={theme.buzz.bgBase}
                      {...(Platform.OS === 'web' ? { activeThumbColor: theme.buzz.bgBase } : {})}
                      trackColor={{ false: theme.buzz.bgRaised, true: theme.buzz.accent }}
                      value={selectedAgent.yolo?.enabled ?? false}
                    />
                  </View>
                  <Text style={styles.profileSettingCopy} testID="agent-yolo-caption">
                    {yoloCaption(selectedAgent.agent.identity.name, selectedAgent.yolo?.forcedOff)}
                  </Text>
                  {selectedAgent.yolo && yoloSetByLine(selectedAgent.yolo) && (
                    <Text style={styles.profileSettingCopy} testID="agent-yolo-set-by">
                      {yoloSetByLine(selectedAgent.yolo)}
                    </Text>
                  )}
                  {yoloError && (
                    <ErrorBanner inline title={yoloError} titleTestID="agent-yolo-error" />
                  )}
                </View>
              )}
              {canRemoveSelectedAgent && (
                <Button
                  accessibilityLabel="Remove from Workspace"
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void removeSelectedAgent()}
                  testID="remove-agent"
                  label={working === 'remove-agent' ? 'Removing…' : 'Remove from Workspace'}
                  variant="danger"
                  fullWidth
                  appearance={{ control: styles.removeAgentControl, label: styles.removeAgentText }}
                />
              )}
            </View>
          ) : null
        }
      />
    );
  }

  if (!surface && !displayedError) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <SurfaceGlyphLoader testID="members-loader" />
        <Text style={styles.loadingText}>Loading {MEMBERS_LABEL.toLowerCase()}…</Text>
      </View>
    );
  }
  if (!surface) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <SettingsRow title={displayedError!}  action="Retry" onPress={() => {setRetryGeneration((value) => value + 1);}} />
      </View>
    );
  }

  const canManage = surface.viewer.permissions.manage;
  const page = workspacePage(recordScope, rosterQuery);
  const people = (workspaceRows<WorkspaceView['members'][number]>(
    recordScope,
    page.people?.ids ?? [],
  ));
  const agents = (workspaceRows<WorkspaceView['agents'][number]>(
    recordScope,
    page.agents?.ids ?? [],
  ));
  const peopleTotal = (page.people?.total);
  const agentTotal = (page.agents?.total);
  const canLoadMorePeople = ((Boolean(page.people?.truncated))) && !rosterLoading;
  const canLoadMoreAgents = ((Boolean(page.agents?.truncated))) && !rosterLoading;

  const personRow = (member: (typeof people)[number]) => {
    return (
      <View key={member.identity.pubkey}>
        <MemberRosterRow
          avatarUrl={member.identity.avatar}
          disabled={busy}
          divider="bottom"
          face={member.identity.face}
          handle={member.identity.handle}
          kind="human"
          name={member.identity.name}
          onPress={openRosterPerson}
          pubkey={member.identity.pubkey}
          chevron="right"
          role={member.role}
          testID={`member-${member.identity.pubkey}-identity`}
        />
      </View>
    );
  };

  return (
    <BuzzCommunityShell
      communities={[workspaceRailItem(surface.workspace)]}
      activeCommunityId={surface.workspace.id}
      onSelect={(communityId) =>
        communityId &&
        router.replace({ pathname: '/beeline/channels', params: { communityId } } as never)
      }
      onAdd={() => router.push('/beeline/community' as Href)}
      onSettings={() => router.push('/beeline/settings' as Href)}
      viewerPubkey={surface.viewer.identity.pubkey}
      viewerAvatarUrl={surface.viewer.identity.avatar}
      viewerFace={surface.viewer.identity.face}
    >
      <View
        style={[styles.container, { paddingTop: insets.top }]}
        testID="workspace-members-surface"
      >
        <PageHeader
          eyebrow={surface.workspace.name}
          onBack={() => router.back()}
          prominent
          testID="members-header"
          title={MEMBERS_LABEL}
          titleTestID="members-title"
        />
        {!!displayedError && (
          <SettingsRow title={displayedError!}  action="Retry" onPress={() => { setError(null); void readWorkspaceRef.current?.(); }} />
        )}
        <KeyboardAwareScrollView
          bottomOffset={16}
          contentContainerStyle={[
            styles.content,
            desktop && styles.desktopColumn,
            { paddingBottom: theme.buzz.space.xxl + insets.bottom },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <HullDialogInput
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            onChangeText={setMemberQuery}
            onSubmitEditing={()=>{}}
            placeholder="Search members"
            placeholderTextColor={theme.buzz.textMuted}
            returnKeyType="search"
            variant="search"
            testID="members-search"
            value={memberQuery}
          />
          <View style={styles.section} testID="members-people-section">
            <RoomListSectionHeader
              title="People" inset="content" spacing="flush"
              count={peopleTotal}
              testID="members-people-head"
              actionAccessibilityLabel="Add people"
              actionTestID="members-add-people"
              actionDisabled={busy}
              onAction={
                canManage
                  ? () => {
                    setError(null);
                    void invitePerson();
                  }
                  : undefined
              }
            />
            {people.map((member) => personRow(member))}
            {canLoadMorePeople && (
              <Button
                accessibilityRole="button"
                disabled={busy || rosterLoading}
                onPress={() => void loadMoreMembers('human')}
                testID="members-load-more-people"
                label={rosterLoading ? 'Loading…' : 'Show more'}
                variant="quiet"
                appearance={{ control: styles.loadMore, label: styles.loadMoreText }}
              />
            )}
          </View>
          <View style={styles.section} testID="members-agents-section">
            <RoomListSectionHeader
              title="Agents" inset="content" spacing="flush"
              count={agentTotal}
              testID="members-agents-head"
              actionAccessibilityLabel="Add agents"
              actionTestID="members-add-agents"
              actionDisabled={busy}
              onAction={() => void connectAgent()}
            />
            {agents.map((member) => {
              return (
                <View key={member.identity.pubkey}>
                  <MemberRosterRow
                    avatarUrl={member.identity.avatar}
                    chevron="right"
                    disabled={busy}
                    divider="bottom"
                    face={member.identity.face}
                    handle={member.identity.handle}
                    kind="agent"
                    model={member.model}
                    usage={member.usage}
                    name={member.identity.name}
                    onPress={openRosterAgent}
                    ownerHandle={member.owner?.handle}
                    pubkey={member.identity.pubkey}
                    testID={`agent-${member.identity.pubkey}-identity`}
                  />
                </View>
              );
            })}
            {canLoadMoreAgents && (
              <Button
                accessibilityRole="button"
                disabled={busy || rosterLoading}
                onPress={() => void loadMoreMembers('agent')}
                testID="members-load-more-agents"
                label={rosterLoading ? 'Loading…' : 'Show more'}
                variant="quiet"
                appearance={{ control: styles.loadMore, label: styles.loadMoreText }}
              />
            )}
          </View>
        </KeyboardAwareScrollView>
        <MemberPickerSheet
          agentConnectOnly
          busy={working === 'invite-person' || working === 'pair-agent'}
          canManage={canManage}
          canConnectAgent
          candidates={undefined}
          error={pickerOpen ? error : null}
          onAdd={() => undefined}
          onClose={closePicker}
          onConnectAgent={() => void connectAgent()}
          onCopyPairCommand={(command) => copyText(command)}
          onInvitePerson={() => void invitePerson()}
          pairCommand={pairCommand}
          visible={pickerOpen}
        />
      </View>
    </BuzzCommunityShell>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    center: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: hull.space.md,
      paddingHorizontal: hull.space.lg,
    },
    loadingText: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    desktopColumn: { width: '100%', maxWidth: desktopColumnWidths.detail, alignSelf: 'center' },
    content: {
      padding: hull.space.md,
      gap: hull.layout.sectionGap,
      paddingBottom: hull.space.xxl,
    },
    section: {},
    loadMore: { minHeight: 44, justifyContent: 'center', paddingHorizontal: hull.space.sm },
    loadMoreText: { ...Typography.default(), ...hull.type.body, color: hull.accent },
    detail: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    profileSettingLabel: {
      ...Typography.default(),
      ...hull.type.bodyStrong,
      color: hull.textPrimary,
    },
    profileSettingCopy: { ...Typography.default(), ...hull.type.meta, color: hull.ledgerQuiet },
    detailPanel: { padding: hull.space.md, gap: hull.space.md },
    axisRow: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
      paddingHorizontal: hull.space.sm,
    },
    axisLabel: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted, width: 54 },
    axisValue: {
      ...Typography.default(),
      ...hull.type.body,
      color: hull.textPrimary,
      flex: 1,
      minWidth: 0,
      textAlign: 'right',
    },
    switchSection: { gap: hull.space.xs },
    switchRow: {
      minHeight: 40,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: hull.space.sm,
    },
    switchLabelOn: { color: hull.accent },
    // The destructive action is a full 44pt target below configuration. The
    // red is the border: `dialogDanger` clears the 3:1 non-text floor on both
    // canvases, where the same value as small ink would sit at 4.36:1 on
    // Obsidian and 3.81:1 on Bone — under the 4.5:1 text floor. The word
    // carries the meaning either way, so the label takes the primary ink.
    removeAgentControl: {
      minHeight: 44,
      justifyContent: 'center',
      paddingHorizontal: hull.space.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.dialogDanger,
      borderRadius: hull.radius,
    },
    removeAgentText: {
      ...Typography.default(),
      ...hull.type.body,
      color: hull.textPrimary,
      textAlign: 'center',
    },
  choiceDisabled: { opacity: 0.35 },
};
});
