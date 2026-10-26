import React from 'react';
import { View, Text, ScrollView, Pressable, Image, Share } from 'react-native';
import { TranscriptCard } from '../sources/components/buzz/TranscriptCard';

import { RunnableArtifact } from '../sources/components/buzz/RunnableArtifact';
import { beelineThemes } from '../sources/buzz/groknight';
const theme = beelineThemes.bone;
export default function OnboardingProof() {
  const [WebView, setWebView] = React.useState<any>();
  React.useEffect(() => { import('react-native-webview').then(module => setWebView(() => module.WebView)); }, []);
  const [stage, setStage] = React.useState('welcome');
  const [room, setRoom] = React.useState<any>();
  const [viewer, setViewer] = React.useState(false);
  const [faces, setFaces] = React.useState<Record<string,string>>({});
  React.useEffect(() => { fetch('http://127.0.0.1:8127/faces.json').then(r => r.json()).then(setFaces); }, []);
  const IdentityMark = ({ seed, size }: {seed: string; size: number; [key:string]: any}) => <Image source={{uri: faces[seed]}} style={{width:size,height:size}} />;
  React.useEffect(() => { if (stage === 'dashboard') return; fetch(`http://127.0.0.1:8127/${stage}.json`).then(r => r.json()).then(setRoom); }, [stage]);
  const allMessages = room?.messages ?? [];
  const messages = stage === 'game' ? allMessages.filter((message: any) => message.attachments?.length || message.choice?.status === 'open') : stage === 'explanation' ? allMessages.filter((message: any) => message.text.startsWith('Most AI apps') || message.choice?.status === 'open') : allMessages;
  const attachment = messages.flatMap((message: any) => message.attachments ?? [])[0];
  if (stage === 'dashboard' && WebView) return <View style={{flex:1,paddingTop:30}}><Pressable onPress={() => setStage('welcome')}><Text style={{padding:14}}>Dashboard companion preview · Close</Text></Pressable><WebView source={{uri:'http://127.0.0.1:8127/dashboard.html'}} /></View>;
  if (viewer && attachment) return <View style={{ flex: 1, paddingTop: 28 }}><Pressable onPress={() => setViewer(false)}><Text style={{ padding: 16 }}>Close game</Text></Pressable><RunnableArtifact attachment={attachment} /></View>;
  return <View style={{ flex: 1, paddingTop: 30, backgroundColor: theme.appCanvas }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{['welcome','explanation','game','invite','dashboard'].map(name => <Pressable key={name} onPress={() => setStage(name)}><Text style={{ color: theme.textPrimary, padding: 10 }}>{name}</Text></Pressable>)}</View>
    <ScrollView key={stage} contentContainerStyle={{ padding: 18, gap: 18 }}>
      <Text style={{ ...theme.type.hero, color: theme.textPrimary }}>#general</Text>
      {stage === 'invite' ? <Pressable onPress={async () => { const share = await fetch('http://127.0.0.1:8127/share.json').then(r => r.json()); await Share.share({message:share.message}); }}><Text style={{...theme.type.body,color:theme.accent}}>Share this chat</Text></Pressable> : null}
      {messages.filter((message: any) => message.choice?.status === 'open' || (!message.choice && !message.systemEvent)).slice(-5).map((message: any) => <View key={message.id} style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><IdentityMark seed={message.author.pubkey} kind={message.author.kind} face={message.author.face} size={26} /><Text style={{ ...theme.type.meta, color: theme.textSecondary }}>{message.author.name}</Text></View>
        {!message.choice && message.text ? <Text style={{ ...theme.type.body, color: theme.textPrimary }}>{message.text}</Text> : null}
        {message.choice ? <TranscriptCard tier="ask" title={message.choice.prompt} identity={<IdentityMark seed={message.choice.agent.pubkey} kind="agent" face={message.choice.agent.face} size={26} />} wrapTitle choices={message.choice.options.map((option: any) => ({ id: option.optionId, letter: option.letter, label: option.label, consequence: option.consequence, onPress: () => setStage(option.optionId === 'D' ? 'explanation' : 'game') }))} actions={[{ label: 'Skip', onPress() {}, dismiss: true }]} /> : null}
        {message.attachments?.length && WebView ? <View style={{height:220}}><WebView source={{uri:'http://127.0.0.1:8127/game.html'}} javaScriptEnabled={false} /></View> : null}
        {message.attachments?.length ? <Pressable onPress={() => setViewer(true)}><Text style={{ ...theme.type.body, color: theme.accent }}>Tic-tac-toe · Open</Text></Pressable> : null}
      </View>)}
    </ScrollView>
  </View>;
}
