import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { View, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { CommunitySwitcherTrigger } from '../sources/components/buzz/CommunityRail';
import { WorkspaceActionsMenu } from '../sources/components/buzz/WorkspaceActionsMenu';
import { RoomDeckComposeMenu } from '../sources/components/buzz/RoomDeckComposeMenu';
import { RoomListToolbar } from '../sources/components/buzz/RoomListToolbar';
import { ConversationRow } from '../sources/components/buzz/ConversationRow';
import { RoomCornerSummary } from '../sources/components/buzz/RoomCornerSummary';
import { RoomListSectionHeader } from '../sources/components/buzz/RoomListSectionHeader';
import { DesktopRoomCorners } from '../sources/components/buzz/DesktopRoomCorners';
import { filterConversations, type RoomListFilter } from '../sources/buzz/room-list-preferences';
import type { ChatListItem } from '@beeline/buzz-client';

const now = Date.now();
const rooms = [
  [
    'product',
    'Product',
    'emberus',
    'The new Room list is ready for your review. The waiting corners are listed below.',
    true,
    5,
    2,
  ],
  [
    'launch',
    'Launch planning',
    'johnny',
    'I have updated the checklist for Friday. Can you check the final copy?',
    true,
    1,
    0,
  ],
  [
    'engineering',
    'Engineering',
    'you',
    'The changes are in. Tests passed and the release notes are ready.',
    false,
    0,
    0,
  ],
  [
    'design',
    'Design notes',
    'bbc',
    'A quieter header gives the conversations more room to breathe.',
    false,
    0,
    0,
  ],
  ['mina', 'Mina', 'mina', 'See you tomorrow. I will bring the updated sketches.', true, 0, 0],
].map(([id, name, author, text, unread, cornerCount, waitingCornerCount], i) => ({
  room: { id, name, updatedAt: now / 1000 - (i + 1) * 120 },
  unread,
  cornerCount,
  waitingCornerCount,
  latestMessage: {
    text,
    createdAt: now / 1000 - (i + 1) * 120,
    author: { pubkey: author, name: author, handle: author },
  },
  ...(id === 'mina'
    ? { directMessage: { peer: { pubkey: 'mina', name: 'Mina', kind: 'human' } } }
    : {}),
})) as ChatListItem[];
const states = ['waiting', 'waiting', 'working', 'review', 'idle'];
const client = {
  corners: async (roomId: string) => ({
    corners: (roomId === 'launch' ? ['working'] : states).map((state, i) => ({
      corner: {
        id: `corner-${i}`,
        name: [
          'Preview layout',
          'Release copy',
          'Navigation tests',
          'Mobile polish',
          'Next iteration',
        ][i],
      },
      state,
      lifecycle: { lifecycle: 'open', checks: 'unknown' },
    })),
  }),
};
function Proof() {
  const { theme } = useUnistyles();
  const t = theme.buzz;
  const desktop = innerWidth >= 768;
  const [filter, setFilter] = useState<RoomListFilter>('all');
  const [query, setQuery] = useState('');
  const [pinned, setPinned] = useState<string[]>([]);
  const [destination, setDestination] = useState('');
  const searchRef = React.useRef(null);
  const visibleRooms = filterConversations(rooms, query, filter, pinned);
  const action = (value: string) => {
    setDestination(value);
    (window as any).__destination = value;
  };
  return (
    <View style={{ minHeight: '100vh' as any, backgroundColor: t.bgBase, flexDirection: 'row' }}>
      <View
        style={{
          width: desktop
            ? Number(new URLSearchParams(location.search).get('navWidth') ?? 360)
            : '100%',
          borderRightWidth: 1,
          borderRightColor: t.border,
        }}
      >
        <View
          style={{
            minHeight: 62,
            paddingHorizontal: 16,
            flexDirection: 'row',
            alignItems: 'center',
            borderBottomWidth: 1,
            borderBottomColor: t.border,
          }}
        >
          <CommunitySwitcherTrigger
            community={{ communityId: 'tubing', name: 'Tubing crew' }}
            expanded={false}
            onPress={() => action('workspaces')}
          />
          <WorkspaceActionsMenu
            onMembers={() => action('members')}
            onSettings={() => action('workspace-settings')}
          />
          <RoomDeckComposeMenu header onSelect={(value) => action(value)} />
        </View>
        <RoomListToolbar
          desktop={desktop}
          searchRef={searchRef}
          filter={filter}
          onFilter={setFilter}
          query={query}
          onQuery={setQuery}
          counts={{
            all: rooms.length,
            unread: rooms.filter((item) => item.unread).length,
            pinned: pinned.length,
          }}
          onBookmarks={() => action('bookmarks')}
        />
        {desktop && visibleRooms.some((item) => !item.directMessage) && (
          <RoomListSectionHeader title="Rooms" />
        )}
        {visibleRooms.map((item) => (
          <View key={item.room.id} style={{ borderBottomWidth: 1, borderBottomColor: t.border }}>
            {item.directMessage && <RoomListSectionHeader title="Messages" />}
            <ConversationRow
              item={item}
              viewer="you"
              now={now}
              selected={desktop && item.room.id === 'product'}
              desktop={desktop}
              pinned={pinned.includes(item.room.id)}
              onPress={() => action(`room/${item.room.id}`)}
              onPin={() =>
                setPinned((ids) =>
                  ids.includes(item.room.id)
                    ? ids.filter((id) => id !== item.room.id)
                    : [...ids, item.room.id],
                )
              }
              testID={`room-${item.room.id}`}
            />
            {!!item.cornerCount &&
              (desktop ? (
                <DesktopRoomCorners
                  active={item.room.id === 'product'}
                  item={item}
                  client={client as any}
                  refreshKey="proof"
                  onOpen={(id) => action(`corner/${id}`)}
                  renderDrag={(_, children) => children}
                />
              ) : (
                <RoomCornerSummary
                  count={item.cornerCount}
                  waiting={(item as any).waitingCornerCount}
                  onPress={() => action(`corners/${item.room.id}`)}
                  testID={`corners-${item.room.id}`}
                />
              ))}
          </View>
        ))}
      </View>
      {desktop && (
        <View style={{ flex: 1, padding: 40 }}>
          <Text style={{ ...t.type.body, color: t.textPrimary }}>Room-list component proof</Text>
          <Text style={{ ...t.type.meta, color: t.ledgerQuiet, marginTop: 16 }}>
            Real app components with fixture data. Transcript is outside this proof.
          </Text>
          <Text testID="destination" style={{ ...t.type.body, color: t.accent, marginTop: 24 }}>
            {destination}
          </Text>
        </View>
      )}
    </View>
  );
}
createRoot(document.getElementById('root')!).render(<Proof />);
