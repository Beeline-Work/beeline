import React, { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AGENT_NAME_MAX_LENGTH, type AgentDetailView } from '@beeline/buzz-client';
import { IdentityMark } from './IdentityMark';
import { ChevronGlyph } from './ChevronGlyph';
import { MonoButton } from './MonoHull';
import { SurfaceGlyphLoader } from './SurfaceGlyphLoader';
import { SettingsRow } from './SettingsRow';
import { Typography } from '@/constants/Typography';
import { SoulPortraitControls } from './SoulPortraitControls';

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
}) {
  const insets = useSafeAreaInsets();
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
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close profile"
          onPress={onClose}
          style={styles.close}
          testID="close-agent-profile"
        >
          <ChevronGlyph direction="left" size={22} color={styles.accent.color} />
        </Pressable>
        <Text style={styles.heading}>Profile</Text>
        <View style={styles.headerActions}>
          {canEdit &&
            (editing ? (
              <>
                <MonoButton
                  label="Cancel"
                  disabled={saving}
                  onPress={onCancel}
                  testID="cancel-agent-edit"
                  variant="secondary"
                />
                <MonoButton
                  label={saving ? 'Saving' : 'Save'}
                  loading={saving}
                  disabled={saving}
                  onPress={onSave}
                  testID="save-agent-soul"
                />
              </>
            ) : (
              <MonoButton
                label="Edit"
                onPress={onEdit}
                testID="edit-agent-soul"
                variant="secondary"
              />
            ))}
        </View>
      </View>
      <KeyboardAwareScrollView contentContainerStyle={styles.content}>
        {loading && <SurfaceGlyphLoader testID="agent-profile-loader" />}
        {error && (
          <View style={styles.section}>
            <Text style={styles.copy} accessibilityRole="alert">
              {error}
            </Text>
            <MonoButton label="Retry" onPress={onRetry} />
          </View>
        )}
        {identity && (
          <>
            <View style={styles.identity}>
              <IdentityMark
                kind="agent"
                seed={identity.pubkey}
                name={identity.name}
                face={identity.face}
                avatarUrl={identity.avatar}
                size={72}
              />
              {editing ? (
                <TextInput
                  accessibilityLabel="Agent name"
                  editable={!saving}
                  maxLength={AGENT_NAME_MAX_LENGTH}
                  onChangeText={onNameChange}
                  style={styles.nameInput}
                  testID="agent-soul-name"
                  value={nameDraft}
                />
              ) : (
                <Text style={styles.name}>{identity.name}</Text>
              )}
              {identity.handle && (
                <Text style={styles.copy} testID="agent-handle">{`@${identity.handle}`}</Text>
              )}
              <Pressable
                accessibilityRole="button"
                onPress={onMessage}
                style={({ pressed }) => [styles.message, pressed && styles.pressed]}
                testID="agent-profile-message"
              >
                <Text style={styles.accent}>Message</Text>
              </Pressable>
            </View>
            <SettingsRow title="Model" value={label(model, modelAxis)} />
            <SettingsRow title="Effort" value={label(effort, effortAxis)} />
            {detail.owner && <SettingsRow title="Owner" value={detail.owner.name} />}
            <View style={styles.section}>
              <Text style={styles.strong}>Soul</Text>
              {editing ? (
                <TextInput
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
                  style={styles.copy}
                  testID="agent-profile-soul"
                >
                  {soul || 'No soul has been set.'}
                </Text>
              )}
              {soul && !editing && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  onPress={() => setExpanded((value) => !value)}
                  style={styles.readMore}
                >
                  <Text style={styles.accent}>{expanded ? 'Show less' : 'Read full soul'}</Text>
                </Pressable>
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
            {canManage && (editing || !canEdit) && management}
            <View style={styles.section}>
              <View style={styles.workHeading}>
                <Text style={styles.strong}>Recent work</Text>
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
                <Text style={styles.copy} testID="agent-profile-no-work">
                  No merged work to show yet.
                </Text>
              )}
              {cursor && loadMoreWork && (
                <MonoButton
                  label={workLoading ? 'Loading…' : workError ? 'Retry recent work' : 'Show more'}
                  loading={workLoading}
                  disabled={workLoading}
                  onPress={() => void moreWork()}
                  variant="secondary"
                  testID="load-more-agent-work"
                />
              )}
              {workError && (
                <Text style={styles.copy} accessibilityRole="alert">
                  Could not load older work. Your current list is still available.
                </Text>
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
  header: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  close: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  heading: {
    ...Typography.default(),
    ...theme.buzz.type.bodyStrong,
    color: theme.buzz.textPrimary,
    flex: 1,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 16 },
  content: { paddingHorizontal: theme.buzz.space.md, paddingBottom: theme.buzz.space.xxl },
  identity: {
    paddingVertical: theme.buzz.space.lg,
    alignItems: 'center',
    gap: theme.buzz.space.md,
  },
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
    padding: 12,
  },
  placeholder: { color: theme.buzz.textMuted },
  message: {
    minHeight: 44,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: theme.buzz.accent,
    borderRadius: theme.buzz.radius,
    justifyContent: 'center',
  },
  pressed: { backgroundColor: theme.buzz.bgPressed },
  copy: { ...Typography.default(), ...theme.buzz.type.body, color: theme.buzz.textSecondary },
  meta: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  strong: { ...Typography.default(), ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  accent: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.accent },
  section: { paddingTop: theme.buzz.space.md, gap: theme.buzz.space.md },
  readMore: { minHeight: 44, justifyContent: 'center' },
  workHeading: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
}));
