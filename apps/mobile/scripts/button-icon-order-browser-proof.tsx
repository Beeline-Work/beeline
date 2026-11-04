import { EmptyState } from '@/components/buzz/EmptyState';
import React from 'react';
// @ts-expect-error Standalone browser proof.
import { createRoot } from 'react-dom/client';
import { Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { RoomRosterSheet } from '../sources/components/buzz/RoomRosterSheet';
import { CommunityInviteEntry } from '../sources/components/buzz/CommunityInviteEntry';
import { ChevronGlyph } from '../sources/components/buzz/ChevronGlyph';

let showAll = 0;
function Proof() {
  const { theme: { buzz } } = useUnistyles();
  // Frozen main controls: retain their original text-then-chevron child order.
  const action = { flexDirection: 'row', alignItems: 'center', gap: buzz.space.sm,
    minHeight: 44, paddingHorizontal: 16, paddingVertical: buzz.space.sm,
    borderWidth: 1, borderColor: buzz.buttonSecondaryText, borderRadius: buzz.radius } as const;
  const members = Array.from({ length: 12 }, (_, i) => ({ pubkey: `person-${i}`, name: `Person ${i}`, handle: `person${i}`, kind: 'person' }));
  return <View style={{ width: '100%', backgroundColor: buzz.bgBase }}>
    <Text style={{ ...buzz.type.body, color: buzz.textPrimary }}>Main reference: original trailing chevron</Text>
    <View style={{ alignItems: 'center' }}><Pressable testID="main-show-all" style={action}>
      <Text style={{ ...buzz.type.meta, color: buzz.buttonSecondaryText }}>Show all conversations</Text>
      <ChevronGlyph direction="right" size={18} color={buzz.buttonSecondaryText} />
    </Pressable></View>
    <EmptyState title="No matching conversations" description="Try a different search or filter." testID="room-list-no-match" action={{label:'Show all conversations',onPress:() => showAll++,testID:'no-match-show-all-conversations'}} />
    <EmptyState title="No pinned conversations yet" description="Long press a Room to pin it here." testID="pinned-empty" action={{label:'Show all conversations',onPress:() => showAll++,testID:'show-all-conversations'}} />
    <EmptyState title="No pinned conversations yet" description="Long press a Room to pin it here." testID="desktop-pinned-empty" action={{label:'Show all conversations',onPress:() => showAll++,testID:'desktop-show-all-conversations'}} />
    <RoomRosterSheet visible bottomInset={0} canManage={false} isDirectMessage={false}
      members={members as any} memberByPubkey={new Map()} personProfileByPubkey={new Map()}
      membershipActionPubkey={null} membershipError={null} workingByPubkey={{}}
      parentChannelId={null} userPubkey="viewer" onAddMembers={() => {}} onClose={() => {}} onRemove={() => {}} />
    <CommunityInviteEntry community={{ name: 'Example' } as any} creatingInvite={false} onInvitePeople={() => {}} />
  </View>;
}
createRoot(document.getElementById('root')!).render(<Proof />);
const get = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
async function main() {
  await document.fonts.ready;
  await new Promise(r => setTimeout(r, 80));
  const measurements: unknown[] = [];
  const position = (id: string, glyphText?: string, leading = false) => {
    const control = get(id);
    const text = [...control.querySelectorAll('[dir="auto"]')];
    const glyph = glyphText ? text.find(n => n.textContent === glyphText)! : control.querySelector('svg')!;
    const label = text.find(n => n !== glyph)!;
    const a = label.getBoundingClientRect(), b = glyph.getBoundingClientRect();
    const frame = document.getElementById('root')!.getBoundingClientRect();
    if (b.right > frame.right + .1 || a.left < frame.left - .1) throw Error(id + ': control outside proof viewport');
    if (leading ? b.right > a.left : b.left < a.right) throw Error(id + ': glyph on wrong side of label');
    measurements.push({ id, labelLeft: a.left, labelRight: a.right, glyphLeft: b.left, glyphRight: b.right });
    return { gap: leading ? a.left - b.right : b.left - a.right, height: control.getBoundingClientRect().height };
  };
  position('main-show-all');
  for (const id of ['no-match-show-all-conversations', 'show-all-conversations', 'desktop-show-all-conversations']) {
    const control = get(id);
    if (control.querySelector('svg')) throw Error(id + ': retired empty-state chevron returned');
    if (control.getBoundingClientRect().height < 44) throw Error(id + ': touch target too small');
    get(id).click();
  }
  if (showAll !== 3) throw Error('Show all callbacks changed');
  position('room-roster-more');
  position('invite-people-action', '＋', true);
  document.getElementById('result')!.textContent = 'PASS BUTTON ICON ORDER ' + JSON.stringify(measurements);
}
main().catch(error => { document.getElementById('result')!.textContent = 'FAIL ' + error.message; });
