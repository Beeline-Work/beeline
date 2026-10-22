import React, { useState } from 'react';
import { ScrollView, StatusBar, Text, View } from 'react-native';
import { useFonts } from 'expo-font';
import { GrantRequestCard } from '../sources/components/buzz/GrantRequestCard';
import type { ChatDisplayMessage } from '../sources/buzz/room-view-presentation';
import { beelineThemes } from '../sources/buzz/groknight';
import { proofTheme } from './settings';
const theme = beelineThemes[proofTheme];
const requestedAt = Math.floor(new Date(2026, 9, 22, 16, 42).getTime() / 1000);
const owner = { pubkey: 'owner', kind: 'human' as const, name: 'Owner' };
const script = `from pathlib import Path
import shutil

# Only archived build output is selected.
for build in archived_build_folders:
    shutil.rmtree(build)
`;
export default function ApprovalProof() {
  const [status, setStatus] = useState<'pending' | 'once' | 'approved' | 'denied'>('pending');
  const [fonts] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  const message = { id: 'proof', timestamp: requestedAt, text: '', isUser: false, grantRequest: {
    agent: { pubkey: 'jellybean', kind: 'agent', name: 'Jellybean' }, owner, requester: owner,
    grants: [{ grantId: 'proof', kind: 'command', target: 'python3 /home/lunchbox/cleanup-archived.py',
      purpose: 'Free about 5 GB of disk by deleting old build files in 3 finished corners, so the Android test build can finish. Saved artifacts are kept.',
      reason: 'Make room for the Android build', machine: 'squire', touches: 'Build folders in 3 archived corners', capabilities: 'Delete files',
      status, requestedBy: owner, roomId: 'proof', createdAt: requestedAt, auto: false,
      ...(status === 'pending' ? {} : { decidedBy: owner, decidedAt: requestedAt + 120 }),
      script: { path: '/home/lunchbox/cleanup-archived.py', contents: script, bytes: script.length, sha256: 'a'.repeat(64) },
    }],
  } } as ChatDisplayMessage;
  if (!fonts) return null;
  return <ScrollView style={{ flex: 1, backgroundColor: theme.bgBase }} contentContainerStyle={{ padding: theme.space.md, paddingTop: 64 }}>
    <StatusBar barStyle={proofTheme === 'bone' ? 'dark-content' : 'light-content'} />
    <View style={{ marginBottom: theme.space.lg }}>
      <Text style={{ ...theme.type.hero, color: theme.textPrimary }}>@System</Text>
      <Text style={{ ...theme.type.meta, color: theme.textSecondary }}>Announcements only</Text>
    </View>
    <GrantRequestCard message={message} viewerIsAgent={false} viewerPubkey="owner" viewerRole="owner" actionId={null}
      onDecision={(_, decision) => setStatus(decision === 'deny' ? 'denied' : decision === 'once' ? 'once' : 'approved')} />
  </ScrollView>;
}
