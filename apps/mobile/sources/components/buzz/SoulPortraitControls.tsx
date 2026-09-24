import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentDetailView } from '@beeline/buzz-client';
import { Typography } from '@/constants/Typography';
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
  generate: (soul: string) => Promise<void>;
  refresh: () => Promise<AgentDetailView>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const draw = async () => {
    if (pending || disabled || !soul.trim()) return;
    const attempt = ++generation.current;
    const previous = detail.avatarGenerationId;
    setPending(true);
    setError(null);
    try {
      await generate(soul.trim());
      // Slow model turns and offline agents get a bounded wait, with a retry.
      for (let i = 0; i < 90 && attempt === generation.current; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (attempt !== generation.current) return;
        const next = await refreshRef.current();
        if (next.avatarGenerationId && next.avatarGenerationId !== previous) return;
      }
      if (attempt === generation.current)
        setError('The agent has not saved a new avatar yet. Check its DM or retry.');
    } catch {
      if (attempt === generation.current)
        setError(
          'Could not confirm a new avatar. Check the agent’s DM or retry when it is available.',
        );
    } finally {
      if (attempt === generation.current) setPending(false);
    }
  };
  const handle = detail.agent.identity.handle?.replace(/^@/, '');
  return (
    <View style={styles.container} testID="soul-avatar-generator">
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
}));
