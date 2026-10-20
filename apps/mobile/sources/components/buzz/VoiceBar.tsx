import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HullLivePulse } from './MonoHull';
import { IdentityMark } from './IdentityMark';
import { DictationWaveform } from './DictationWaveform';
import { COMPOSER_GLYPH_SIZE, MicGlyph, StopGlyph } from './MicGlyph';
import type { VoiceCallState } from '@/buzz/use-voice-call';

export function VoiceAgentStrip({ voice }: { voice: VoiceCallState }) {
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.agents}
    contentContainerStyle={styles.agentContent} testID="conversation-target-strip">
    {voice.agents.map(agent => <Pressable key={agent.pubkey} onPress={() => voice.aim(agent.pubkey)}
      accessibilityRole="button" accessibilityLabel={`Speak to ${agent.name}`}
      accessibilityState={{ selected: voice.target === agent.pubkey }} style={styles.agent}>
      <View style={[styles.face, voice.target === agent.pubkey && voice.speaker !== agent.pubkey && styles.selected]}>
        {voice.speaker === agent.pubkey && <HullLivePulse style={styles.speakingPulse}>
          <View style={styles.speakingFrame} testID={`voice-speaking-frame-${agent.pubkey}`} />
        </HullLivePulse>}
        <IdentityMark kind="agent" seed={agent.pubkey} face={agent.face} name={agent.name} size={32} />
      </View>
      <Text numberOfLines={1} style={styles.name}>{agent.name}</Text>
    </Pressable>)}
  </ScrollView>;
}

export function VoiceBar({ voice, testIDPrefix = 'chat' }: {
  voice: VoiceCallState; testIDPrefix?: string;
}) {
  const { theme } = useUnistyles();
  const warning = voice.endingWarning ?? voice.budgetWarning;
  return <>
    <View style={styles.controls} testID="voice-bar">
      <View style={styles.waveform} accessibilityLabel={voice.muted ? 'Microphone muted' : voice.speaker
        ? `${voice.agents.find(a => a.pubkey === voice.speaker)?.name ?? 'Agent'} speaking` : 'Listening'} testID="voice-waveform">
        {warning ? <Text accessibilityLiveRegion="polite" numberOfLines={1}
          style={styles.warning} testID="conversation-tip">{warning}</Text>
          : voice.error ? <Text accessibilityRole="alert" style={styles.error}
            testID={voice.quotaExhausted ? 'voice-quota-error' : 'voice-connection-error'}>{voice.error}</Text>
          : <DictationWaveform key={voice.muted ? 'muted' : 'live'} level={voice.muted ? 0 : voice.level} live={!voice.connecting} flat={voice.muted} />}
      </View>
      <Pressable onPress={() => void voice.toggleMute()} disabled={voice.connecting || voice.quotaExhausted}
        accessibilityLabel={voice.muted ? 'Unmute microphone' : 'Mute microphone'} accessibilityRole="button"
        accessibilityState={{ selected: voice.muted, disabled: voice.connecting || voice.quotaExhausted }}
        hitSlop={9} style={styles.controlSlot} testID={`${testIDPrefix}-mic`}>
        <MicGlyph color={theme.buzz.textPrimary} size={COMPOSER_GLYPH_SIZE} muted={voice.muted} testID={`${testIDPrefix}-mic-glyph`} />
      </Pressable>
      <Pressable onPress={() => void voice.end()} accessibilityRole="button" hitSlop={9}
        accessibilityLabel={voice.humans > 1 ? 'Leave call' : 'End call'} style={styles.controlSlot} testID="voice-mic">
        <StopGlyph color={theme.buzz.textPrimary} filled testID="voice-stop-glyph" />
      </Pressable>
    </View>
  </>;
}

const styles = StyleSheet.create(theme => ({
  agents: { flexGrow: 0, marginBottom: 8 },
  agentContent: { alignItems: 'flex-start', gap: 8 },
  agent: { minWidth: 44, minHeight: 44, maxWidth: 96, alignItems: 'center', gap: 4 },
  face: { padding: 4, borderWidth: 1, borderRadius: 3, borderColor: 'transparent' },
  selected: { borderColor: theme.buzz.voiceSelectionFrame },
  speakingPulse: { ...StyleSheet.absoluteFillObject, pointerEvents: 'none' },
  speakingFrame: { ...StyleSheet.absoluteFillObject, borderWidth: 1, borderRadius: 3, borderColor: theme.buzz.accent },
  name: { ...theme.buzz.type.meta, color: theme.buzz.textMuted },
  controls: { minHeight: 42, flexDirection: 'row', alignItems: 'center', padding: 8 },
  controlSlot: { width: 26, height: 26, marginLeft: 8, alignItems: 'center', justifyContent: 'center' },
  waveform: { flex: 1, minWidth: 0, height: 26, justifyContent: 'center', overflow: 'hidden' },
  warning: { ...theme.buzz.type.body, fontFamily: theme.buzz.proseMedium, color: theme.buzz.accent },
  error: { ...theme.buzz.type.meta, color: theme.buzz.textPrimary },
}));
