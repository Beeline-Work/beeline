import React from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import BuzzMembers from '../../sources/app/(app)/beeline/members';
import { RoomRosterSheet } from '../../sources/components/buzz/RoomRosterSheet';
import { members } from '../../scripts/member-sheets-fixture';
const fixture = {
  workspace: { id: '11111111-1111-4111-8111-111111111111', name: 'Tubing Crew', updatedAt: 1000 },
  viewer: { identity: { pubkey: 'owner', kind: 'human', name: 'lunchboxfortwo' }, role: 'owner', permissions: { manage: true } },
  members: members.filter(m => m.kind === 'person').map(m => ({ identity: { pubkey: m.pubkey, kind: 'human', name: m.name, handle: m.handle, face: m.face }, role: m.pubkey === 'owner' ? 'owner' : 'admin' })),
  agents: members.filter(m => m.kind === 'agent').map(m => ({ identity: { pubkey: m.pubkey, kind: 'agent', name: m.name, handle: m.handle, face: m.agent?.face }, role: 'member', model: m.model, owner: { pubkey: 'owner', name: 'lunchboxfortwo', handle: m.ownerHandle, kind: 'human' } })),
  watchFilters: [],
};
Object.assign(globalThis, { __joinedMembersFixture: fixture });
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).get('surface') === 'members'
    ? <BuzzMembers workspaceIdOverride={fixture.workspace.id} />
    : <RoomRosterSheet bottomInset={24} canManage isDirectMessage={false}
        memberByPubkey={new Map([['owner', { pubkey: 'owner', role: 'owner' }], ['admin', { pubkey: 'admin', role: 'admin' }]]) as never}
        members={members} membershipActionPubkey={null} membershipError={null}
        onAddMembers={() => {}} onClose={() => {}} onRemove={() => {}}
        workingByPubkey={{}} parentChannelId={null} personProfileByPubkey={new Map()}
        userPubkey="owner" visible />
);
