import React, { useRef, useState } from 'react';
import { Animated, Easing, ScrollView, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { defaultFaceForSeed, type FaceId } from '@/buzz/faces';
import { FaceGrid } from './FaceGrid';
import { OnboardingButton } from './MonoHull';

/** The one canvas crossfade in the app: the You step into the app. */
export const FACE_CEREMONY_CROSSFADE_MS = 240;

export type YouStepChoice = { name: string; face: FaceId };

type YouStepProps = {
  /** The new identity's id: the seed the tiles and the default face are drawn from. */
  seed: string;
  /** The name on record, from GitHub on a first sign-in. Editable here. */
  name: string;
  /** The GitHub login, shown under the name as where it came from. */
  handle?: string;
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
 * Onboarding's one identity step: "You, in every Workspace". The name comes
 * from GitHub and can be edited; the face grid is the only face picker in
 * signup, and the face chosen here is the one saved.
 */
export function YouStep({
  seed,
  name: initialName,
  handle,
  currentFace,
  onConfirm,
  onEntered,
  initialSelection,
}: YouStepProps) {
  const { theme } = useUnistyles();
  const [name, setName] = useState(initialName);
  const [selected, setSelected] = useState<string | null>(
    initialSelection === undefined ? (currentFace ?? defaultFaceForSeed(seed)) : initialSelection,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const crossfade = useRef(new Animated.Value(0)).current;
  const contentOpacity = crossfade.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const trimmed = name.trim();

  const confirm = async () => {
    if (!selected || !trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ name: trimmed, face: selected as FaceId });
    } catch (caught) {
      setError(
        `Could not save your name and face. Try again. (${caught instanceof Error ? caught.message : String(caught)})`,
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
          <Text accessibilityRole="header" style={styles.title} testID="onboarding-you-title">
            You, in every Workspace
          </Text>
          <Text style={styles.meta} testID="onboarding-you-meta">
            People and agents see this name and face. Change either in Settings.
          </Text>
          <Text style={styles.label}>Name</Text>
          <TextInput
            accessibilityLabel="Name"
            autoCapitalize="words"
            editable={!busy}
            maxLength={80}
            onChangeText={(value) => {
              setName(value);
              setError(null);
            }}
            placeholderTextColor={theme.buzz.textDisabled}
            style={styles.input}
            testID="onboarding-you-name"
            value={name}
          />
          {handle ? (
            <Text style={styles.hint} testID="onboarding-you-source">
              {`From GitHub · @${handle}`}
            </Text>
          ) : null}
          <Text style={[styles.label, styles.faceLabel]}>Face</Text>
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
            <Text accessibilityRole="alert" style={styles.error} testID="onboarding-face-error">
              {error}
            </Text>
          ) : null}
          <OnboardingButton
            disabled={!selected || !trimmed || busy}
            label="Continue"
            loading={busy}
            onPress={() => void confirm()}
            testID="onboarding-face-confirm"
          />
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
  return {
    root: { flex: 1 },
    fill: { flex: 1 },
    content: {
      flexGrow: 1,
      justifyContent: 'center',
      width: '100%',
      maxWidth: 460,
      alignSelf: 'center',
      paddingVertical: hull.space.lg,
    },
    title: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    meta: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textSecondary,
      marginTop: hull.space.sm,
      marginBottom: hull.space.lg,
    },
    label: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textSecondary,
      marginBottom: hull.space.sm,
    },
    faceLabel: { marginTop: hull.space.lg },
    input: {
      ...Typography.default(),
      ...hull.type.body,
      minHeight: 48,
      paddingHorizontal: hull.space.md,
      borderRadius: hull.radius,
      borderWidth: 1,
      borderColor: hull.borderStrong,
      color: hull.textPrimary,
      backgroundColor: hull.bgBase,
    },
    hint: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.ledgerQuiet,
      marginTop: hull.space.sm,
    },
    gridSlot: { alignItems: 'center', marginBottom: hull.space.lg },
    error: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.dialogDanger,
      marginBottom: hull.space.md,
    },
  };
});
