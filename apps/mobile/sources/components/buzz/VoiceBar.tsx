import * as React from 'react';
import { AccessibilityInfo, Pressable, ScrollView, Text, View } from 'react-native';
import { HullModal } from './HullDialog';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { IdentityMark } from './IdentityMark';
import { MicGlyph } from './MicGlyph';
import { DictationWaveform } from './DictationWaveform';
import { BeelineMarkSpinner } from './BeelineMarkSpinner';
import type { VoiceCallState } from '@/buzz/use-voice-call';

/** Pass 08: one 56px row; no status/name row or second end control. */
export function VoiceBar({ voice, fullScreen = false }: { voice: VoiceCallState; fullScreen?: boolean }) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = React.useState(fullScreen);
  const [reduceMotion, setReduceMotion] = React.useState(false);
  React.useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => listener.remove();
  }, []);
  const bar = <View style={styles.bar} testID="voice-bar">
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.agents, voice.quotaExhausted && styles.quotaAgents]}
      contentContainerStyle={styles.agentContent}>
      {voice.agents.map(agent => <Pressable key={agent.pubkey} onPress={() => voice.aim(agent.pubkey)}
        accessibilityRole="button" accessibilityLabel={`Speak to ${agent.name}`}
        accessibilityState={{ selected: voice.target === agent.pubkey }} style={styles.agent}>
        <View style={[styles.halo, { opacity: voice.speaker === agent.pubkey ? reduceMotion ? 0.9 : 0.5 + voice.level * 0.5 : voice.target === agent.pubkey ? 0.5 : 0,
          transform: [{ scale: reduceMotion ? 1 : voice.speaker === agent.pubkey ? 1 + voice.level * 0.12 : 1 }] }]} />
        <IdentityMark kind="agent" seed={agent.pubkey} face={agent.face} name={agent.name} size={32} />
      </Pressable>)}
    </ScrollView>
    <Pressable style={styles.waveform} onLongPress={() => setExpanded(true)}
      accessibilityLabel={voice.quotaExhausted ? voice.error ?? 'Daily voice limit reached' : voice.speaker ? `${voice.agents.find(a => a.pubkey === voice.speaker)?.name ?? 'Agent'} speaking` : 'Listening'}
      accessibilityHint="Hold to open full screen" testID="voice-waveform">
      {voice.quotaExhausted ? <Text accessibilityRole="alert" style={styles.error} testID="voice-quota-error">{voice.error}</Text>
        : <DictationWaveform level={voice.level} live={!voice.connecting} />}
    </Pressable>
    <Pressable onPress={() => void voice.end()} accessibilityRole="button" accessibilityLabel="End voice mode"
      accessibilityState={{ selected: true, busy: voice.connecting }} style={styles.mic} testID="voice-mic">
      {voice.connecting ? <BeelineMarkSpinner ink={theme.buzz.accent} live /> : <MicGlyph color={theme.buzz.accent} />}
    </Pressable>
  </View>;
  return <>
    {bar}
    <HullModal visible={expanded} onRequestClose={() => setExpanded(false)} placement="fill" animationType="fade">
      <View style={styles.fullScreen}>
        <Pressable onPress={() => setExpanded(false)} accessibilityRole="button" style={styles.back}><Text style={styles.text}>Back to Room</Text></Pressable>
        <View style={styles.fullScreenBody}>{voice.agents.map(agent => <Pressable key={agent.pubkey} onPress={() => voice.aim(agent.pubkey)}
          accessibilityLabel={`Speak to ${agent.name}`} style={styles.fullScreenAgent}>
          <IdentityMark kind="agent" seed={agent.pubkey} name={agent.name} face={agent.face} size={96} />
          <Text style={styles.text}>{agent.name}</Text>
        </Pressable>)}</View>
        {bar}
      </View>
    </HullModal>
  </>;
}

const styles = StyleSheet.create(theme => ({
  bar: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 8, width: '100%' },
  agents: { flexGrow: 0, maxWidth: '55%' }, agentContent: { alignItems: 'center' },
  quotaAgents: { maxWidth: '25%' },
  agent: { width: 44, height: 48, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', width: 38, height: 38, borderRadius: 3, borderWidth: 2,
    borderColor: theme.buzz.accent },
  waveform: { flex: 1, minWidth: 32, height: 44, justifyContent: 'center', overflow: 'hidden' },
  mic: { width: 44, height: 44, borderRadius: 3, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.buzz.bgPressed },
  fullScreen: { flex: 1, backgroundColor: theme.buzz.bgBase, padding: 16 },
  fullScreenBody: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24 },
  fullScreenAgent: { alignItems: 'center', gap: 16 }, back: { minHeight: 44, justifyContent: 'center' },
  text: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  error: { ...theme.buzz.type.meta, color: theme.buzz.textPrimary },
}));
