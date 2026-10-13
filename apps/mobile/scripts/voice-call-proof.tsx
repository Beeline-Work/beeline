import * as React from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import { VoiceCallCard } from '../sources/components/buzz/VoiceCallCard';
import { IdentityMark } from '../sources/components/buzz/IdentityMark';
import { useVoiceCall } from '../sources/buzz/use-voice-call';
import { groknight } from '../sources/buzz/groknight';
import type { RoomView, VoiceCall } from '@beeline/api-contract/phone';
import { monolithSession } from '@/auth/monolith-session';

declare global { interface Window { __voiceProof: { origin: string; roomId: string; token: string }; } }

function Proof() {
  const config = window.__voiceProof;
  const voice = useVoiceCall(config.roomId, true);
  const [room, setRoom] = React.useState<RoomView | null>(null);
  const [value, setValue] = React.useState('');
  React.useEffect(() => {
    const update = async () => {
      const response = await monolithSession.fetch(`${config.origin}/v1/phone/rooms/${config.roomId}`);
      if (response.ok) setRoom(await response.json());
    };
    void update(); const timer = setInterval(() => { void update(); }, 500); return () => clearInterval(timer);
  }, [config]);
  return <View style={{ width: 412, height: 820, backgroundColor: groknight.bgBase, padding: 16 }}>
    <View style={{ height: 48, borderBottomWidth: 1, borderColor: groknight.border, justifyContent: 'center' }}>
      <Text style={{ ...groknight.type.bodyStrong, color: groknight.textPrimary }}># Voice proof</Text>
    </View>
    <View style={{ flex: 1, gap: 16, paddingTop: 24, overflow: 'auto' as 'hidden' }} testID="voice-proof-transcript">
      {room?.messages.map(message => message.voiceCall ? <VoiceCallCard key={message.id} call={message.voiceCall as VoiceCall}
        agents={room.members.filter(member => member.identity.kind === 'agent').map(member => member.identity)}
        joined={voice.call?.id === message.voiceCall.id} onJoin={() => void voice.join()} /> :
        <View key={message.id} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <IdentityMark kind={message.author.kind} seed={message.author.pubkey} name={message.author.name} face={message.author.face} size={24} />
            <Text style={{ ...groknight.type.meta, color: groknight.ledgerQuiet }}>{message.author.name}</Text>
          </View>
          <Text style={{ ...groknight.type.body, color: groknight.textPrimary }}>{message.text}</Text>
        </View>)}
    </View>
    {voice.error && <Text accessibilityRole="alert" style={{ ...groknight.type.meta, color: groknight.textPrimary }}>{voice.error}</Text>}
    <ConversationComposer voice={voice} value={value} height={26} focused={false} disabled={false}
      onBlur={() => {}} onChangeText={setValue} onContentSizeChange={() => {}} onFocus={() => {}}
      onKeyPress={() => {}} onSend={() => {}} />
    <Text style={{ ...groknight.type.meta, color: groknight.ledgerQuiet }} testID="voice-proof-latency">
      {voice.firstAudioMs === null ? '' : `Server first audio: ${Math.round(voice.firstAudioMs)} ms`}
    </Text>
  </View>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
