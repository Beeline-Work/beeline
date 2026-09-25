import React, { useEffect, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentDetailView } from '@beeline/buzz-client';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal/ModalManager';
import { MonoButton } from './MonoHull';

export function SoulPortraitControls({
  detail,
  soul,
  disabled,
  generate,
  refresh,
}: {
  detail: AgentDetailView;
  soul: string;
  disabled: boolean;
  generate: (soul: string, direction?: string) => Promise<void>;
  refresh: () => Promise<AgentDetailView>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [direction, setDirection] = useState('');
  const generation = useRef(0);
  const requestActive = useRef(false);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const draw = async () => {
    if (requestActive.current || disabled || !soul.trim()) return;
    requestActive.current = true;
    const attempt = ++generation.current;
    const previous = detail.avatarGenerationId;
    setPending(true);
    setError(null);
    try {
      const confirmed = await Modal.confirm(
        'Generate avatar from soul?',
        'This sends the current soul text to the agent and uses its connected model to draw a replacement avatar. Unsaved soul edits are not saved by this action.',
        { cancelText: 'Cancel', confirmText: 'Generate' },
      );
      if (!confirmed || attempt !== generation.current) return;
      await generate(soul.trim(), direction.trim() || undefined);
      // Slow model turns and offline agents get a bounded wait, with a retry.
      for (let i = 0; i < 90 && attempt === generation.current; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (attempt !== generation.current) return;
        const next = await refreshRef.current();
        if (next.avatarGenerationId && next.avatarGenerationId !== previous) return;
      }
      if (attempt === generation.current)
        setError('The agent has not saved a new avatar yet. Check its DM or retry.');
    } catch (reason) {
      if (attempt === generation.current)
        setError(
          `Could not request or confirm the avatar: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
    } finally {
      if (attempt === generation.current) {
        requestActive.current = false;
        setPending(false);
      }
    }
  };
  const handle = detail.agent.identity.handle?.replace(/^@/, '');
  return (
    <View style={styles.container} testID="soul-avatar-generator">
      <TextInput
        accessibilityLabel="Avatar direction (optional)"
        editable={!disabled && !pending}
        maxLength={300}
        onChangeText={setDirection}
        placeholder="Optional direction, e.g. make the eyes brighter"
        placeholderTextColor={styles.placeholder.color}
        style={styles.direction}
        testID="avatar-direction"
        value={direction}
      />
      <MonoButton
        label={
          pending
            ? 'Generating avatar…'
            : error
              ? 'Retry avatar generation'
              : 'Generate avatar from soul'
        }
        onPress={() => void draw()}
        loading={pending}
        disabled={disabled || pending || !soul.trim()}
        variant="secondary"
        testID="generate-avatar-from-soul"
      />
      {error && (
        <Text accessibilityRole="alert" style={styles.copy} testID="avatar-generation-error">
          {error}
        </Text>
      )}
      {detail.avatarGenerationId && (
        <View testID="avatar-refinement-hint">
          <Text style={styles.title}>Want a different look?</Text>
          <Text selectable style={styles.copy}>
            {handle
              ? `Ask @${handle} /draw-avatar "make him more scary"`
              : 'In this agent’s DM, use /draw-avatar "make him more scary"'}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.buzz.space.md, marginTop: theme.buzz.space.md },
  title: { ...Typography.default(), ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  copy: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  placeholder: { color: theme.buzz.textMuted },
  direction: {
    ...Typography.default(),
    ...theme.buzz.type.body,
    color: theme.buzz.textPrimary,
    borderWidth: 1,
    borderColor: theme.buzz.border,
    borderRadius: theme.buzz.radius,
    minHeight: 44,
    paddingHorizontal: 12,
  },
}));
