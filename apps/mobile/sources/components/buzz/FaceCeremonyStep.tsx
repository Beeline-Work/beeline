import React, { useRef, useState } from 'react';
import { Animated, Easing, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { defaultFaceForSeed, type FaceId } from '@/buzz/faces';
import { FaceGrid } from './FaceGrid';
import { MonoButton } from './MonoHull';

/** The one canvas crossfade in the app: the ceremony into the Room deck. */
export const FACE_CEREMONY_CROSSFADE_MS = 240;

type FaceCeremonyStepProps = {
  /** The new identity's pubkey: the seed the tiles and the default face are drawn from. */
  seed: string;
  /** A face already on record (a returning person on a new device); else the seed's default. */
  currentFace?: string | null;
  /** Persist the choice. A rejection keeps the person here with an inline, retryable error. */
  onConfirm: (face: FaceId) => Promise<void>;
  /** Fires once the crossfade has painted the app canvas: open the app. */
  onEntered: () => void;
  /** Test seam: start with nothing chosen to prove the button gate. */
  initialSelection?: string | null;
};

/**
 * Onboarding's last step: "Choose your face." A default face is pre-selected
 * from the seed so one tap on the button also works; skipping is not offered.
 */
export function FaceCeremonyStep({
  seed,
  currentFace,
  onConfirm,
  onEntered,
  initialSelection,
}: FaceCeremonyStepProps) {
  const { theme } = useUnistyles();
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
      await onConfirm(selected as FaceId);
    } catch (caught) {
      setError(
        `Could not save your face. Try again. (${caught instanceof Error ? caught.message : String(caught)})`,
      );
      setBusy(false);
      return;
    }
    // Persisted. Paint the app canvas over the ceremony, then open the app;
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
    <View style={styles.root} testID="onboarding-face-step">
      <Animated.View style={[styles.content, { opacity: contentOpacity }]}>
        <Text style={styles.title} testID="onboarding-face-title">
          Choose your face
          <Text style={styles.titlePeriod}>.</Text>
        </Text>
        <Text style={styles.subtitle} testID="onboarding-face-subtitle">
          Animals only. You can change it anytime.
        </Text>
        <View style={styles.gridSlot}>
          <FaceGrid
            disabled={busy}
            onSelect={(face) => {
              setSelected(face);
              setError(null);
            }}
            seed={seed}
            selected={selected}
            testIDPrefix="onboarding-face"
          />
        </View>
        {error ? (
          <View accessibilityRole="alert" style={styles.noticePanel} testID="onboarding-face-error">
            <Text style={styles.statusLabel}>◇ FACE NOT SAVED</Text>
            <Text style={styles.noticeText}>{error}</Text>
          </View>
        ) : null}
        <MonoButton
          disabled={!selected || busy}
          label="Enter Beeline"
          labelStyle={styles.buttonLabel}
          loading={busy}
          onPress={() => void confirm()}
          testID="onboarding-face-confirm"
        />
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
  const groknight = theme.buzz;
  return {
    root: { flex: 1 },
    content: { flex: 1, justifyContent: 'center' },
    title: {
      ...Typography.default('semiBold'),
      fontFamily: groknight.proseSemibold,
      fontSize: 28,
      lineHeight: 32,
      color: groknight.textPrimary,
      textAlign: 'center',
      marginBottom: 8,
    },
    titlePeriod: {
      ...Typography.default('semiBold'),
      fontFamily: groknight.proseSemibold,
      color: groknight.accent,
    },
    subtitle: {
      ...Typography.default(),
      fontFamily: groknight.proseRegular,
      fontSize: 14,
      lineHeight: 20,
      color: groknight.textSecondary,
      textAlign: 'center',
      marginBottom: 24,
    },
    gridSlot: { alignItems: 'center', marginBottom: 24 },
    buttonLabel: { fontFamily: groknight.proseSemibold },
    noticePanel: {
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgHighlight,
      padding: 12,
      marginBottom: 16,
    },
    statusLabel: {
      ...Typography.mono('semiBold'),
      color: groknight.textPrimary,
      fontSize: 11,
      lineHeight: 15,
      letterSpacing: 0.8,
      marginBottom: 4,
    },
    noticeText: {
      ...Typography.default(),
      fontFamily: groknight.proseRegular,
      color: groknight.textSecondary,
      fontSize: 14,
      lineHeight: 20,
    },
  };
});
