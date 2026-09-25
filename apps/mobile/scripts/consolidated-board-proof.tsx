import { HumanProfile } from '../sources/app/(app)/beeline/human-profile';
import BuzzMembers from '../sources/app/(app)/beeline/members';
import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { View, Text } from 'react-native';
import { PinnedConversationsEmpty } from '../sources/components/buzz/PinnedConversationsEmpty';
import { AgentProfileView } from '../sources/components/buzz/AgentProfileView';
import { ConversationRow } from '../sources/components/buzz/ConversationRow';
import { DesktopWorkspaceStrip } from '../sources/components/buzz/DesktopWorkspaceStrip';
import { CommunityRail } from '../sources/components/buzz/CommunityRail';
import { RoomListToolbar } from '../sources/components/buzz/RoomListToolbar';
import { beelineThemes } from '../sources/buzz/groknight';
import type { AgentDetailView, ChatListItem } from '@beeline/buzz-client';
// @ts-expect-error esbuild embeds the font as a data URL.
import font from '../sources/assets/fonts/SpaceGrotesk-Regular.ttf';

// @ts-expect-error esbuild embeds font assets.
import medium from '../sources/assets/fonts/SpaceGrotesk-Medium.ttf';
// @ts-expect-error esbuild embeds font assets.
import bold from '../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf';
// @ts-expect-error esbuild embeds font assets.
import mono from '../sources/assets/fonts/IBMPlexMono-Regular.ttf';

const params = new URLSearchParams(location.search);
const theme = beelineThemes[params.get('theme') === 'light' ? 'bone' : 'obsidian'];
const mode = params.get('view') ?? 'list';
const desktop = innerWidth >= 900;
const style = document.createElement('style');
style.textContent = `@font-face{font-family:SpaceGrotesk-Regular;src:url(${font})}@font-face{font-family:SpaceGrotesk-Medium;src:url(${medium})}@font-face{font-family:SpaceGrotesk-SemiBold;src:url(${bold})}@font-face{font-family:IBMPlexMono-Regular;src:url(${mono})}body{margin:0;background:${theme.bgBase};color:${theme.textPrimary}}*{box-sizing:border-box}#root{height:100vh;display:flex}button:focus-visible,[role=button]:focus-visible{outline:2px solid ${theme.accent};outline-offset:2px}`;
document.head.appendChild(style);
const agent = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  agent: {
    identity: {
      pubkey: 'e'.repeat(64),
      kind: 'agent',
      name: 'Emberus',
      handle: 'emberus',
      face: 'owl',
    },
    role: 'member',
  },
  selected: { model: 'gpt-6', effort: 'high' },
  catalog: [
    { id: 'model', category: 'model', options: [{ id: 'gpt-6', name: 'GPT-6' }] },
    { id: 'effort', category: 'reasoning_effort', options: [{ id: 'high', name: 'High' }] },
  ],
  recentWork: params.has('empty')
    ? []
    : [{ title: 'Illustrative merged pull request', url: 'https://github.com/acme/repo/pull/1' }],
  watchFilters: [],
} as AgentDetailView;
const workspaces = [
  { id: agent.workspaceId, name: 'Tubing Crew' },
  { id: 'second', name: 'Acme' },
];
const item = (id: string, unread: boolean): ChatListItem =>
  ({
    room: { id, name: id, workspaceId: agent.workspaceId, updatedAt: 1000 },
    unread,
    latestMessage: {
      id: 'message',
      text: 'Morning tally: yesterday’s merged work is ready to review.',
      content: 'Morning tally: yesterday’s merged work is ready to review.',
      createdAt: 1000,
      author: { pubkey: 'c'.repeat(64), name: 'Candy', handle: 'candy', kind: 'agent' },
    },
  }) as unknown as ChatListItem;
