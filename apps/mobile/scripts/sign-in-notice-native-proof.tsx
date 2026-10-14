import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { boneTheme, boneSmallTheme, boneLargeTheme, obsidianTheme, obsidianSmallTheme, obsidianLargeTheme } from '../sources/theme';
import { LEDGER_MARGINALIA_WIDTH, LedgerSystemLine } from '../sources/components/buzz/Ledger';
import { phraseTurnSilence } from '../../../packages/api-contract/dist/turn-silence.js';
StyleSheet.configure({ themes: { bone: boneTheme, boneSmall: boneSmallTheme, boneLarge: boneLargeTheme, obsidian: obsidianTheme, obsidianSmall: obsidianSmallTheme, obsidianLarge: obsidianLargeTheme }, settings: { initialTheme: 'obsidian' } });

const subject = { kind: 'agent' as const, id: 'ruby', name: '@ruby' };
// The line main posts today, verbatim.
const before = { subject, verb: 'could not answer', consequence:
  'the helper could not authenticate with Claude. If its login expired, its owner can send `@ruby /login` here, or run `beeline connect` on its machine.' };
const phrase = phraseTurnSilence('@ruby', { kind: 'not-signed-in' }, { login: { handle: 'ruby', harness: 'claude' } });
const after = { subject, verb: phrase.verb, consequence: phrase.consequence };
const lineText = (event: typeof before) => `${event.subject.name} ${event.verb} · ${event.consequence}`;

/** Lays the full line out like the row does and reports the line its command ends on. */
function CommandLine({ id, event, command }: { id: string; event: typeof before; command: string }) {
  const { theme } = useUnistyles();
  const [line, setLine] = useState<number | null>(null);
  const text = lineText(event);
  const end = text.indexOf(command) + command.length;
  return <View>
    {/* The row's own text width: the stamp margin sits to its right. */}
    <View style={{ position: 'absolute', opacity: 0, left: 0, right: 0,
      paddingRight: LEDGER_MARGINALIA_WIDTH + theme.buzz.space.sm }} pointerEvents="none">
      <Text style={{ ...theme.buzz.type.meta, fontFamily: theme.buzz.proseRegular }}
        onTextLayout={({ nativeEvent }) => {
          let seen = 0;
          const index = nativeEvent.lines.findIndex((row) => (seen += row.text.length) >= end);
          setLine(index + 1);
        }}>{text}</Text>
    </View>
    <Text style={{ color: theme.buzz.textSecondary }}>{`${id}: ${command} ends on line ${line ?? '?'}`}</Text>
  </View>;
}

function Proof() {
  const [loaded] = useFonts({ 'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf') });
  const { theme } = useUnistyles();
  if (!loaded) return null;
  const label = { color: theme.buzz.textSecondary, marginTop: 24, marginBottom: 8 };
  return <View style={{ flex: 1, backgroundColor: theme.buzz.bgBase, paddingTop: 80, alignItems: 'flex-start' }}>
    {/* A ~390px-wide phone: the row gets the same width the transcript gives it there. */}
    <View style={{ width: 390, paddingHorizontal: 16 }}>
      <View style={{ flexDirection: 'row', gap: 16 }}>
        {['Obsidian', 'Bone'].map((name) => <Pressable key={name} accessibilityLabel={name}
          onPress={() => UnistylesRuntime.setTheme(name.toLowerCase() as 'obsidian' | 'bone')}>
          <Text style={{ color: theme.buzz.textPrimary }}>{name}</Text>
        </Pressable>)}
      </View>
      <Text style={label}>Before</Text>
      <LedgerSystemLine id="before" text="" event={before} stamp="09:41" />
      <CommandLine id="Before" event={before} command="@ruby /login" />
      <Text style={label}>After</Text>
      <LedgerSystemLine id="after" text="" event={after} stamp="09:41" />
      <CommandLine id="After" event={after} command="@ruby login" />
    </View>
  </View>;
}
registerRootComponent(Proof);
