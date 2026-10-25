import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { ConversationComposer } from '../sources/components/buzz/ConversationComposer';
import { OrdinaryLedgerMessage } from '../sources/app/(app)/beeline/chat/RoomMessageVariants';
import { ErrorBanner } from '../sources/components/buzz/ErrorBanner';
import { RepositoryChoice } from '../sources/components/buzz/RepositoryChoice';
import { MemberGrantRow } from '../sources/components/buzz/MemberGrantRow';
import { AgentSignInCard } from '../sources/components/buzz/AgentSignInCard';
const noop = () => {};
export function QuietRowActionsScene() {
  const { theme } = useUnistyles();
  const [result, setResult] = useState('Ready');
  const [scene, setScene] = useState(0);
  const hull = theme.buzz;
  const repo = { name: 'beeline-work/beeline' };
  const installation = { installationId: 1, accountLogin: 'beeline-work', status: 'active' } as any;
  return <SafeAreaProvider><KeyboardProvider><ScrollView style={{ flex: 1, backgroundColor: hull.bgBase }} contentContainerStyle={{ padding: 16, paddingTop: 48, gap: 16 }}>
    <View style={{ flexDirection: 'row', gap: 24 }}>
      <Pressable accessibilityLabel="Next scene" onPress={() => setScene((scene + 1) % 4)} style={{ minHeight: 44 }}><Text style={{ color: hull.accent }}>Next scene</Text></Pressable>
      <Pressable accessibilityLabel="Switch theme" onPress={() => UnistylesRuntime.setTheme(UnistylesRuntime.themeName === 'bone' ? 'obsidian' : 'bone')} style={{ minHeight: 44 }}><Text style={{ color: hull.accent }}>Switch theme</Text></Pressable>
    </View>
    <Text style={{ ...hull.type.meta, color: hull.textPrimary }}>{['A1 · failed upload / A2 · delivery recovery', 'B3 · repository alignment', 'B4 · grant details', 'B5 · sign-in card'][scene]}</Text>
    {scene === 0 ? <>
      <ConversationComposer value="" height={26} focused={false} disabled={false} hasAgentMembers speechEnabled={false}
        onBlur={noop} onChangeText={noop} onContentSizeChange={noop} onFocus={noop} onKeyPress={noop} onSend={noop}
        attachments={[{ uri: 'proof.png', name: 'IMG_20261024.png', mimeType: 'image/png', sizeLabel: '4.2 MB', uploadState: 'failed' }]}
        onRetryAttachment={() => setResult('Upload retried')} onRemoveAttachment={() => setResult('Attachment removed')} />
      <OrdinaryLedgerMessage message={{id:'failed-proof',text:'Please check the latest changes.',isUser:true,timestamp:1792872000, pubkey:'b'.repeat(64)} as any}
        participantsHydrated personName="Owner" viewerPubkey={'b'.repeat(64)} speakerWorking={false} continued={false}
        participantHandles={[]} channelIndex={{rooms:[],corners:[]} as any} deliveryFailed announcementFeed
        onChannelReference={noop} onReply={noop} onCopy={noop} onRetry={() => setResult('Delivery retried')} onDismiss={() => setResult('Delivery dismissed')} />
      <View style={{ width: 300 }}><Text style={{ ...hull.type.meta, color: hull.textMuted }}>A5 · desktop sidebar failure</Text><ErrorBanner inline title="Could not load Rooms" onRetry={() => setResult('Rooms retried')} /></View>
      <View style={{ width: 360 }}><Text style={{ ...hull.type.meta, color: hull.textMuted }}>A6 · desktop inspector failure</Text><ErrorBanner inline title="Could not load corner" onRetry={() => setResult('Corner retried')} /></View>
    </> : scene === 1 ? <RepositoryChoice testIDPrefix="proof" busy={false} mode="create" onChooseMode={noop} loading={false} githubConnected onConnect={noop} linkRepo={null} onOpenList={noop} activeInstallations={[installation]} selectedInstallation={installation} onSelectInstallation={noop} ownerMenuOpen={false} setOwnerMenuOpen={noop} createName="beeline" takenRepo={repo as any} onLinkInstead={() => setResult('Repository linked')} /> : scene === 2 ? <MemberGrantRow onRevoke={() => setResult('Grant revoked')} roomName="Beeline" grant={{ grantId: 'proof', kind: 'shared_asset', target: 'package-cache', reason: 'Use a private download cache', status: 'approved', requestedBy: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Jellybean', handle: 'jellybean' }, decidedBy: { pubkey: 'b'.repeat(64), kind: 'human', name: 'Owner' }, roomId: 'proof', createdAt: 1792872000, decidedAt: 1792872000, auto: false, agent: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Jellybean', handle: 'jellybean' } } as any} /> : <AgentSignInCard agentName="Jellybean" isOwner stamp="20:14" onSubmit={async () => {}} card={{ agentId: 'a'.repeat(64), ownerId: 'b'.repeat(64), harness: 'codex', kind: 'device-code', status: 'pending', authorizeUrl: 'https://auth.openai.com/codex/device', userCode: 'K7QH-M2XP', expiresAt: Date.now() + 840000 }} />}
    <Text accessibilityLabel={result} style={{ ...hull.type.meta, color: hull.textPrimary }}>{result}</Text>
  </ScrollView></KeyboardProvider></SafeAreaProvider>;
}
