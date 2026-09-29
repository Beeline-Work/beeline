import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentClassView, AgentTagView } from '@beeline/api-contract/phone';
import { Typography } from '@/constants/Typography';

const KIND_LABEL: Record<AgentTagView['kind'], string> = {
  tier: 'weight tier',
  status: 'status',
  family: 'model family',
  harness: 'harness',
  provider: 'provider',
  custom: 'custom tag',
};

/**
 * An agent's tags as chips. Automatic tags carry a lock and never a remove
 * control; a custom tag shows one only when `onRemove` is given (Workspace
 * admins, in Workspace settings).
 */
export function AgentTagChips({
  tags,
  onRemove,
  disabled = false,
  testID,
}: {
  tags: readonly AgentTagView[];
  onRemove?: (tag: string) => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.chips} testID={testID}>
      {tags.map((tag) => {
        const automatic = tag.kind !== 'custom';
        return (
          <View
            accessibilityLabel={`${tag.tag}, ${KIND_LABEL[tag.kind]}${automatic ? ', set by the system' : ''}`}
            key={`${tag.kind}:${tag.tag}`}
            style={[
              styles.chip,
              tag.kind === 'tier' && styles.tier,
              tag.kind === 'status' && styles.status,
              !automatic && styles.custom,
            ]}
            testID={`agent-tag-${tag.tag}`}
          >
            {automatic ? (
              <Ionicons name="lock-closed" size={10} style={styles.lock} testID={`agent-tag-lock-${tag.tag}`} />
            ) : null}
            <Text
              style={[
                styles.label,
                tag.kind === 'tier' && styles.tierLabel,
                tag.kind === 'status' && styles.statusLabel,
              ]}
            >
              {tag.tag}
            </Text>
            {!automatic && tag.removable && onRemove ? (
              <Pressable
                accessibilityLabel={`Remove tag ${tag.tag}`}
                accessibilityRole="button"
                disabled={disabled}
                hitSlop={10}
                onPress={() => onRemove(tag.tag)}
                testID={`agent-tag-remove-${tag.tag}`}
              >
                <Text style={styles.remove}>×</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** One line saying where the tier came from. */
export function agentTierSource(classes: AgentClassView): string {
  switch (classes.source) {
    case 'model-override':
      return 'Tier pinned by an admin for this model';
    case 'family-override':
      return 'Tier pinned by an admin for this model family';
    case 'price':
      return `Tier from models.dev: $${formatPrice(classes.outputCost ?? 0)} per 1M output tokens`;
    case 'unlisted':
      return 'models.dev does not list this model yet. It counts as light until an admin pins a tier.';
  }
}

function formatPrice(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

const styles = StyleSheet.create((theme) => ({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 26,
    paddingHorizontal: 10,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    backgroundColor: theme.buzz.bgRaised,
  },
  tier: { borderColor: theme.buzz.accent, backgroundColor: theme.buzz.brassWash },
  status: { borderColor: theme.buzz.warning, borderStyle: 'dashed' },
  custom: { backgroundColor: 'transparent', borderStyle: 'dashed' },
  lock: { color: theme.buzz.textMuted },
  label: {
    ...Typography.default(),
    ...theme.buzz.type.meta,
    color: theme.buzz.textSecondary,
  },
  tierLabel: { color: theme.buzz.textPrimary },
  statusLabel: { color: theme.buzz.warning },
  remove: {
    ...Typography.default(),
    ...theme.buzz.type.meta,
    color: theme.buzz.textMuted,
    paddingLeft: 2,
  },
}));
