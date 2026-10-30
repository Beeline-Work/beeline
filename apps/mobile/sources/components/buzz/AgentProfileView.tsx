import { appErrorCopy } from '@/buzz/app-error-copy';
import { InlineActionRow } from './IndexRow';
import { ErrorBanner } from './ErrorBanner';
import { AgentUsageSection } from './AgentUsageSection';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { HullDialogActions, HullDialogInput } from '@/components/buzz/HullDialog';
import React, { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AGENT_NAME_MAX_LENGTH, type AgentDetailView } from '@beeline/buzz-client';
import { ProfileIdentity } from './ProfileIdentity';
import { Button } from './Button';
import { ButtonRow } from './ButtonRow';
import { SurfaceGlyphLoader } from './SurfaceGlyphLoader';
import { SettingsRow } from './SettingsRow';
import { PageHeader } from './PageHeader';
import { ProfileActions } from './ProfileActions';
import { Typography } from '@/constants/Typography';
import { SoulPortraitControls } from './SoulPortraitControls';
import { AgentVoiceSection, type AgentVoiceApi } from './AgentVoiceSection';
import { displayModel } from '@/buzz/model-display';
import { modelChoiceLabel } from '@beeline/api-contract/phone';

export function AgentProfileView({
  detail,
  loading,
  error,
  onRetry,
  onClose,
  onMessage,
  canManage,
  canEdit,
  avatarDisabled,
  onGenerateAvatar,
  refreshAgent,
  refreshUsage,
  loadMoreWork,
  editing,
  saving,
  nameDraft,
  soulDraft,
  onNameChange,
  onSoulChange,
  onEdit,
  onSave,
  onCancel,
  soul,
  management,
  modelManagement,
  voiceApi,
  saveWake,
}: {
  detail: AgentDetailView | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
  onMessage: () => void;
  canManage: boolean;
  canEdit: boolean;
  avatarDisabled: boolean;
  onGenerateAvatar: (soul: string) => Promise<void>;
  refreshAgent: () => Promise<AgentDetailView>;
  refreshUsage?: () => Promise<unknown>;
  loadMoreWork?: (cursor: string) => Promise<AgentDetailView>;
  editing: boolean;
  saving: boolean;
  nameDraft: string;
  soulDraft: string;
  onNameChange: (value: string) => void;
  onSoulChange: (value: string) => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  soul: string;
  management: React.ReactNode;
  modelManagement?: React.ReactNode;
  voiceApi?: AgentVoiceApi;
  saveWake?: (url: string, key?: string) => Promise<void>;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [wakeOpen, setWakeOpen] = useState(false);
  const [wakeUrl, setWakeUrl] = useState('');
  const [wakeKey, setWakeKey] = useState('');
  const [wakeSaving, setWakeSaving] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const updateWake = async (clear = false) => {
    if (!saveWake || wakeSaving) return;
    setWakeSaving(true);
    setWakeError(null);
    try {
      await saveWake(clear ? '' : wakeUrl, clear ? undefined : wakeKey || undefined);
      setWakeKey('');
      setWakeOpen(false);
    } catch (error) {
      setWakeKey('');
      setWakeError(appErrorCopy(error));
    } finally {
      setWakeSaving(false);
    }
  };
  const [expanded, setExpanded] = useState(false);
  const [linkError, setLinkError] = useState(false);
  const [olderWork, setOlderWork] = useState<NonNullable<AgentDetailView['recentWork']>>([]);
  const [nextCursor, setNextCursor] = useState<string | null | undefined>();
  const [workLoading, setWorkLoading] = useState(false);
  const [workError, setWorkError] = useState(false);
  const workRequest = useRef(0);
  const workBusy = useRef(false);
  const identity = detail?.agent.identity;
  useEffect(() => {
    setWakeKey('');
    setWakeOpen(false);
    setWakeError(null);
    workRequest.current += 1;
    workBusy.current = false;
    setOlderWork([]);
    setNextCursor(undefined);
    setWorkError(false);
    setWorkLoading(false);
    return () => {
      workRequest.current += 1;
    };
  }, [identity?.pubkey]);
  const cursor = nextCursor === undefined ? detail?.recentWorkCursor : nextCursor;
  const allWork = [
    ...new Map(
      [...(detail?.recentWork ?? []), ...olderWork].map((work) => [work.url, work]),
    ).values(),
  ];
  const moreWork = async () => {
    if (!cursor || !loadMoreWork || workBusy.current) return;
    const request = workRequest.current;
    workBusy.current = true;
    setWorkLoading(true);
    setWorkError(false);
    try {
      const page = await loadMoreWork(cursor);
      if (request !== workRequest.current) return;
      setOlderWork((current) => [...current, ...(page.recentWork ?? [])]);
      setNextCursor(page.recentWorkCursor ?? null);
    } catch {
      if (request === workRequest.current) setWorkError(true);
    } finally {
      if (request === workRequest.current) {
        workBusy.current = false;
        setWorkLoading(false);
      }
    }
  };
  const modelAxis = detail?.catalog.find((axis) => axis.category === 'model');
  const effortAxis = detail?.catalog.find(
    (axis) => axis.category === 'thought_level' || axis.category === 'reasoning_effort',
  );
  const model =
    detail?.selected?.model ?? detail?.runtimeSelection?.model ?? modelAxis?.currentValue;
  const effort =
    detail?.selected?.effort ?? detail?.runtimeSelection?.effort ?? effortAxis?.currentValue;
  const label = (value: string | undefined, axis: typeof modelAxis) =>
    axis?.options.find((option) => option.id === value)?.name ?? value ?? 'Not available';
  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="agent-profile">
      <PageHeader
        backAccessibilityLabel="Close profile"
        backTestID="close-agent-profile"
        onBack={onClose}
        prominent
        testID="agent-profile-header"
        title="Profile"
      />
      <KeyboardAwareScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: theme.buzz.space.xxl + insets.bottom },
        ]}
        testID="agent-profile-scroll"
      >
        {loading && <SurfaceGlyphLoader testID="agent-profile-loader" />}
        {error && (
          <View style={styles.section}>
            <Text style={styles.copy} accessibilityRole="alert">
              {error}
            </Text>
            <Button size="inline" label="Retry" onPress={onRetry} variant="secondary" />
          </View>
        )}
        {identity && (
          <>
            <ProfileIdentity
              identity={identity}
              ownerHandle={detail.owner?.handle}
              actions={
                <ProfileActions
                  actions={[
                    {
                      label: 'Message',
                      onPress: onMessage,
                      testID: 'agent-profile-message',
                    },
                    ...(canEdit && !editing
                      ? [{ label: 'Edit', onPress: onEdit, testID: 'edit-agent-soul' }]
                      : []),
                  ]}
                />
              }
            />
            {editing && (
              <HullDialogInput
                accessibilityLabel="Agent name"
                editable={!saving}
                maxLength={AGENT_NAME_MAX_LENGTH}
                onChangeText={onNameChange}
                style={styles.nameInput}
                testID="agent-soul-name"
                value={nameDraft}
              />
            )}
            <View style={styles.section}>
              <RoomListSectionHeader title="SOUL" inset="row" spacing="flush" />
              {editing ? (
                <HullDialogInput
                  accessibilityLabel="Persona / instructions"
                  editable={!saving}
                  maxLength={1000}
                  multiline
                  onChangeText={onSoulChange}
                  placeholder="How this agent should work"
                  placeholderTextColor={styles.placeholder.color}
                  style={styles.soulInput}
                  testID="agent-soul-instructions"
                  value={soulDraft}
                />
              ) : (
                <Text
                  numberOfLines={expanded ? undefined : 5}
                  style={[styles.copy, styles.rowCopy]}
                  testID="agent-profile-soul"
                >
                  {soul || 'No soul has been set.'}
                </Text>
              )}
              {(soul && !editing) || (canEdit && detail) ? (
                <View style={styles.soulActions}>
                  {soul && !editing && (
                    <Button
                      accessibilityRole="button"
                      accessibilityState={{ expanded }}
                      onPress={() => setExpanded((value) => !value)}
                      label={expanded ? 'Show less' : 'Read full soul'}
                      variant="quiet"
                      appearance={{ control: styles.readMore, label: styles.accent }}
                    />
                  )}
                  {canEdit && detail && (
                    <SoulPortraitControls
                      key={identity.pubkey}
                      detail={detail}
                      soul={editing ? soulDraft : soul}
                      disabled={avatarDisabled}
                      generate={onGenerateAvatar}
                      refresh={refreshAgent}
                    />
                  )}
                </View>
              ) : null}
            </View>
            {canEdit && editing && (
              <View style={styles.confirmRow}>
                <HullDialogActions
                  actions={[
                    {
                      label: 'Cancel',
                      variant: 'quiet',
                      disabled: saving,
                      onPress: onCancel,
                      testID: 'cancel-agent-edit',
                    },
                    {
                      label: saving ? 'Saving…' : 'Save',
                      variant: 'primary',
                      loading: saving,
                      disabled: saving,
                      onPress: onSave,
                      testID: 'save-agent-soul',
                    },
                  ]}
                />
              </View>
            )}
            {detail.wake && (
              <View style={styles.section}>
                <SettingsRow
                  title="Webhook URL"
                  description={wakeError ?? detail.wake.url ?? 'For bots that only run when called.'}
                  descriptionTone={wakeError ? 'danger' : undefined}
                  descriptionDetail={detail.wake.keySet ? 'Auth token: set' : 'Auth token: not set'}
                  actionControl={{
                    label: detail.wake.url ? 'Replace' : 'Set', disabled: wakeSaving,
                    onPress: () => { setWakeUrl(detail.wake?.url ?? ''); setWakeKey(''); setWakeOpen(true); },
                  }}
                />
                {wakeOpen && (
                  <>
                    <HullDialogInput accessibilityLabel="Webhook URL" value={wakeUrl}
                      onChangeText={setWakeUrl} autoCapitalize="none" autoCorrect={false}
                      keyboardType="url" maxLength={2048} editable={!wakeSaving} />
                    <HullDialogInput accessibilityLabel="Auth token" value={wakeKey}
                      onChangeText={setWakeKey} secureTextEntry autoCapitalize="none" autoCorrect={false}
                      autoComplete="off" placeholder={detail.wake.keySet ? 'Set — enter a replacement' : 'Not set'}
                      maxLength={512} editable={!wakeSaving} />
                    <ButtonRow actions={[
                      { label: 'Cancel', variant: 'quiet', disabled: wakeSaving,
                        onPress: () => { setWakeKey(''); setWakeOpen(false); } },
                      { label: wakeSaving ? 'Saving…' : 'Save', disabled: wakeSaving || !wakeUrl.trim() || Boolean(detail.wake?.keySet && !wakeKey),
                        onPress: () => void updateWake() },
                    ]} />
                  </>
                )}
                {detail.wake.url && (
                  <Button size="inline" label="Clear webhook" variant="quiet" disabled={wakeSaving}
                    onPress={() => void updateWake(true)} />
                )}
              </View>
            )}
            <View style={styles.section}>
              <RoomListSectionHeader title="Model / difficulty" inset="row" spacing="flush" />
              {editing && canEdit && modelManagement ? (
                modelManagement
              ) : (
                <>
                  <SettingsRow
                    title="Model"
                    description={model ? displayModel(modelChoiceLabel(modelAxis, model) ?? '') || undefined : 'Not available'}
                  />
                  <SettingsRow title="Thinking level" value={label(effort, effortAxis)} />
                </>
              )}
            </View>
            {canEdit ? <AgentUsageSection key={detail.agent.identity.pubkey} usage={detail.usage} harness={detail.harness} onRefresh={refreshUsage} /> : null}
            <AgentVoiceSection
              key={`${detail.workspaceId}:${identity.pubkey}:${voiceApi?.contextKey ?? ''}`}
              agentId={identity.pubkey}
              configVersion={detail.configVersion}
              handle={identity.handle ?? identity.name}
              canEdit={canEdit}
              api={voiceApi}
            />
            <View style={styles.section}>
              <RoomListSectionHeader title="Access" inset="row" spacing="flush" />
              <SettingsRow
                title="Permission mode"
                value={detail.yolo?.enabled ? 'Yolo' : 'Ask first'}
              />
              <SettingsRow
                title="Answer scope"
                value={detail.access?.policy === 'everyone' ? 'Everyone' : 'Owner only'}
              />
            </View>
            {canManage && (editing || !canEdit) && management}
            <View style={styles.section}>
              <View style={styles.workHeading}>
                <View style={styles.workTitle}>
                  <RoomListSectionHeader title="Recent work" inset="row" spacing="flush" />
                </View>
                <Text style={styles.meta}>Merged PRs</Text>
              </View>
              {allWork.length ? (
                allWork.map((work) => (
                  <SettingsRow
                    key={work.url}
                    title={work.title}
                    description="Merged pull request"
                    accessibilityRole="link"
                    accessibilityLabel={work.title}
                    chevron="right"
                    onPress={() => {
                      setLinkError(false);
                      void Linking.openURL(work.url).catch(() => setLinkError(true));
                    }}
                  />
                ))
              ) : (
                <Text style={[styles.copy, styles.rowCopy]} testID="agent-profile-no-work">
                  No merged work to show yet.
                </Text>
              )}
              {cursor && loadMoreWork && !workError && (
                <InlineActionRow><Button
                  size="inline"

                  label={workLoading ? 'Loading…' : 'More'}
                  loading={workLoading}
                  disabled={workLoading}
                  onPress={() => void moreWork()}
                  variant="secondary"
                  testID="load-more-agent-work"
                /></InlineActionRow>
              )}
              {workError && (
                <ErrorBanner inline title="Could not load older work. Your current list is still available." onRetry={() => void moreWork()} retrying={workLoading} retryTestID="load-more-agent-work" />
              )}
              {linkError && (
                <Text style={styles.copy} accessibilityRole="alert">
                  Could not open this pull request. Select it to retry.
                </Text>
              )}
            </View>
          </>
        )}
      </KeyboardAwareScrollView>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minWidth: 0, backgroundColor: theme.buzz.bgBase },
  content: { paddingHorizontal: theme.buzz.space.md, paddingBottom: theme.buzz.space.xxl },
  name: {
    ...Typography.default(),
    ...theme.buzz.type.hero,
    color: theme.buzz.textPrimary,
    textAlign: 'center',
  },
  nameInput: {
    ...Typography.default(),
    ...theme.buzz.type.bodyStrong,
    color: theme.buzz.textPrimary,
    minWidth: 200,
    minHeight: 44,
    textAlign: 'center',
    borderBottomWidth: 1,
    borderBottomColor: theme.buzz.accent,
  },
  soulInput: {
    ...Typography.default(),
    ...theme.buzz.type.body,
    color: theme.buzz.textPrimary,
    minHeight: 120,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: theme.buzz.border,
    borderRadius: theme.buzz.radius,
    padding: theme.buzz.space.md,
  },
  placeholder: { color: theme.buzz.textMuted },
  copy: { ...Typography.default(), ...theme.buzz.type.body, color: theme.buzz.textSecondary },
  // Soul and empty-work text start on the same edge as the section headers and row titles.
  rowCopy: { paddingHorizontal: theme.buzz.space.sm },
  meta: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  accent: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.accent },
  section: { paddingTop: theme.buzz.space.lg, gap: theme.buzz.space.xs },
  readMore: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: theme.buzz.space.sm,
  },
  soulActions: { gap: 0 },
  confirmRow: { paddingTop: theme.buzz.space.md },
  workHeading: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
    paddingRight: theme.buzz.space.sm,
  },
  workTitle: { flex: 1 },
  identity: {
    paddingVertical: theme.buzz.space.lg,
    alignItems: 'center',
    gap: theme.buzz.space.md,
  },
  message: {
    minHeight: 44,
    paddingHorizontal: 24,
    paddingVertical: theme.buzz.space.sm,
    borderWidth: 1,
    borderColor: theme.buzz.accent,
    borderRadius: theme.buzz.radius,
    justifyContent: 'center',
  },
  pressed: { backgroundColor: theme.buzz.bgPressed },
  strong: { ...Typography.default(), ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
}));
