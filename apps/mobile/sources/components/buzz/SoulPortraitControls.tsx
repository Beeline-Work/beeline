import React, { useEffect, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentDetailView } from '@beeline/buzz-client';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal/ModalManager';
import { runAvatarGeneration, useAvatarGeneration } from '@/buzz/avatar-generation';
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
  const agentId = detail.agent.identity.pubkey;
  const job = useAvatarGeneration(agentId);
  const pending = job.pending || detail.avatarGenerationPending === true;
  const error = job.error;
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

  useEffect(() => {
    if (!detail.avatarGenerationPending || job.pending) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refreshRef.current();
      } catch {
        /* Keep the server-owned job disabled until a read settles it. */
      }
      if (!disposed) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [detail.avatarGenerationPending, job.pending]);

  const draw = async () => {
    if (pending || requestActive.current || disabled || !soul.trim()) return;
    requestActive.current = true;
    const attempt = generation.current;
    try {
      await runAvatarGeneration(agentId, async () => {
        const confirmed = await Modal.confirm(
          'Generate avatar from soul?',
          'This sends the current soul text and optional direction to the agent. Unsaved soul edits are not saved by this action.',
          { cancelText: 'Cancel', confirmText: 'Generate' },
        );
        if (!confirmed || attempt !== generation.current) return;
        const previous = detail.avatarGenerationId;
        await generate(soul.trim(), direction.trim() || undefined);
        for (let i = 0; i < 90; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const next = await refreshRef.current();
          if (next.avatarGenerationId && next.avatarGenerationId !== previous) return;
          if (next.avatarGenerationPending === false)
            throw new Error(
              'The avatar job ended without saving a new avatar. Check the agent’s DM and retry.',
            );
        }
        throw new Error(
          'The agent has not saved a new avatar yet. Check its DM. An active job must finish before retrying.',
        );
      });
    } finally {
      requestActive.current = false;
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
            ? 'generating, will DM you when the avatar is ready'
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
