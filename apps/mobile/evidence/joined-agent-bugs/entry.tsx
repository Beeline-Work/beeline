import React from 'react';
// @ts-expect-error Standalone proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import { RoomRosterSheet } from '../../sources/components/buzz/RoomRosterSheet';
import { MemberSheetsProof, members } from '../../scripts/member-sheets-fixture';
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('interactive') ? <MemberSheetsProof /> :
  <RoomRosterSheet bottomInset={24} canManage isDirectMessage={false}
    memberByPubkey={new Map()} members={members} membershipActionPubkey={null}
    membershipError={null} onAddMembers={() => {}} onClose={() => {}} onRemove={() => {}}
    workingByPubkey={{}} parentChannelId={null} personProfileByPubkey={new Map()}
    userPubkey="owner" visible />
);
