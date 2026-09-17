import React from 'react';
import { Pressable, ScrollView, StatusBar, StyleSheet as RNStyleSheet, Text, View } from 'react-native';
import { MESSAGE_REACTION_EMOJIS } from '@beeline/buzz-client';
import { MessageReactionStrip } from '../sources/components/buzz/MessageReactionStrip';
import { emojiTextStyle } from '../sources/buzz/emoji-text';
import { groknight } from '../sources/buzz/groknight';

// BEFORE styles are exactly what the fix removed: the shipped body role plus the
// explicit lineHeight the chips (19) and strip (22) used to carry. AFTER is the
// shipped derivation with the lineHeight deliberately absent.
const emojiBeforeChips = { ...groknight.type.body, lineHeight: 19 };
const emojiBeforeStrip = { ...groknight.type.body, lineHeight: 22 };
const emojiAfter = emojiTextStyle(groknight.type.body);

// Proof-local cells copy the shipped cell geometry so the native capture
// matches the app surface: the reaction chip exactly as RoomMessageVariants
// renders it (border, radius, mine colors, count Text) and the strip's choice
// cells — the same values the committed web proof resolves.
const styles = RNStyleSheet.create({
  // Below the status bar: the proof renders edge-to-edge on the emulator.
  page: {
    backgroundColor: groknight.bgVoid,
    paddingTop: (StatusBar.currentHeight ?? 0) + 24,
    paddingHorizontal: 16,
    gap: 18,
  },
  label: { color: groknight.textSecondary, fontSize: 11, marginBottom: 6 },
  cell: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 28,
    borderRadius: 3,
    backgroundColor: '#232328',
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
  },
  stripRow: { flexDirection: 'row', gap: 6 },
  // The shipped reaction chip (RoomMessageVariants styles.reactionChip):
  // gap 4, minHeight 28, hairline border, radius, and the count Text beside
  // the emoji, styled like the real component's count.
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 28,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: groknight.radius,
    backgroundColor: groknight.bgBase,
  },
  chipMine: { borderColor: groknight.accent, backgroundColor: groknight.bgHighlight },
  chipCount: { ...groknight.type.meta, color: groknight.textSecondary },
});

function Chips({ emojiStyle, mine }: { emojiStyle: object; mine?: boolean }) {
  return (
    <View style={styles.stripRow}>
      {MESSAGE_REACTION_EMOJIS.slice(0, 4).map((emoji, index) => (
        <View key={emoji} style={[styles.chip, mine && index === 0 && styles.chipMine]}>
          <Text style={emojiStyle}>{emoji}</Text>
          <Text style={styles.chipCount}>{index + 1}</Text>
        </View>
      ))}
    </View>
  );
}

function StripCells({ emojiStyle }: { emojiStyle: object }) {
  return (
    <View style={styles.stripRow}>
      {MESSAGE_REACTION_EMOJIS.slice(0, 4).map((emoji) => (
        <Pressable key={emoji} style={({ pressed }) => [
          styles.cell,
          { minHeight: 36, minWidth: 44, backgroundColor: pressed ? groknight.bgHighlight : '#232328' },
        ]}>
          <Text style={emojiStyle}>{emoji}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export default function App() {
  return (
    <ScrollView style={{ backgroundColor: groknight.bgVoid }} contentContainerStyle={styles.page}>
      <View>
        <Text style={styles.label}>real MessageReactionStrip (shipped styles, after)</Text>
        <MessageReactionStrip onReact={() => undefined} />
      </View>
      <View>
        <Text style={styles.label}>strip cells — before (lineHeight 22)</Text>
        <StripCells emojiStyle={emojiBeforeStrip} />
        <Text style={styles.label}>strip cells — after (derived, no lineHeight)</Text>
        <StripCells emojiStyle={emojiAfter} />
      </View>
      <View>
        <Text style={styles.label}>reaction chips — before (lineHeight 19)</Text>
        <Chips emojiStyle={emojiBeforeChips} mine />
        <Text style={styles.label}>reaction chips — after (derived, no lineHeight)</Text>
        <Chips emojiStyle={emojiAfter} mine />
      </View>
      <Text style={{ color: groknight.textSecondary, fontSize: 10 }}>
        shipped styles, rendered natively · emoji font: system
      </Text>
    </ScrollView>
  );
}
