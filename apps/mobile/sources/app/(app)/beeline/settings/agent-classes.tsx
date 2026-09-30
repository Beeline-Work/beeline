import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  AGENT_TIERS,
  GOD_MIN_OUTPUT_USD,
  HEAVY_MIN_OUTPUT_USD,
  type AgentTier,
  type WorkspaceAgentClassesView,
} from '@beeline/api-contract/phone';
import { AgentTagChips, agentTierSource } from '@/components/buzz/AgentTagChips';
import { MonoButton } from '@/components/buzz/MonoHull';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { Typography } from '@/constants/Typography';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const FETCHED = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function TierPicker({
  value,
  onChange,
  disabled,
  testID,
}: {
  value?: AgentTier;
  onChange: (tier: AgentTier) => void;
  disabled?: boolean;
  testID: string;
}) {
  return (
    <View accessibilityRole="radiogroup" style={styles.segment} testID={testID}>
      {AGENT_TIERS.map((tier) => (
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ selected: value === tier, disabled }}
          disabled={disabled}
          key={tier}
          onPress={() => onChange(tier)}
          style={[styles.segmentOption, value === tier && styles.segmentOn]}
          testID={`${testID}-${tier}`}
        >
          <Text style={[styles.segmentLabel, value === tier && styles.segmentLabelOn]}>{tier}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Workspace settings → Agent classes. Workspace admins add and remove custom
 * tags, pin a tier for a model or family (an override always wins over the
 * registry price), and resolve models models.dev does not list yet. Automatic
 * tags are shown locked; nothing here can remove them.
 */
export default function AgentClassesSettings() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ communityId?: string | string[] }>();
  const workspaceId = first(params.communityId);
  const [view, setView] = useState<WorkspaceAgentClassesView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({});
  const [pinScope, setPinScope] = useState<'model' | 'family'>('model');
  const [pinKey, setPinKey] = useState('');
  const [pinTier, setPinTier] = useState<AgentTier>('heavy');

  const reload = useCallback(async () => {
    if (!workspaceId) {
      setError(`${WORKSPACE_LABEL} target is missing.`);
      setLoading(false);
      return;
    }
    try {
      setView(await monolithPhoneOperation('readWorkspaceAgentClasses', { workspaceId }));
      setError(null);
    } catch (caught) {
      setError(`Could not load agent classes: ${String(caught)}`);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void reload();
    }, [reload]),
  );

  const mutate = useCallback(
    async (key: string, work: () => Promise<unknown>) => {
      if (working) return;
      setWorking(key);
      setError(null);
      try {
        await work();
        await reload();
      } catch (caught) {
        setError(String(caught));
      } finally {
        setWorking(null);
      }
    },
    [reload, working],
  );

  const setTag = (agentId: string, tag: string, present: boolean) =>
    workspaceId
      ? mutate(`tag-${agentId}`, async () => {
          await monolithPhoneOperation('setAgentCustomTag', { workspaceId, agentId, tag, present });
          if (present) setTagDrafts((drafts) => ({ ...drafts, [agentId]: '' }));
        })
      : undefined;

  const setOverride = (scope: 'model' | 'family', key: string, tier: AgentTier | null) =>
    workspaceId
      ? mutate(`override-${scope}-${key}`, async () => {
          await monolithPhoneOperation('setModelTierOverride', { workspaceId, scope, key, tier });
          if (tier && key === pinKey.trim().toLowerCase()) setPinKey('');
        })
      : undefined;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="agent-classes-settings">
      <PageHeader eyebrow={WORKSPACE_LABEL} onBack={() => router.back()} title="Agent classes" />
      {loading ? (
        <View style={styles.center}>
          <SurfaceGlyphLoader testID="agent-classes-loader" />
        </View>
      ) : !view ? (
        <View style={styles.center} testID="agent-classes-denied">
          <Text style={styles.title}>Admin access required</Text>
          <Text style={styles.meta}>{error}</Text>
          <MonoButton label="RETRY" onPress={() => void reload()} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.section} testID="agent-classes-registry">
            <Text style={styles.body}>
              Tiers come from each model&apos;s output price on models.dev: god from $
              {GOD_MIN_OUTPUT_USD}, heavy from ${HEAVY_MIN_OUTPUT_USD}, light below that (per 1M
              output tokens). A pinned tier always wins.
            </Text>
            <Text style={styles.meta}>
              {view.registry.fetchedAt
                ? `models.dev · ${view.registry.modelCount.toLocaleString()} models · fetched ${FETCHED.format(new Date(view.registry.fetchedAt * 1_000))}`
                : 'models.dev has not been fetched yet. Every model counts as light and unclassified until it is.'}
            </Text>
          </View>

          {view.unclassified.length ? (
            <View style={styles.section} testID="agent-classes-unclassified">
              <Text style={styles.sectionLabel}>Unclassified</Text>
              {view.unclassified.map((entry) => (
                <View key={entry.key} style={styles.row} testID={`unclassified-${entry.key}`}>
                  <View style={styles.rowCopy}>
                    <Text style={styles.strong}>{entry.key}</Text>
                    <Text style={styles.meta}>
                      Used by {entry.agentNames.join(', ')} · light until pinned
                    </Text>
                  </View>
                  <MonoButton
                    label="Pin tier"
                    onPress={() => {
                      setPinScope('model');
                      setPinKey(entry.key);
                    }}
                    testID={`unclassified-pin-${entry.key}`}
                    variant="secondary"
                  />
                </View>
              ))}
            </View>
          ) : null}

          <View style={styles.section} testID="agent-classes-overrides">
            <Text style={styles.sectionLabel}>Tier overrides</Text>
            {view.overrides.length ? (
              view.overrides.map((override) => (
                <View
                  key={`${override.scope}:${override.key}`}
                  style={styles.row}
                  testID={`override-${override.scope}-${override.key}`}
                >
                  <View style={styles.rowCopy}>
                    <Text style={styles.meta}>{override.scope}</Text>
                    <Text style={styles.strong}>{override.key}</Text>
                  </View>
                  <TierPicker
                    disabled={Boolean(working)}
                    onChange={(tier) => void setOverride(override.scope, override.key, tier)}
                    testID={`override-tier-${override.scope}-${override.key}`}
                    value={override.tier}
                  />
                  <Pressable
                    accessibilityLabel={`Remove the ${override.scope} override for ${override.key}`}
                    accessibilityRole="button"
                    disabled={Boolean(working)}
                    hitSlop={10}
                    onPress={() => void setOverride(override.scope, override.key, null)}
                    testID={`override-remove-${override.scope}-${override.key}`}
                  >
                    <Text style={styles.remove}>×</Text>
                  </Pressable>
                </View>
              ))
            ) : (
              <Text style={styles.meta}>No overrides. Every tier follows the registry price.</Text>
            )}
            <View style={styles.pin} testID="override-pin-form">
              <View style={styles.segment}>
                {(['model', 'family'] as const).map((scope) => (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ selected: pinScope === scope }}
                    key={scope}
                    onPress={() => setPinScope(scope)}
                    style={[styles.segmentOption, pinScope === scope && styles.segmentOn]}
                    testID={`override-pin-scope-${scope}`}
                  >
                    <Text style={[styles.segmentLabel, pinScope === scope && styles.segmentLabelOn]}>
                      {scope}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <TextInput
                accessibilityLabel={pinScope === 'model' ? 'provider/model id' : 'Model family'}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setPinKey}
                placeholder={pinScope === 'model' ? 'provider/model-id' : 'family, e.g. opus'}
                placeholderTextColor={theme.buzz.dim}
                style={styles.input}
                testID="override-pin-key"
                value={pinKey}
              />
              <View style={styles.pinControls}>
                <TierPicker onChange={setPinTier} testID="override-pin-tier" value={pinTier} />
                <MonoButton
                  disabled={!pinKey.trim() || Boolean(working)}
                  label="Pin"
                  onPress={() => void setOverride(pinScope, pinKey.trim().toLowerCase(), pinTier)}
                  testID="override-pin-save"
                />
              </View>
            </View>
          </View>

          <View style={styles.section} testID="agent-classes-agents">
            <Text style={styles.sectionLabel}>Agents</Text>
            <Text style={styles.meta}>
              Locked tags are set by the system. Custom tags name classes too, e.g. a Room reviewer
              of class “reviewer”.
            </Text>
            {view.agents.map((agent) => {
              const draft = tagDrafts[agent.agentId] ?? '';
              return (
                <View key={agent.agentId} style={styles.agent} testID={`agent-classes-${agent.agentId}`}>
                  <View style={styles.rowCopy}>
                    <Text style={styles.strong}>{agent.name}</Text>
                    <Text style={styles.meta}>
                      {[agent.handle ? `@${agent.handle}` : undefined, agent.model]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  <AgentTagChips
                    disabled={Boolean(working)}
                    onRemove={(tag) => void setTag(agent.agentId, tag, false)}
                    tags={agent.classes.tags}
                  />
                  <Text style={styles.meta}>{agentTierSource(agent.classes)}</Text>
                  <View style={styles.addTag}>
                    <TextInput
                      accessibilityLabel={`New tag for ${agent.name}`}
                      autoCapitalize="none"
                      autoCorrect={false}
                      maxLength={32}
                      onChangeText={(value) =>
                        setTagDrafts((drafts) => ({ ...drafts, [agent.agentId]: value }))
                      }
                      onSubmitEditing={() => {
                        if (draft.trim()) void setTag(agent.agentId, draft.trim(), true);
                      }}
                      placeholder="add a tag"
                      placeholderTextColor={theme.buzz.dim}
                      style={[styles.input, styles.tagInput]}
                      testID={`agent-tag-input-${agent.agentId}`}
                      value={draft}
                    />
                    <MonoButton
                      disabled={!draft.trim() || Boolean(working)}
                      label="Add"
                      onPress={() => void setTag(agent.agentId, draft.trim(), true)}
                      testID={`agent-tag-add-${agent.agentId}`}
                      variant="secondary"
                    />
                  </View>
                </View>
              );
            })}
          </View>

          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              ! {error}
            </Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: hull.space.sm,
      paddingHorizontal: hull.space.lg,
    },
    content: { padding: hull.space.md, gap: hull.layout.sectionGap, paddingBottom: hull.space.xxl },
    section: { gap: hull.space.sm },
    sectionLabel: {
      ...Typography.default(),
      ...hull.type.sectionHead,
      color: hull.textMuted,
    },
    title: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    body: { ...Typography.default(), ...hull.type.body, color: hull.textSecondary },
    strong: { ...Typography.default(), ...hull.type.bodyStrong, color: hull.textPrimary },
    meta: { ...Typography.default(), ...hull.type.meta, color: hull.ledgerQuiet },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
      paddingVertical: hull.space.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    rowCopy: { flex: 1, minWidth: 0, gap: 2 },
    agent: {
      gap: hull.space.sm,
      paddingVertical: hull.space.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    addTag: { flexDirection: 'row', alignItems: 'center', gap: hull.space.sm },
    tagInput: { flex: 1 },
    pin: { gap: hull.space.sm, paddingTop: hull.space.sm },
    pinControls: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: hull.space.sm,
    },
    input: {
      ...Typography.default(),
      ...hull.type.body,
      minHeight: 40,
      paddingHorizontal: hull.space.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
      borderRadius: hull.radius,
      color: hull.textPrimary,
    },
    segment: {
      flexDirection: 'row',
      borderWidth: 1,
      borderColor: hull.borderStrong,
      borderRadius: hull.radius,
      overflow: 'hidden',
      alignSelf: 'flex-start',
    },
    segmentOption: { minHeight: 32, paddingHorizontal: 10, justifyContent: 'center' },
    segmentOn: { backgroundColor: hull.bgPressed },
    segmentLabel: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    segmentLabelOn: { color: hull.textPrimary },
    remove: { ...Typography.default(), ...hull.type.bodyStrong, color: hull.textMuted },
    error: { ...Typography.default(), ...hull.type.meta, color: hull.danger },
  };
});
