import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentDetailView } from '@beeline/buzz-client';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal/ModalManager';
import { runAvatarGeneration, useAvatarGeneration } from '@/buzz/avatar-generation';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
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
  const cancelWaitRef = useRef<(() => void) | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(
    () => () => {
      generation.current += 1;
      cancelWaitRef.current?.();
    },
    [],
  );

  useEffect(() => {
    if (!detail.avatarGenerationPending || job.pending) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void sharedLiveConnection().register([], (event) => {
      if (disposed || !('monolithLive' in event)) return;
      const live = event.monolithLive;
      if ((live.type === 'resource-change' && live.resource === 'agent' &&
          live.resourceId === agentId) ||
          (live.type === 'invalidate' && live.roomId === '' && live.reason === 'reconnect'))
        void refreshRef.current().catch(() => undefined);
    }).then((release) => {
      if (disposed) release();
      else stop = release;
    });
    return () => { disposed = true; stop?.(); };
  }, [agentId, detail.avatarGenerationPending, job.pending]);

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
        let stop: (() => void) | undefined;
        let settle: (() => void) | undefined;
        let fail: ((reason: Error) => void) | undefined;
        let reading = false;
        let queued = false;
        let accepted = false;
        let earlySignal = false;
        const completed = new Promise<void>((resolve, reject) => {
          settle = resolve;
          fail = reject;
        });
        cancelWaitRef.current = () => settle?.();
        const check = () => {
          if (attempt !== generation.current) return;
          if (reading) { queued = true; return; }
          reading = true;
          void refreshRef.current().then((next) => {
            if (next.avatarGenerationId && next.avatarGenerationId !== previous) settle?.();
            else if (next.avatarGenerationPending === false)
              fail?.(new Error('The avatar job ended without saving a new avatar. Check the agent’s DM and retry.'));
          }).catch(() => undefined).finally(() => {
            reading = false;
            if (queued) { queued = false; check(); }
          });
        };
        try {
          stop = await sharedLiveConnection().register([], (event) => {
            if (!('monolithLive' in event) || attempt !== generation.current) return;
            const live = event.monolithLive;
            if (!((live.type === 'resource-change' && live.resource === 'agent' &&
                live.resourceId === agentId) ||
                (live.type === 'invalidate' && live.roomId === '' && live.reason === 'reconnect')))
              return;
            if (!accepted) earlySignal = true;
            else check();
          });
          await generate(soul.trim());
          accepted = true;
          if (earlySignal) check();
          await completed;
        } finally {
          cancelWaitRef.current = null;
          stop?.();
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
