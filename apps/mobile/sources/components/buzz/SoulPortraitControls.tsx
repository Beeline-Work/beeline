import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentDetailView } from '@beeline/buzz-client';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal/ModalManager';
import { runAvatarGeneration, useAvatarGeneration } from '@/buzz/avatar-generation';
import { SettingsRow } from './SettingsRow';

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
  generate: (soul: string) => Promise<void>;
  refresh: () => Promise<AgentDetailView>;
}) {
  const agentId = detail.agent.identity.pubkey;
  const job = useAvatarGeneration(agentId);
  const pending = job.pending || detail.avatarGenerationPending === true;
  const error = job.error;
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
          'This sends the current soul text to the agent. Unsaved soul edits are not saved by this action.',
          { cancelText: 'Cancel', confirmText: 'Generate' },
        );
        if (!confirmed || attempt !== generation.current) return;
        const previous = detail.avatarGenerationId;
        await generate(soul.trim());
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
      <SettingsRow
        title={error ? 'Retry avatar generation' : 'Generate avatar from soul'}
        tone="action"
        onPress={() => void draw()}
        disabled={disabled || pending || !soul.trim()}
        testID="generate-avatar-from-soul"
      />
      {pending && (
        <Text style={styles.copy} testID="avatar-generation-pending">
          generating, will DM you when the avatar is ready
        </Text>
      )}
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
  container: { gap: theme.buzz.space.sm },
  title: { ...Typography.default(), ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  copy: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
}));
