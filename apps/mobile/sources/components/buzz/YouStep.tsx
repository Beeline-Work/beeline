import React, { useRef, useState } from 'react';
import { Animated, Easing, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { defaultFaceForSeed, type FaceId } from '@/buzz/faces';
import { FaceGrid } from './FaceGrid';
import { Button } from './Button';

/** The one canvas crossfade in the app: the You step into the app. */
export const FACE_CEREMONY_CROSSFADE_MS = 240;

export type YouStepChoice = { face: FaceId };

type YouStepProps = {
  /** The new identity's id: the seed the tiles and the default face are drawn from. */
  seed: string;
  /** The actual GitHub login assigned to this identity, when available. */
  handle?: string;
  /** Existing display name, used only if the handle read is unavailable. */
  name?: string;
  /** A face already on record; else the seed's default. */
  currentFace?: string | null;
  /** Persist the choice. A rejection keeps the person here with an inline, retryable error. */
  onConfirm: (choice: YouStepChoice) => Promise<void>;
  /** Fires once the crossfade has painted the app canvas: open the app. */
  onEntered: () => void;
  /** Test seam: start with nothing chosen to prove the button gate. */
  initialSelection?: string | null;
};

/**
 * Onboarding's identity step. GitHub supplies the handle; the face chosen
 * here is the one saved. Both can be changed later in Settings.
 */
export function YouStep({
  seed,
  handle,
  name,
  currentFace,
  onConfirm,
  onEntered,
  initialSelection,
}: YouStepProps) {
  const { theme } = useUnistyles();
  const { width } = useWindowDimensions();
  const tileSize = Math.min(78, Math.floor((width - theme.buzz.space.md * 2 - 30) / 4));
  const [selected, setSelected] = useState<string | null>(
    initialSelection === undefined ? (currentFace ?? defaultFaceForSeed(seed)) : initialSelection,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const crossfade = useRef(new Animated.Value(0)).current;
  const contentOpacity = crossfade.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const confirm = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ face: selected as FaceId });
    } catch (caught) {
      setError(
        `Could not save your face. Try again. (${caught instanceof Error ? caught.message : String(caught)})`,
      );
      setBusy(false);
      return;
    }
    // Persisted. Paint the app canvas over the step, then open the app;
    // the button stays busy so it never flickers back on before the swap.
    Animated.timing(crossfade, {
      toValue: 1,
      duration: FACE_CEREMONY_CROSSFADE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) onEntered();
    });
  };

  return (
    <View style={styles.root} testID="onboarding-you-step">
      <Animated.View style={[styles.fill, { opacity: contentOpacity }]}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          style={styles.fill}
        >
          <View style={styles.choices}>
            <Text accessibilityRole="header" style={styles.title} testID="onboarding-you-title">
              You are
            </Text>
            <Text
              adjustsFontSizeToFit
              numberOfLines={1}
              style={styles.handleLine}
              testID="onboarding-you-handle"
            >
              {handle ? <Text style={styles.at}>@</Text> : null}
              <Text style={styles.handle}>{handle || name || 'You'}</Text>
              <Text style={styles.period}>.</Text>
            </Text>
            <View style={styles.gridSlot}>
              <FaceGrid
                columns={4}
                disabled={busy}
                onSelect={(face) => {
                  setSelected(face);
                  setError(null);
                }}
                seed={seed}
                selected={selected}
                selectedBorderColor={theme.buzz.textPrimary}
                testIDPrefix="onboarding-face"
                tileSize={tileSize}
              />
            </View>
          </View>
          <View style={styles.footer}>
            {error ? (
              <Text accessibilityRole="alert" style={styles.error} testID="onboarding-face-error">
                {error}
              </Text>
            ) : null}
            <Button
              disabled={!selected || busy}
              label="Continue"
              loading={busy}
              onPress={() => void confirm()}
              testID="onboarding-face-confirm"
            />
            <Text style={styles.hint} testID="onboarding-you-source">
              From GitHub · change either later in Settings
            </Text>
          </View>
        </ScrollView>
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFillObject,
          { backgroundColor: theme.buzz.bgBase, opacity: crossfade },
        ]}
        testID="onboarding-canvas-crossfade"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  // The approved identity line combines the hero and body scales.
  const handleSize = hull.type.hero.fontSize + hull.type.body.fontSize;
  return {
    root: { flex: 1 },
    fill: { flex: 1 },
    content: {
      flexGrow: 1,
      justifyContent: 'space-between',
      width: '100%',
      maxWidth: 460,
      alignSelf: 'center',
      paddingHorizontal: hull.space.md,
      paddingVertical: hull.space.lg,
    },
    choices: { paddingTop: hull.space.xl },
    title: { ...Typography.default(), ...hull.type.hero, color: hull.textSecondary },
    handleLine: { ...Typography.default(), fontSize: handleSize, lineHeight: 52, marginTop: hull.space.xs },
    at: { color: hull.accent },
    handle: { color: hull.textPrimary },
    period: { color: hull.textPrimary },
    hint: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.ledgerQuiet,
      textAlign: 'center',
      marginTop: hull.space.md,
    },
    gridSlot: { alignItems: 'center', marginTop: hull.space.xxl },
    footer: { paddingBottom: hull.space.sm },
    error: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.dialogDanger,
      marginBottom: hull.space.md,
    },
  };
});
