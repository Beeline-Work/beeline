import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { MESSAGE_REACTION_EMOJIS } from '@beeline/buzz-client';
import { MessageReactionStrip } from '../sources/components/buzz/MessageReactionStrip';
import { emojiTextStyle } from '../sources/buzz/emoji-text';
import { groknight } from '../sources/buzz/groknight';

const emojiAfter = emojiTextStyle(groknight.type.body);

// Plain-object styles for the proof page itself. The REAL component styles
// (MessageReactionStrip's, through its unistyles import) come from the shipped
// sources; these copy only the chip cells' layout from RoomMessageVariants.
const proofStyles = {
  page: {
    backgroundColor: groknight.bgVoid,
    padding: 16,
    gap: 18,
  } as const,
  label: {
    color: groknight.textSecondary,
    fontSize: 11,
    marginBottom: 6,
  } as const,
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 } as const,
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
  } as const,
  chipMine: { borderColor: groknight.accent, backgroundColor: groknight.bgHighlight } as const,
  chipEmojiBefore: { ...emojiAfter, lineHeight: 19 } as const,
  count: { ...groknight.type.meta, color: groknight.textSecondary } as const,
  strip: { backgroundColor: groknight.bgBase } as const,
  stripChoice: {
    minWidth: 44,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  } as const,
  stripChoiceBefore: { ...emojiAfter, lineHeight: 22 } as const,
};

function Chips({ emojiStyle, mine }: { emojiStyle: object; mine?: boolean }) {
  return (
    <View style={proofStyles.chips}>
      {MESSAGE_REACTION_EMOJIS.slice(0, 4).map((emoji, index) => (
        <View key={emoji} style={[proofStyles.chip, mine && index === 0 && proofStyles.chipMine]}>
          <Text style={emojiStyle}>{emoji}</Text>
          <Text style={proofStyles.count}>{index + 1}</Text>
        </View>
      ))}
    </View>
  );
}

function StripCells({ emojiStyle }: { emojiStyle: object }) {
  return (
    <View style={[proofStyles.chips, proofStyles.strip]}>
      {MESSAGE_REACTION_EMOJIS.slice(0, 6).map((emoji) => (
        <View key={emoji} style={proofStyles.stripChoice}>
          <Text style={emojiStyle}>{emoji}</Text>
        </View>
      ))}
    </View>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <View style={proofStyles.page}>
    <View>
      <Text style={proofStyles.label}>message actions sheet — shared strip (after)</Text>
      <MessageReactionStrip onReact={() => undefined} />
    </View>
    <View>
      <Text style={proofStyles.label}>strip cells — before (lineHeight 22) / after (derived)</Text>
      <StripCells emojiStyle={proofStyles.stripChoiceBefore} />
      <StripCells emojiStyle={emojiAfter} />
    </View>
    <View>
      <Text style={proofStyles.label}>reaction chips — before (lineHeight 19)</Text>
      <Chips emojiStyle={proofStyles.chipEmojiBefore} mine />
    </View>
    <View>
      <Text style={proofStyles.label}>reaction chips — after (derived, no lineHeight)</Text>
      <Chips emojiStyle={emojiAfter} mine />
    </View>
  </View>,
);
