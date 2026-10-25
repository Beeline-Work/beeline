import React from 'react';
// @ts-expect-error The proof bundles React DOM without its optional declarations.
import { createRoot } from 'react-dom/client';
import { View, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { CoreCardScenes, owner, agent } from './card-button-fixtures';
import { StarPromptCard } from '../sources/components/buzz/StarPromptCard';
import { VoiceCallCard } from '../sources/components/buzz/VoiceCallCard';
import { RepositoryOnboardingCard } from '../sources/app/(app)/beeline/chat/RepositoryOnboardingCard';
import {
  SquireApprovalCard,
  ConnectorOfferCard,
  WritePermissionCard,
} from '../sources/app/(app)/beeline/chat/RoomMessageVariants';
import { ArtifactCard } from '../sources/components/buzz/ArtifactCard';
import {
  ComputerSessionCard,
  ComputerSessionViewer,
} from '../sources/components/buzz/ComputerSession';
// @ts-expect-error Font imports are inlined by the proof bundler.
import regular from '../sources/assets/fonts/SpaceGrotesk-Regular.ttf';
// @ts-expect-error Font imports are inlined by the proof bundler.
import medium from '../sources/assets/fonts/SpaceGrotesk-Medium.ttf';
// @ts-expect-error Font imports are inlined by the proof bundler.
import semibold from '../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf';
// @ts-expect-error Font imports are inlined by the proof bundler.
import mono from '../sources/assets/fonts/IBMPlexMono-Regular.ttf';
const css = document.createElement('style');
css.textContent = [
  ['SpaceGrotesk-Regular', regular],
  ['SpaceGrotesk-Medium', medium],
  ['SpaceGrotesk-SemiBold', semibold],
  ['IBMPlexMono-Regular', mono],
]
  .map(([name, url]) => `@font-face{font-family:${name};src:url(${url})}`)
  .join('');
document.head.appendChild(css);
function Gallery() {
  const { theme } = useUnistyles();
  document.body.style.background = theme.buzz.bgBase;
  const width = Number(new URLSearchParams(location.search).get('width') ?? 411);
  const common = {
    viewerIsAgent: false,
    viewerPubkey: 'owner',
    actionId: null,
    onAccept() {},
    onOpenWorkbench() {},
  };
  return (
    <div style={{ width, padding: 16, boxSizing: 'border-box', color: theme.buzz.textPrimary }}>
      <View style={{ gap: 24 }}>
        <CoreCardScenes />
        <Text>Repository onboarding</Text>
        <RepositoryOnboardingCard
          viewerId="owner"
          author={agent}
          card={
            {
              id: 'repo',
              kind: 'repository',
              status: 'open',
              requesterId: 'owner',
              agentId: 'agent',
              canLink: true,
              installationId: 1,
              githubLinked: true,
              defaultName: 'beeline-demo',
              repositories: [],
            } as any
          }
        />
        <Text>Star prompt</Text>
        <StarPromptCard prompt={{ milestone: 10 } as any} busy={null} onAnswer={() => {}} />
        <Text>Squire approval</Text>
        <SquireApprovalCard
          message={
            {
              timestamp: 100,
              squireApproval: {
                agent,
                owner,
                tool: 'operate_login',
                reason: 'Sign in to GitHub to continue the task.',
                detail: 'Sign in to GitHub',
                approvalUrl: 'https://example.invalid/approval',
                linkKind: 'passkey',
                sourceRoomId: 'r',
                sourceMessageId: 'm',
              },
            } as any
          }
          viewerPubkey="owner"
          onOpenSource={() => {}}
        />
        <Text>Settled permission</Text>
        <WritePermissionCard
          message={
            {
              timestamp: 100,
              writePermission: {
                permissionId: 'p',
                agentPubkey: 'agent',
                agentName: 'Jellybean',
                status: 'allowed',
                subchannelId: 'corner',
                repository: 'Beeline-Work/beeline',
                requesterPubkey: 'owner',
                requesterName: 'Owner',
                cornerId: 'corner',
              },
            } as any
          }
          {...common}
          onDecision={() => {}}
          onOpenCorner={() => {}}
        />
        <Text>Connector</Text>
        <ConnectorOfferCard
          message={
            {
              timestamp: 100,
              connectorOffer: {
                offerId: 'offer',
                agent,
                addressee: owner,
                status: 'connected',
                connectorType: 'trusty-squire',
                connectorName: 'Trusty Squire',
                reason: 'Use your connected service.',
                intent: 'add',
              },
            } as any
          }
          {...common}
        />
        <Text>Artifact</Text>
        <ArtifactCard
          attachment={
            {
              name: 'audit.zip',
              title: 'Audit files',
              mimeType: 'text/plain',
              size: 1200,
              url: 'https://example.invalid/audit.zip',
            } as any
          }
        />
        <Text>Browser card</Text>
        <ComputerSessionCard
          session={
            {
              id: 'computer',
              title: 'GitHub setup',
              status: 'live',
              url: 'https://example.invalid/browser',
              access: 'fixture',
            } as any
          }
        />
        <Text>Browser controls</Text>
        <View style={{ height: 180 }}>
          <ComputerSessionViewer
            session={
              {
                id: 'computer',
                title: 'GitHub setup',
                status: 'live',
                url: 'https://example.invalid/browser',
                access: 'fixture',
              } as any
            }
            onClose={() => {}}
          />
        </View>
        <Text>Voice call</Text>
        <VoiceCallCard
          call={{ id: 'call', startedAt: Date.now() / 1000 - 60, participants: [] } as any}
          joined={false}
          onJoin={() => {}}
        />
      </View>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Gallery />);
setTimeout(() => {
  const root = document.getElementById('root')!;
  document.getElementById('result')!.textContent = JSON.stringify({
    text: root.textContent,
    height: root.scrollHeight,
    errors: (window as any).__console,
  });
}, 1500);
