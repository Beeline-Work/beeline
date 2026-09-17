import React from 'react';
import { Pressable, ScrollView, StyleSheet as RNStyleSheet, Text, View } from 'react-native';
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

// Proof-local cells copy the shipped chip cell geometry (min 28) and the strip
// choice cell look so the native capture matches the app surface.
const styles = RNStyleSheet.create({
  page: { backgroundColor: '#131316', paddingTop: 48, paddingHorizontal: 16, gap: 22 },
  label: { color: '#9a9aa2', fontSize: 12, marginBottom: 8 },
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
  cellMine: { backgroundColor: '#3a3a40' },
  stripRow: { flexDirection: 'row', gap: 6 },
});

function Chips({ emojiStyle, mine }: { emojiStyle: object; mine?: boolean }) {
  return (
    <View style={styles.stripRow}>
      {MESSAGE_REACTION_EMOJIS.slice(0, 4).map((emoji) => (
        <View key={emoji} style={[styles.cell, mine && styles.cellMine]}>
          <Text style={emojiStyle}>{emoji}</Text>
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
          { minHeight: 36, backgroundColor: pressed ? groknight.bgHighlight : '#232328' },
        ]}>
          <Text style={emojiStyle}>{emoji}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export default function App() {
  return (
    <ScrollView style={{ backgroundColor: '#131316' }} contentContainerStyle={styles.page}>
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
      <Text style={{ color: '#6a6a72', fontSize: 11 }}>
        head 06d540928a59daaf6f7ed2836711ae6de9460196 · emoji font: system
      </Text>
    </ScrollView>
  );
}
