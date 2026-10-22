/**
 * Shared UI library fixture: renders the production shared components, one
 * mock section per page, on Android (Hermes release) and desktop web. The same
 * file renders the "before" tree; parts that did not exist there come from
 * `shared-ui-library-proof-new`, which the before tree stubs out.
 */
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { Button } from '../sources/components/buzz/Button';
import { DirectMessagePickerSheet } from '../sources/components/buzz/DirectMessagePickerSheet';
import {
  HullActionSheet,
  HullActionSheetCancel,
  HullActionSheetRow,
} from '../sources/components/buzz/HullActionSheet';
import { HullDialog } from '../sources/components/buzz/HullDialog';
import { MemberRosterRow } from '../sources/components/buzz/MemberRosterRow';
import { RoomListSectionHeader } from '../sources/components/buzz/RoomListSectionHeader';
import { SettingsRow } from '../sources/components/buzz/SettingsRow';
import { NewParts } from './shared-ui-library-proof-new';

const noop = () => {};
const PAGES = ['rows', 'sheet', 'headers', 'switch', 'buttons', 'states', 'chrome', 'dialog'] as const;
type Page = (typeof PAGES)[number];

const search = (globalThis as { location?: { search?: string } }).location?.search ?? '';
const initialPage = (new URLSearchParams(search).get('page') as Page | null) ?? 'rows';

type PickerMember = React.ComponentProps<typeof DirectMessagePickerSheet>['members'][number];
const member = (peerPubkey: string, peerName: string, peerKind: 'person' | 'agent') =>
  ({ peerPubkey, peerName, peerKind }) as PickerMember;

function Missing({ what }: { what: string }) {
  const { theme } = useUnistyles();
  return (
    <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.dialogDanger, padding: 8 }}>
      {`No shared ${what} in this tree`}
    </Text>
  );
}

function Rows() {
  const [sweep, setSweep] = useState(true);
  return (
    <View>
      <RoomListSectionHeader inset="row" title="Workspace" />
      <SettingsRow title="Name" value="Beeline" onPress={noop} chevron="right" />
      <SettingsRow
        title="Public join link"
        description="Anyone with the link can join"
        action="Copy"
        onPress={noop}
      />
      <SettingsRow
        title="Allow fix sweep"
        description="Helps Beeline improve"
        toggle={{ value: sweep, onValueChange: setSweep }}
        onPress={() => setSweep(!sweep)}
      />
      <SettingsRow
        title="Members"
        description="Invite people and agents, set roles"
        value="4"
        chevron="right"
        onPress={noop}
      />
      <SettingsRow
        title="A very long row title that must end in an ellipsis on a phone"
        description="A long subtitle that keeps going so it has to stop at two lines and never run to a third line under the title"
        chevron="right"
        onPress={noop}
      />
      <SettingsRow title="Disabled fact" value="Off" disabled />
      <SettingsRow
        title="Notifications"
        description="Delivery failed"
        descriptionAction={{ label: 'Retry', onPress: noop }}
        value="On"
      />
    </View>
  );
}

function Headers() {
  return (
    <View>
      <RoomListSectionHeader
        title="Rooms"
        count={2}
        onAction={noop}
        actionAccessibilityLabel="New Room"
      />
      <SettingsRow title="#design-notes" description="No messages yet" onPress={noop} />
      <RoomListSectionHeader
        title="Needs you"
        count={3}
        wordAction={{ label: 'Clear', onPress: noop }}
      />
      <SettingsRow title="@sol asks for review" description="#launch-readiness" onPress={noop} />
      <RoomListSectionHeader title="Without action" count={5} />
      <SettingsRow title="#general" onPress={noop} />
    </View>
  );
}

function Switches() {
  const [fast, setFast] = useState(true);
  const [answers, setAnswers] = useState(false);
  const Switch = NewParts?.HullSwitch;
  return (
    <View>
      <RoomListSectionHeader inset="row" title="Settings row" />
      <SettingsRow
        title="Fast mode"
        description="Shorter turns"
        toggle={{ value: fast, onValueChange: setFast }}
        onPress={() => setFast(!fast)}
      />
      <SettingsRow
        title="Answers everyone"
        description="Replies without a tag"
        toggle={{ value: answers, onValueChange: setAnswers }}
        onPress={() => setAnswers(!answers)}
      />
      <RoomListSectionHeader inset="sheet" surface="sheet" title="Sheet row" />
      <HullActionSheetRow
        label="Fast mode"
        description="Shorter turns"
        toggle={{ value: fast, onValueChange: setFast }}
      />
      <HullActionSheetRow
        label="Answers everyone"
        description="Replies without a tag"
        toggle={{ value: answers, onValueChange: setAnswers }}
      />
      <RoomListSectionHeader inset="row" title="Bare switch" />
      {Switch ? (
        <View style={{ flexDirection: 'row', gap: 24, padding: 8 }}>
          <Switch value onValueChange={noop} accessibilityLabel="On" />
          <Switch value={false} onValueChange={noop} accessibilityLabel="Off" />
          <Switch value disabled onValueChange={noop} accessibilityLabel="On, disabled" />
        </View>
      ) : (
        <Missing what="switch" />
      )}
    </View>
  );
}