const viewer = { pubkey: 'b'.repeat(64), kind: 'human', name: 'Viewer' };
const owner = params.get('role') !== 'admin';
Object.assign(agent, {
  owner: { id: viewer.pubkey, name: 'Owner', handle: 'owner' },
  access: {
    policy: 'everyone',
    canChange: owner,
    owner: { id: owner ? viewer.pubkey : 'a'.repeat(64), name: 'Owner', handle: 'owner' },
  },
  yolo: { enabled: true, canChange: owner },
  seededSoul: 'A minor god from a faraway star. Kind, proactive, and drawn to distant worlds.',
});
Object.assign(globalThis, {
  __boardFixture: {
    agent,
    identity: { publicKey: viewer.pubkey },
    workspace: {
      workspace: { id: agent.workspaceId, name: 'Tubing Crew' },
      viewer: { identity: viewer, role: 'admin', permissions: { manage: true } },
      members: [
        {
          identity: {
            pubkey: 'h'.repeat(64),
            kind: 'human',
            name: 'River',
            handle: 'river',
            face: 'fox',
          },
          role: 'member',
        },
      ],
      agents: [agent.agent],
      watchFilters: [],
    },
  },
});
function App() {
  const [filter, setFilter] = useState<'all' | 'unread' | 'pinned' | 'messages'>(
    mode === 'pinned' ? 'pinned' : 'all',
  );
  const [unread, setUnread] = useState(true);
  const [profile, setProfile] = useState(mode === 'profile' || mode === 'human');
  const [query, setQuery] = useState('');
  const rows = (
    <>
      <RoomListToolbar
        filter={filter}
        onFilter={setFilter}
        query={query}
        onQuery={setQuery}
        counts={{ all: 3, unread: unread ? 1 : 0, pinned: 0 }}
      />
      {filter === 'pinned' ? (
        <PinnedConversationsEmpty onShowAll={() => setFilter('all')} desktop={desktop} />
      ) : (
        ['beeline', 'trusty-squire', 'milo']
          .filter((id) => id.includes(query))
          .map((id, index) => (
            <ConversationRow
              key={id}
              item={item(id, index === 0 && unread)}
              now={1000}
              onPress={() => setUnread(false)}
              onPin={() => setFilter('pinned')}
              desktop={desktop}
              testID={`proof-room-${id}`}
            />
          ))
      )}
    </>
  );
  const profileView = (
    <AgentProfileView
      detail={agent}
      loading={false}
      error={null}
      onRetry={() => undefined}
      onClose={() => setProfile(false)}
      onMessage={() => setProfile(false)}
      canManage={false}
      canEdit={owner}
      avatarDisabled={false}
      onGenerateAvatar={async () => undefined}
      refreshAgent={async () => agent}
      editing={false}
      saving={false}
      nameDraft=""
      soulDraft=""
      onNameChange={() => undefined}
      onSoulChange={() => undefined}
      onEdit={() => undefined}
      onSave={() => undefined}
      onCancel={() => undefined}
      soul="A minor god from a faraway star, born when Heimdal’s sword smote spacetime. Kind, proactive, and drawn to the birth and decay of distant worlds."
      management={null}
    />
  );
  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      {desktop ? (
        <DesktopWorkspaceStrip
          workspaces={workspaces as any}
          activeWorkspaceId={agent.workspaceId}
          viewerName="Viewer"
          viewerPubkey="viewer"
          onSelect={() => undefined}
          onAdd={() => undefined}
          onAccount={() => undefined}
        />
      ) : !profile && mode !== 'pinned' ? (
        <View style={{ width: 72 }}>
          <CommunityRail
            communities={workspaces.map((w) => ({ communityId: w.id, name: w.name }))}
            activeCommunityId={agent.workspaceId}
            onSelect={() => undefined}
            onAdd={() => undefined}
            onSettings={() => undefined}
            viewerPubkey="viewer"
          />
        </View>
      ) : null}
      {(!profile || desktop) && (
        <View
          style={{
            width: desktop ? 340 : undefined,
            flex: desktop ? undefined : 1,
            borderRightWidth: desktop ? 1 : 0,
            borderColor: theme.border,
          }}
        >
          <View style={{ minHeight: 80, justifyContent: 'center', padding: 16 }}>
            <Text style={{ ...theme.type.bodyStrong, color: theme.textPrimary }}>Tubing Crew</Text>
          </View>
          {rows}
        </View>
      )}
      {desktop && (
        <View style={{ flex: 1, padding: 24 }}>
          <Text
            style={{ ...theme.type.bodyStrong, color: theme.textPrimary }}
            onPress={() => setProfile(true)}
          >
            Emberus
          </Text>
          <Text style={{ ...theme.type.body, color: theme.textSecondary, marginTop: 24 }}>
            Illustrative transcript. The profile opens alongside this conversation.
          </Text>
        </View>
      )}
      {profile && (
        <View style={{ width: desktop ? 380 : undefined, flex: desktop ? undefined : 1 }}>
          {mode === 'human' ? (
            <HumanProfile
              workspaceId={agent.workspaceId}
              memberId={'h'.repeat(64)}
              onClose={() => setProfile(false)}
            />
          ) : (
            profileView
          )}
        </View>
      )}
    </View>
  );
}
createRoot(document.getElementById('root')!).render(
  mode === 'manage' ? (
    <BuzzMembers
      profileAgentId={agent.agent.identity.pubkey}
      workspaceIdOverride={agent.workspaceId}
      onClose={() => undefined}
    />
  ) : (
    <App />
  ),
);
