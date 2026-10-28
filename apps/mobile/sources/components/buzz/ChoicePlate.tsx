import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { PixelLoader } from './MonoHull';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from './ChevronGlyph';

export type TranscriptCardChoice = {
  id: string;
  /** The plate's letter or number; screen readers always read it. */
  letter: string;
  /**
   * A drawn mark shown in place of the letter: `chevron` for a choice that
   * applies something, `none` for the current one its selected box marks.
   */
  mark?: 'chevron' | 'none';
  label: string;
  consequence: string;
  costly?: boolean;
  votes?: number;
  share?: number;
  leader?: boolean;
  selected?: boolean;
  /** The tapped option while its decision sends. */
  busy?: boolean;
  /** Another option is sending; this one cannot be tapped. */
  disabled?: boolean;
  testID?: string;
  onPress?(): void;
};

/**
 * One lettered option plate (DESIGN.md: choice options are plates). A Room's
 * choice card and the Tray share it, so a choice reads the same everywhere.
 */
export function TranscriptCardChoicePlate({
  choice,
  closed,
}: {
  choice: TranscriptCardChoice;
  closed: boolean;
}) {
  const washWidth = closed ? Math.max(0, Math.min(1, choice.share ?? 0)) : 0;
  const inner = (
    <>
      {washWidth > 0 ? (
        <View
          pointerEvents="none"
          style={[
            styles.choiceWash,
            choice.leader ? styles.choiceWashLeader : null,
            { width: `${Math.round(washWidth * 100)}%` },
          ]}
          testID={`transcript-card-choice-wash-${choice.id}`}
        />
      ) : null}
      <View style={styles.choiceInner}>
        <View
          style={[
            styles.choiceLetter,
            choice.selected ? styles.choiceLetterSelected : null,
            choice.costly ? styles.choiceLetterCostly : null,
          ]}
          testID={`transcript-card-choice-letter-${choice.id}`}
        >
          {choice.mark === 'chevron' ? (
            <ChevronGlyph
              color={
                choice.selected
                  ? styles.choiceLetterTextSelected.color
                  : choice.costly
                    ? styles.choiceLetterTextCostly.color
                    : styles.choiceLetterText.color
              }
              size={CHEVRON_ROW_SIZE}
            />
          ) : choice.mark === 'none' ? null : (
            <Text
              style={[
                styles.choiceLetterText,
                choice.selected ? styles.choiceLetterTextSelected : null,
                choice.costly ? styles.choiceLetterTextCostly : null,
              ]}
            >
              {choice.letter}
            </Text>
          )}
        </View>
        <View style={styles.choiceCopy}>
          <Text
            style={[
              styles.choiceLabel,
              choice.leader ? styles.choiceLabelLeader : null,
              choice.disabled && !choice.busy ? styles.choiceLabelDisabled : null,
            ]}
          >
            {choice.label}
          </Text>
          {choice.consequence ? (
            <Text style={styles.choiceConsequence}>{choice.consequence}</Text>
          ) : null}
        </View>
        {choice.busy ? (
          <View style={styles.choiceLoader}>
            <PixelLoader compact />
          </View>
        ) : null}
        {closed && choice.votes !== undefined ? (
          <Text
            style={[styles.choiceCount, choice.leader ? styles.choiceCountLeader : null]}
            testID={`transcript-card-choice-count-${choice.id}`}
          >
            {choice.votes}
          </Text>
        ) : null}
      </View>
    </>
  );
  const plateStyle = [
    styles.choicePlate,
    closed ? styles.choicePlateClosed : null,
    choice.selected ? styles.choicePlateSelected : null,
    choice.disabled && !choice.busy ? styles.choicePlateDisabled : null,
  ];
  const testID = choice.testID ?? `transcript-card-choice-${choice.id}`;
  if (choice.onPress) {
    const disabled = Boolean(choice.disabled || choice.busy);
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${choice.letter}. ${choice.label}. ${choice.consequence}`}
        accessibilityState={{ disabled, busy: choice.busy === true }}
        aria-busy={choice.busy === true}
        disabled={disabled}
        onPress={choice.onPress}
        style={({ pressed }) => [plateStyle, pressed && !disabled && styles.choicePlatePressed]}
        testID={testID}
      >
        {inner}
      </Pressable>
    );
  }
  return (
    <View style={plateStyle} testID={testID}>
      {inner}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const card = theme.buzz;
  const metric = card.transcriptCard;
  return {
    choicePlate: {
      position: 'relative',
      overflow: 'hidden',
      minHeight: 52,
      borderWidth: 1,
      borderColor: card.borderStrong,
      borderRadius: card.radius,
      backgroundColor: card.bgHighlight,
    },
    choicePlateClosed: {
      backgroundColor: 'transparent',
      borderColor: card.border,
    },
    choicePlateSelected: { borderColor: card.accent },
    choicePlatePressed: { backgroundColor: card.bgPressed },
    choicePlateDisabled: { borderColor: card.border },
    choiceWash: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      backgroundColor: card.brassWash,
    },
    choiceWashLeader: { backgroundColor: card.brassWashStrong },
    choiceInner: {
      position: 'relative',
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: card.space.sm,
      paddingVertical: card.space.sm,
      paddingHorizontal: card.space.md,
    },
    choiceLetter: {
      minWidth: metric.identitySize,
      minHeight: metric.identitySize,
      paddingHorizontal: card.space.xs,
      paddingVertical: card.space.xs,
      borderWidth: 1,
      borderColor: card.borderStrong,
      borderRadius: card.radius,
      alignItems: 'center',
      justifyContent: 'center',
    },
    choiceLetterSelected: {
      borderColor: card.accent,
      backgroundColor: card.brassWash,
    },
    choiceLetterCostly: { borderColor: card.diffRemoved },
    choiceLetterText: { ...card.type.bodyStrong, color: card.textPrimary },
    choiceLetterTextSelected: { color: card.accent },
    choiceLetterTextCostly: { color: card.diffRemoved },
    choiceCopy: { flex: 1, minWidth: 0 },
    choiceLabel: { ...card.type.body, color: card.textPrimary },
    choiceLabelLeader: { ...card.type.bodyStrong, color: card.textPrimary },
    choiceLabelDisabled: { color: card.textDisabled },
    choiceLoader: { justifyContent: 'center', minHeight: metric.identitySize },
    choiceConsequence: { ...card.type.meta, color: card.ledgerQuiet, marginTop: card.space.xs },
    choiceCount: {
      ...card.type.machine,
      color: card.ledgerQuiet,
      fontVariant: ['tabular-nums'],
      paddingTop: 4,
      minWidth: 16,
      textAlign: 'right',
    },
    choiceCountLeader: { color: card.accent, fontFamily: card.proseMedium },
  };
});
