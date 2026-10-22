import React, { useState } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Button } from '../../sources/components/buzz/Button';
import { MembersAgentsGlyph } from '../../sources/components/buzz/MembersAgentsGlyph';
import { TrayGlyph } from '../../sources/components/buzz/TrayGlyph';
import { RoomListToolbar } from '../../sources/components/buzz/RoomListToolbar';
import { RoomListSectionHeader } from '../../sources/components/buzz/RoomListSectionHeader';
import { SettingsRow } from '../../sources/components/buzz/SettingsRow';
import type { RoomListFilter } from '../../sources/buzz/room-list-preferences';
import { InlineRow } from '../../sources/components/buzz/IndexRow';

/** Synthetic local content; production controls and their normal room-list insets. */
export function HeaderAlignmentProof({ desktop = false, onTheme }: { desktop?: boolean; onTheme?: () => void }) {
  const { theme } = useUnistyles();
  const h = theme.buzz;
  const [filter, setFilter] = useState<RoomListFilter>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState('Rooms');
  return <View style={{ flex: 1, backgroundColor: h.bgBase }}>
    <InlineRow style={{ paddingHorizontal: 16, paddingTop: 32 }}>
      <Button accessibilityLabel="Rooms" label="Rooms" variant="quiet" onPress={() => setPage('Rooms')} />
      <Button accessibilityLabel="Settings" label="Settings" variant="quiet" onPress={() => setPage('Settings')} />
      {onTheme && <Button label="Theme" variant="quiet" onPress={onTheme} />}
    </InlineRow>
    <View style={{ width: desktop ? 360 : '100%', flex: 1 }}>
      <View style={{ minHeight: 62, paddingLeft: 24, paddingRight: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: h.border }}>
        <Text style={{ ...h.type.bodyStrong, color: h.textPrimary }}>Tubing Crew</Text>
        <InlineRow style={{ gap: 0 }}>
          <Button label="" iconOnly variant="quiet" accessibilityLabel="Members" testID="workspace-members"
            icon={<MembersAgentsGlyph size={22} color={h.ledgerQuiet} />} onPress={() => setPage('Members')} />
          <TrayGlyph size={22} color={h.accent} cutColor={h.bgBase} needsYouCount={1} testID="workspace-tray" onPress={() => setPage('Tray')} />
        </InlineRow>
      </View>
      <ScrollView>
        {page === 'Rooms' ? <>
          <RoomListToolbar desktop={desktop} filter={filter} onFilter={setFilter} query={query} onQuery={setQuery} counts={{ all: 22, unread: 4, pinned: 6 }} />
          <RoomListSectionHeader title="Rooms" count={4} onAction={() => {}} actionAccessibilityLabel="Create Room" actionTestID="rooms-add" testID="rooms-heading" tapLineHeight={desktop} />
          <SettingsRow title="#beeline" description="@ruby · The corner is ready for review" onPress={() => {}} />
          <RoomListSectionHeader title="Corners" count={3} onAction={() => {}} actionAccessibilityLabel="Create corner" actionTestID="corners-add" tapLineHeight={desktop} />
          <SettingsRow title="#header-alignment" description="working" onPress={() => {}} />
        </> : <>
          <Text style={{ ...h.type.hero, color: h.textPrimary, margin: 16 }}>{page}</Text>
          <RoomListSectionHeader title={page === 'Settings' ? 'Workspace' : page === 'Tray' ? 'Needs you' : 'People'} count={page === 'Tray' ? 1 : 4} />
          <SettingsRow title={page === 'Settings' ? 'Appearance' : page === 'Tray' ? 'Review header alignment' : 'lunchboxfortwo'} description="Shared section header" onPress={() => {}} />
          <RoomListSectionHeader title={page === 'Tray' ? 'Saved' : 'Agents'} count={2} />
        </>}
      </ScrollView>
    </View>
  </View>;
}
