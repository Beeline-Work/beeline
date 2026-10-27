import React, { useState } from 'react';
import { View, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Button } from '../sources/components/buzz/Button';
import {
  RoomRosterSheet,
  type RoomRosterParticipant,
} from '../sources/components/buzz/RoomRosterSheet';
import {
  MemberPickerSheet,
  type MemberPickerCandidate,
} from '../sources/components/buzz/MemberPickerSheet';

export const members: RoomRosterParticipant[] = [
  {
    pubkey: 'owner',
    name: 'lunchboxfortwo',
    handle: 'lunchboxfortwo',
    kind: 'person',
    face: 'bird',
  },
  {
    pubkey: 'admin',
    name: 'bananaman614305',
    handle: 'bananaman614305',
    kind: 'person',
    face: 'octopus',
  },
  ...['emberus', 'sol', 'bbc', 'ruby'].map((handle, index) => ({
    pubkey: handle,
    name: handle,
    handle,
    kind: 'agent' as const,
    agent: {
      pubkey: handle,
      displayName: handle,
      handle,
      face: ['bat', 'deer', 'goose', 'cat'][index],
    },
    ownerHandle: index === 0 || index === 3 ? 'lunchboxfortwo' : 'bananaman614305',
    model: ['6 Astra', '6.1 Sol', 'deepseek-v4.1-flash', 'Default (recommended)'][index],
  })),
];
export const candidates: MemberPickerCandidate[] = [
  'chloropine',
  'johnnyhuang963',
  'MoonScannerAI',
  'Play Review',
  'Baby',
  'Beebee',
  'Candy',
  'Earth',
].map((name, index) => ({
  pubkey: `candidate-${index}`,
  name,
  handle: name.toLowerCase().replaceAll(' ', '-'),
  kind: index < 4 ? 'person' : 'agent',
  face: ['bear', 'goose', 'deer', 'deer', 'bird', 'cat', 'deer', 'octopus'][index],
}));
export function MemberSheetsProof() {
  const { theme } = useUnistyles();
  const [sheet, setSheet] = useState<'roster' | 'picker' | null>(null);
  const [manager, setManager] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [result, setResult] = useState('');
  return (
    <View style={{ flex: 1, paddingTop: 48, backgroundColor: theme.buzz.bgBase }}>
      <Button label="Open Members" onPress={() => setSheet('roster')} testID="open-roster" />
      <Button label="Open picker" onPress={() => setSheet('picker')} testID="open-picker" />
      <Button
        label={manager ? 'Manager' : 'Viewer'}
        onPress={() => setManager(!manager)}
        testID="toggle-manager"
      />
      <Button
        label={empty ? 'Empty' : 'Populated'}
        onPress={() => setEmpty(!empty)}
        testID="toggle-empty"
      />
      <Text testID="fixture-result">{result}</Text>
      <RoomRosterSheet
        bottomInset={24}
        canManage={manager}
        isDirectMessage={false}
        memberByPubkey={
          new Map([
            ['owner', { pubkey: 'owner', role: 'owner' }],
            ['admin', { pubkey: 'admin', role: 'admin' }],
          ]) as any
        }
        members={empty ? [] : members}
        membershipActionPubkey={null}
        membershipError={null}
        onAddMembers={() => setSheet('picker')}
        onClose={() => setSheet(null)}
        onRemove={() => {}}
        workingByPubkey={{}}
        parentChannelId={null}
        personProfileByPubkey={new Map()}
        userPubkey="owner"
        visible={sheet === 'roster'}
      />
      <MemberPickerSheet
        visible={sheet === 'picker'}
        onClose={() => setSheet(null)}
        candidates={candidates}
        canManage={manager}
        busy={false}
        error={null}
        onAdd={(keys) => {
          setResult(`Added ${keys.join(',')}`);
          setSheet(null);
        }}
        onInvitePerson={() => setResult('Invite opened')}
        onConnectAgent={() => setResult('Connect opened')}
      />
    </View>
  );
}
