/** Native regression fixture: shipped status components over a scrolled transcript. */
import React, { useRef, useState } from 'react';
import { FlatList, Pressable, StatusBar, Text, View } from 'react-native';
import { useFonts } from 'expo-font';
import { KeyboardAvoidingView, KeyboardProvider, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { composerBottomPadding } from '../sources/buzz/composer-keyboard';
import { UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { TurnBandSlot, TurnProgressLine, TurnSettledLine } from '../sources/components/buzz/TurnProgressLine';
import { RoomCatchUpControls } from '../sources/components/buzz/RoomCatchUpControls';
import { roomBottomChromeStyles } from '../sources/buzz/room-bottom-chrome';
import { selectComposerAckPresentation } from '../sources/buzz/room-indicators';
import { ConversationComposer, COMPOSER_SINGLE_LINE_INPUT_HEIGHT } from '../sources/components/buzz/ConversationComposer';

export default function StatusBandNativeProof() {
  return <SafeAreaProvider><KeyboardProvider preload={false}><StatusBandScene /></KeyboardProvider></SafeAreaProvider>;
}

function StatusBandScene() {
  const composer = useRef<View>(null);
  const insets = useSafeAreaInsets();
  const { progress } = useReanimatedKeyboardAnimation();
  const bottomInset = useAnimatedStyle(() => ({
    paddingBottom: composerBottomPadding('android', insets.bottom, progress.value),
  }));
  const { theme } = useUnistyles();
  const hull = theme.buzz;
  const chrome = roomBottomChromeStyles(hull);
  const [topInset, setTopInset] = useState(0);
  const [jumps, setJumps] = useState(0);
  const [state, setState] = useState('working');
  const [queued, setQueued] = useState(false);
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [startedAt] = useState(() => Math.floor(Date.now() / 1000) - 42);
  const turn = { agentPubkey: 'ruby', requestId: 'first-message', status: 'working' as const, createdAt: startedAt };
  const activeAgentTurns = state === 'working' ? [turn] : [];
  const ack = selectComposerAckPresentation({
    isCorner: false, activeTurnPubkey: activeAgentTurns[0]?.agentPubkey,
    activeTurnStartedAt: startedAt, activeTurnRequestId: activeAgentTurns[0]?.requestId,
    now: Date.now(), conversationIdentities: new Map([['ruby', { pubkey: 'ruby', kind: 'agent', name: 'Ruby', handle: 'ruby' }]]),
  });
  const [fonts] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!fonts) return null;
  return <KeyboardAvoidingView behavior="translate-with-padding" style={{ flex: 1, backgroundColor: hull.bgTerminal }}>
    <StatusBar barStyle={theme.dark ? 'light-content' : 'dark-content'} />
    <View style={{ paddingTop: StatusBar.currentHeight ?? 24, paddingHorizontal: 16, paddingBottom: 8 }}>
      <Text style={{ ...hull.type.body, color: hull.textPrimary }}>#issues-triage · native status proof · jumps {jumps}</Text>
      <View style={{ flexDirection: 'row', gap: 16 }}>
        {['working', 'pending', 'settled', 'idle'].map(s => <Pressable key={s} onPress={() => { setState(s); setQueued(false); }}><Text style={{ ...hull.type.machine, color: hull.accent }}>{s}</Text></Pressable>)}
      </View>
      <Pressable onPress={() => UnistylesRuntime.setTheme(UnistylesRuntime.themeName === 'bone' ? 'obsidian' : 'bone')}><Text style={{ ...hull.type.machine, color: hull.accent }}>Switch theme</Text></Pressable>
      <Pressable onPress={() => setQueued(true)}><Text style={{ ...hull.type.machine, color: hull.accent }}>Queue second message{queued ? ' · queued' : ''}</Text></Pressable>
    </View>
    <View style={{ flex: 1 }}>
      <FlatList inverted data={Array.from({ length: 160 }, (_, i) => i)} keyExtractor={String}
        contentContainerStyle={{ paddingTop: 36 }}
        renderItem={({ item }) => <Text style={{ ...hull.type.body, color: hull.textPrimary, paddingHorizontal: 8 }}>Transcript {item} HHHHHHHHHHHHHHHHHHHHHHHHHHH</Text>} />
      <RoomCatchUpControls corner={false} badgeCount={3} discVisible bottomInset={topInset}
        onJumpToNewest={() => setJumps(count => count + 1)} />
    </View>
    <View style={chrome.stack}>
      <TurnBandSlot testID="hanging-turn-chrome" onTopInset={setTopInset}>
        {ack ? <TurnProgressLine label={ack.label} startedAt={ack.startedAt} /> : null}
        {state === 'settled' ? <TurnSettledLine line="Ruby finished · 42s" /> : null}
      </TurnBandSlot>
      <Animated.View ref={composer} style={[chrome.composerRow, bottomInset]}
        onLayout={() => requestAnimationFrame(() => composer.current?.measureInWindow((x, y, width, height) => {
          console.log('STATUS_PROOF_COMPOSER', JSON.stringify({ x, y, width, height, canvas: hull.bgTerminal }));
        }))}>
        <ConversationComposer value={value} height={COMPOSER_SINGLE_LINE_INPUT_HEIGHT} focused={focused}
          disabled={false} speechEnabled={false} onChangeText={setValue} onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)} onContentSizeChange={() => undefined} onKeyPress={() => undefined}
          onSend={() => { setQueued(true); setValue(''); }} testIDPrefix="proof-composer" />
      </Animated.View>
    </View>
  </KeyboardAvoidingView>;
}
