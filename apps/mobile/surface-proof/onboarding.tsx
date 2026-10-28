import { ChoiceVideoPreview } from '../sources/components/buzz/ChoiceVideoPreview';
import React from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { TranscriptCard } from '../sources/components/buzz/TranscriptCard';
import { IdentityMark } from '../sources/components/buzz/IdentityMark';
import { beelineThemes } from '../sources/buzz/groknight';

const theme = beelineThemes.bone;
/** Native rendering of the built service snapshots; this is not a real sign-up or upload proof. */
export default function OnboardingProof() {
  const [stage, setStage] = React.useState('welcome');
  const [room, setRoom] = React.useState<any>();
  React.useEffect(() => {
    fetch(`http://127.0.0.1:8127/${stage}.json`).then(response => response.json()).then(setRoom);
  }, [stage]);
  const messages = room?.messages ?? [];
  return <View style={{ flex: 1, paddingTop: 30, backgroundColor: theme.appCanvas }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
      {['welcome', 'repo', 'youtube-preview', 'something-else'].map(name =>
        <Pressable key={name} onPress={() => setStage(name)}><Text style={{ color: theme.textPrimary, padding: 10 }}>{name}</Text></Pressable>)}
    </View>
    <ScrollView key={stage} contentContainerStyle={{ padding: 18, gap: 18 }}>
      <Text style={{ ...theme.type.hero, color: theme.textPrimary }}>#general</Text>
      {messages.filter((message: any) => (message.choice || message.onboarding || !message.systemEvent) && (!message.choice || message.choice.status === 'open')).slice(-5).map((message: any) =>
        <View key={message.id} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <IdentityMark seed={message.author.pubkey} kind={message.author.kind} face={message.author.face} size={26} />
            <Text style={{ ...theme.type.meta, color: theme.textSecondary }}>{message.author.name}</Text>
          </View>
          {!message.choice && message.text ? <Text style={{ ...theme.type.body, color: theme.textPrimary }}>{message.text}</Text> : null}
          {message.choice ? <TranscriptCard tier="ask" title={message.choice.prompt}
            body={message.choice.videoPreview ? <ChoiceVideoPreview {...message.choice.videoPreview} /> : undefined}
            wrapTitle choices={message.choice.options.map((option: any) => ({ id: option.optionId, letter: option.letter, label: option.label,
              consequence: option.consequence === option.label ? '' : option.consequence,
              onPress: () => setStage(option.optionId === 'A' ? 'repo' : option.optionId === 'B' ? 'youtube-preview' : 'something-else') }))}
            actions={[{ label: 'Skip', onPress() {}, dismiss: true }]} /> : null}
          {message.onboarding ? <Text style={{ ...theme.type.body, color: theme.textPrimary }}>Choose or create a repository</Text> : null}
        </View>)}
    </ScrollView>
  </View>;
}