function Buttons() {
  const ShowMore = NewParts?.ShowMoreRow;
  return (
    <View style={{ gap: 12, padding: 8, alignItems: 'flex-start' }}>
      <Button label="Save" variant="primary" onPress={noop} />
      <Button label="New Room" variant="secondary" onPress={noop} />
      <Button label="Connect" variant="quiet" onPress={noop} />
      <Button label="Remove from Beeline" variant="destructive" onPress={noop} />
      <Button label="Save" variant="primary" disabled onPress={noop} />
      {ShowMore ? <ShowMore label="Show 6 more" inset="none" onPress={noop} /> : <Missing what="show more row" />}
    </View>
  );
}

function States() {
  const Empty = NewParts?.EmptyState;
  const Banner = NewParts?.ErrorBanner;
  return (
    <View style={{ gap: 24, padding: 8 }}>
      {Empty ? (
        <Empty
          title="No pinned Rooms"
          description="Pin a Room to keep it on top."
          action={{ label: 'Show all Rooms', onPress: noop }}
        />
      ) : (
        <Missing what="empty state" />
      )}
      {Banner ? (
        <Banner
          title="Couldn't load Rooms"
          description="The server didn't answer. Your Rooms are safe."
          onRetry={noop}
        />
      ) : (
        <Missing what="error banner" />
      )}
    </View>
  );
}

function Chrome() {
  return (
    <HullActionSheet
      title="Choose where this agent runs when the Room is busy and long"
      subtitle="A subtitle long enough to need a second line, and then a third line that must never show"
      footer={<HullActionSheetCancel onPress={noop} />}
    >
      <HullActionSheetRow label="squire" description="This machine" onPress={noop} chevron="right" />
      <HullActionSheetRow label="chad" metadata="Offline" disabled onPress={noop} />
      <HullActionSheetRow label="Remove agent" destructive onPress={noop} />
      <RoomListSectionHeader inset="sheet" surface="sheet" title="Members" count={2} />
      <MemberRosterRow
        kind="human"
        name="lunchboxfortwo"
        handle="lunchboxfortwo"
        pubkey="pubkey-lunchbox"
        role="owner"
        divider="top"
        density="sheet"
        inset="sheet"
        chevron="right"
        onPress={noop}
        testID="roster-human"
      />
      <MemberRosterRow
        kind="agent"
        name="Ruby"
        handle="ruby"
        pubkey="pubkey-ruby"
        ownerHandle="lunchboxfortwo"
        model="claude-opus-5-5"
        divider="top"
        density="sheet"
        inset="sheet"
        disabled
        testID="roster-agent"
      />
    </HullActionSheet>
  );
}

function Body({ page }: { page: Page }) {
  switch (page) {
    case 'rows':
      return <Rows />;
    case 'sheet':
      return (
        <DirectMessagePickerSheet
          busyPubkey={null}
          members={[
            member('pubkey-lunchbox', 'lunchboxfortwo', 'person'),
            member('pubkey-banana', 'bananaman614305', 'person'),
            member('pubkey-baby', 'Baby', 'agent'),
            member('pubkey-ruby', 'Ruby', 'agent'),
          ]}
          onClose={noop}
          onMessage={noop}
          visible
        />
      );
    case 'headers':
      return <Headers />;
    case 'switch':
      return <Switches />;
    case 'buttons':
      return <Buttons />;
    case 'states':
      return <States />;
    case 'chrome':
      return <Chrome />;
    case 'dialog':
      return (
        <HullDialog
          visible
          onRequestClose={noop}
          title="Remove Ruby from this Room?"
          body="Ruby stops reading and replying here. You can add it back later."
          actions={[
            { label: 'Cancel', onPress: noop },
            { label: 'Remove', variant: 'destructive', onPress: noop },
          ]}
        />
      );
  }
}

export default function SharedUiLibraryProof() {
  const { theme } = useUnistyles();
  const [page, setPage] = useState<Page>(initialPage);
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.buzz.bgTerminal }}
      contentContainerStyle={{ paddingTop: 40, paddingBottom: 48 }}
    >
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 8 }}>
        {PAGES.map((name) => (
          <Pressable
            key={name}
            accessibilityLabel={`page-${name}`}
            onPress={() => setPage(name)}
            style={{ minHeight: 32, paddingHorizontal: 6, justifyContent: 'center' }}
          >
            <Text
              style={{
                ...theme.buzz.type.meta,
                color: name === page ? theme.buzz.accent : theme.buzz.textMuted,
              }}
            >
              {name}
            </Text>
          </Pressable>
        ))}
        {(['bone', 'obsidian'] as const).map((name) => (
          <Pressable
            key={name}
            accessibilityLabel={`theme-${name}`}
            onPress={() => UnistylesRuntime.setTheme?.(name)}
            style={{ minHeight: 32, paddingHorizontal: 6, justifyContent: 'center' }}
          >
            <Text style={{ ...theme.buzz.type.meta, color: theme.buzz.textMuted }}>{name}</Text>
          </Pressable>
        ))}
      </View>
      <View key={page} style={{ marginTop: 8, width: '100%', maxWidth: 560 }}>
        <Body page={page} />
      </View>
    </ScrollView>
  );
}
