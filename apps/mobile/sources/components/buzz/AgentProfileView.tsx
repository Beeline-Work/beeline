import React, { useState } from 'react';
import { Linking, Pressable, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AGENT_NAME_MAX_LENGTH, type AgentDetailView } from '@beeline/buzz-client';
import { IdentityMark } from './IdentityMark';
import { ChevronGlyph } from './ChevronGlyph';
import { MonoButton } from './MonoHull';
import { SurfaceGlyphLoader } from './SurfaceGlyphLoader';
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
  onGenerateAvatar: (soul: string, direction?: string) => Promise<void>;
  refreshAgent: () => Promise<AgentDetailView>;
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
  const identity = detail?.agent.identity;
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
            <View style={styles.facts}>
              <View style={styles.fact}>
                <Text style={styles.meta}>Model</Text>
                <Text style={styles.copy}>{label(model, modelAxis)}</Text>
              </View>
              <View style={styles.fact}>
                <Text style={styles.meta}>Effort</Text>
                <Text style={styles.copy}>{label(effort, effortAxis)}</Text>
              </View>
            </View>
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
              {detail.recentWork?.length ? (
                detail.recentWork.map((work) => (
                  <Pressable
                    key={work.url}
                    accessibilityRole="link"
                    accessibilityLabel={work.title}
                    onPress={() => {
                      setLinkError(false);
                      void Linking.openURL(work.url).catch(() => setLinkError(true));
                    }}
                    style={styles.work}
                  >
                    <Text style={[styles.copy, styles.workTitle]}>{work.title}</Text>
                    <ChevronGlyph direction="right" size={18} color={styles.accent.color} />
                  </Pressable>
                ))
              ) : (
                <Text style={styles.copy} testID="agent-profile-no-work">
                  No merged work to show yet.
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
  heading: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary, flex: 1 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 16 },
  content: { paddingBottom: 32 },
  identity: { padding: 24, alignItems: 'center', gap: 16 },
  name: {
    ...theme.buzz.type.bodyStrong,
    ...theme.buzz.agentProfileTypography.name,
    color: theme.buzz.textPrimary,
    textAlign: 'center',
  },
  nameInput: {
    ...theme.buzz.type.bodyStrong,
    color: theme.buzz.textPrimary,
    minWidth: 200,
    minHeight: 44,
    textAlign: 'center',
    borderBottomWidth: 1,
    borderBottomColor: theme.buzz.accent,
  },
  soulInput: {
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
  facts: {
    marginHorizontal: 24,
    paddingVertical: 18,
    flexDirection: 'row',
    gap: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: theme.buzz.border,
  },
  fact: { flex: 1, gap: 6 },
  copy: { ...theme.buzz.type.body, color: theme.buzz.textSecondary },
  meta: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  strong: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  accent: { ...theme.buzz.type.meta, color: theme.buzz.accent },
  section: { paddingHorizontal: 24, paddingTop: 24, gap: 12 },
  readMore: { minHeight: 44, justifyContent: 'center' },
  workHeading: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  work: {
    minHeight: 52,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  workTitle: { flex: 1 },
}));
