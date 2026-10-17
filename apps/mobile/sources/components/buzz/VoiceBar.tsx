import * as React from 'react';
import { AccessibilityInfo, Pressable, ScrollView, Text, View } from 'react-native';
import { HullModal } from './HullDialog';
import { StyleSheet } from 'react-native-unistyles';
import { IdentityMark } from './IdentityMark';
import { DictationWaveform } from './DictationWaveform';
import { Button } from './Button';
import type { VoiceCallState } from '@/buzz/use-voice-call';

export function VoiceBar({ voice, fullScreen = false, onAttach, attachDisabled = false, testIDPrefix = 'chat' }: {
  voice: VoiceCallState; fullScreen?: boolean; onAttach?: () => void; attachDisabled?: boolean; testIDPrefix?: string;
}) {
  const [expanded, setExpanded] = React.useState(fullScreen);
  const [reduceMotion, setReduceMotion] = React.useState(false);
  React.useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => listener.remove();
  }, []);
  const tip = useVoiceTip(voice);
  const bar = <View style={styles.bar} testID="voice-bar">
    <View style={styles.targetStrip} testID="conversation-target-strip">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.agents}
        contentContainerStyle={styles.agentContent}>
        {voice.agents.map(agent => <Pressable key={agent.pubkey} onPress={() => voice.aim(agent.pubkey)}
          accessibilityRole="button" accessibilityLabel={`Speak to ${agent.name}`}
          accessibilityState={{ selected: voice.target === agent.pubkey }} style={styles.agent}>
          <View style={[styles.halo, { opacity: voice.speaker === agent.pubkey ? reduceMotion ? 0.9 : 0.5 + voice.level * 0.5 : voice.target === agent.pubkey ? 0.5 : 0,
            transform: [{ scale: reduceMotion ? 1 : voice.speaker === agent.pubkey ? 1 + voice.level * 0.12 : 1 }] }]} />
          <IdentityMark kind="agent" seed={agent.pubkey} face={agent.face} name={agent.name} size={32} />
        </Pressable>)}
      </ScrollView>
      {voice.humans > 1 ? <Text style={[styles.modeLabel, styles.tip, tip.flash && styles.tipFlash]} numberOfLines={2}
        accessibilityLiveRegion={tip.flash ? 'polite' : 'none'} testID="conversation-tip">{tip.text}</Text>
        : <Text style={styles.modeLabel} testID="conversation-mode-label">Conversation mode</Text>}
    </View>
    <View style={styles.controls}>
      <Pressable onPress={onAttach} disabled={attachDisabled || !onAttach} accessibilityRole="button"
        accessibilityLabel="Attach photo or document" style={styles.attach} testID={`${testIDPrefix}-attach-button`}>
        <Text style={styles.attachText}>＋</Text>
      </Pressable>
      <Pressable style={styles.waveform} onLongPress={() => setExpanded(true)}
        accessibilityLabel={voice.error ? voice.error : voice.speaker ? `${voice.agents.find(a => a.pubkey === voice.speaker)?.name ?? 'Agent'} speaking` : 'Listening'}
        accessibilityHint="Hold to open full screen" testID="voice-waveform">
        {voice.error ? <Text accessibilityRole="alert" style={styles.error} testID={voice.quotaExhausted ? 'voice-quota-error' : 'voice-connection-error'}>{voice.error}</Text>
          : <DictationWaveform level={voice.level} live={!voice.connecting} />}
      </Pressable>
      <Button label={voice.humans > 1 ? 'Leave call' : 'End call'} variant="secondary" onPress={() => void voice.end()}
        accessibilityLabel={voice.humans > 1 ? 'Leave call' : 'End call'} testID="voice-leave" />
    </View>
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

/** Private, ephemeral feedback for humans connected when the quiet window ended. */
export function VoiceCallEndNotice({ onDismiss }: { onDismiss(): void }) {
  return <View style={styles.notice} testID="voice-call-end-notice">
    <Text style={styles.noticeText} accessibilityLiveRegion="polite">Call ended: no one spoke for 60 seconds</Text>
    <Button label="Dismiss" variant="secondary" onPress={onDismiss} testID="voice-call-end-dismiss" />
  </View>;
}

const TIP_MS = 4_000;
const FLASH_MS = 1_500;

/** With several humans, agents answer only their name or a one-turn tap. */
function useVoiceTip(voice: VoiceCallState) {
  const name = voice.agents[0]?.name ?? 'Agent';
  const tips = [`Start with a name: “${name}, …”`, 'Tap an avatar to talk to it once', 'Talk over an agent to stop it'];
  const [tip, setTip] = React.useState(0);
  const [flash, setFlash] = React.useState(false);
  const shown = voice.humans > 1;
  React.useEffect(() => {
    if (!shown) return;
    setTip(0);
    const timer = setInterval(() => setTip(index => (index + 1) % tips.length), TIP_MS);
    return () => clearInterval(timer);
  }, [shown, tips.length]);
  React.useEffect(() => {
    if (!voice.unaddressed) return;
    setTip(0); setFlash(true);
    const timer = setTimeout(() => setFlash(false), FLASH_MS);
    return () => clearTimeout(timer);
  }, [voice.unaddressed]);
  return { text: tips[tip], flash };
}

const styles = StyleSheet.create(theme => ({
  notice: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8 },
  noticeText: { ...theme.buzz.type.meta, color: theme.buzz.textPrimary, flex: 1 },
  bar: { width: '100%' },
  targetStrip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 8 },
  agents: { flex: 1, minWidth: 0 }, agentContent: { alignItems: 'center' },
  modeLabel: { ...theme.buzz.type.meta, color: theme.buzz.textMuted, textAlign: 'right', flexShrink: 0 },
  tip: { flexShrink: 1, maxWidth: 220 },
  tipFlash: { color: theme.buzz.accent },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8 },
  attach: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  attachText: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  agent: { width: 44, height: 48, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', width: 38, height: 38, borderRadius: 3, borderWidth: 2,
    borderColor: theme.buzz.accent },
  waveform: { flex: 1, minWidth: 32, height: 44, justifyContent: 'center', overflow: 'hidden' },
  fullScreen: { flex: 1, backgroundColor: theme.buzz.bgBase, padding: 16 },
  fullScreenBody: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24 },
  fullScreenAgent: { alignItems: 'center', gap: 16 }, back: { minHeight: 44, justifyContent: 'center' },
  text: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  error: { ...theme.buzz.type.meta, color: theme.buzz.textPrimary },
}));
