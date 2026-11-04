import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentDetailView } from '@beeline/buzz-client';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal/ModalManager';
import {
  avatarGenerationShowsPending,
  noteServerAvatarGeneration,
  runAvatarGeneration,
  useAvatarGeneration,
} from '@/buzz/avatar-generation';
import { SettingsRow } from './SettingsRow';

export function SoulPortraitControls({
  detail,
  soul,
  disabled,
  generate,
}: {
  detail: AgentDetailView;
  soul: string;
  disabled: boolean;
  generate: (soul: string) => Promise<void>;
}) {
  const agentId = detail.agent.identity.pubkey;
  const job = useAvatarGeneration(agentId);
  const pending = avatarGenerationShowsPending(job, detail);
  const error = job.error;
  const generation = useRef(0);
  const requestActive = useRef(false);
  const cancelWaitRef = useRef<(() => void) | null>(null);
  const judgeRef = useRef<((next: AgentDetailView) => void) | null>(null);
  useEffect(
    () => () => {
      generation.current += 1;
      cancelWaitRef.current?.();
    },
    [],
  );

  useEffect(() => {
    if (!job.pending) return;
    noteServerAvatarGeneration(agentId, detail);
    // A server answer that ended the bridge also ends the client job.
    if (!avatarGenerationShowsPending(job, detail)) judgeRef.current?.(detail);
  }, [agentId, detail, job]);


  const draw = async () => {
    if (pending || requestActive.current || disabled || !soul.trim()) return;
    requestActive.current = true;
    const attempt = generation.current;
    try {
      await runAvatarGeneration(agentId, detail.avatarGenerationId, async () => {
        const confirmed = await Modal.confirm(
          'Generate avatar from soul?',
          'The agent saves your current soul first, then draws from it in its DM.',
          { cancelText: 'Cancel', confirmText: 'Generate' },
        );
        if (!confirmed || attempt !== generation.current) return;
        const previous = detail.avatarGenerationId;
        let settle: (() => void) | undefined;
        let fail: ((reason: Error) => void) | undefined;
        const completed = new Promise<void>((resolve, reject) => {
          settle = resolve;
          fail = reject;
        });
        cancelWaitRef.current = () => settle?.();
        const judge = (next: AgentDetailView) => {
          if (next.avatarGenerationId && next.avatarGenerationId !== previous) settle?.();
          else if (next.avatarGenerationPending === false)
            fail?.(new Error('The avatar job ended without saving a new avatar. Check the agent’s DM and retry.'));
        };
        judgeRef.current = judge;
        // The parent owns the shared Agent detail lane. Only its next server
        // DTO can complete this wait; the portrait never starts another read.
        try {
          await generate(soul.trim());
          await completed;
        } finally {
          cancelWaitRef.current = null;
          judgeRef.current = null;
        }
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
