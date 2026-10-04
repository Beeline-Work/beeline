import React, { useState } from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { HullActionSheetModal, HullActionSheetRow } from '../sources/components/buzz/HullActionSheet';
import { useRoomRepositoryChoice } from '../sources/components/buzz/RoomRepositoryChoice';

/**
 * Paints the real Room header sheet's collapsed Repository row beside
 * illustrative sibling rows (Reviewer, Repo notifications, Members,
 * Workflows, Scheduled work) the way `_chat-surface.tsx` actually assembles
 * them, so the two read as one list. See `evidence/room-sheet-repo-row/`.
 */
const repo = (owner: string, name: string) => ({
  key: `${owner}/${name}`,
  name: `${owner}/${name}`,
  remote: `https://github.com/${owner}/${name}`,
  githubInstallationId: 1,
});
const candidates = ['trusty-squire', 'castellan'].map((name) => repo('trusty-squire', name));
const installations = [
  { installationId: 1, accountLogin: 'trusty-squire', status: 'active' },
] as any;

function Sheet() {
  const [listOpen, setListOpen] = useState(false);
  const choice = useRoomRepositoryChoice({
    visible: true,
    canManage: true,
    roomName: 'beeline-experiments',
    current: repo('trusty-squire', 'beeline-experiments') as any,
    candidates: candidates as any,
    installations,
    loading: false,
    busy: false,
    error: null,
    notice: null,
    listOpen,
    setListOpen,
    onLoad: () => undefined,
    onConnect: () => undefined,
    onLink: () => undefined,
    onCreate: async () => undefined,
    onUnlink: () => undefined,
    onCancel: () => undefined,
    draftContext: 'proof',
  });
  return (
    <HullActionSheetModal
      footer={choice.footer}
      onClose={() => undefined}
      sticky={choice.listOpen ? undefined : choice.control}
      testID="room-actions-sheet"
      title="#beeline-experiments"
      visible
    >
      {choice.row}
      <HullActionSheetRow
        chevron="right"
        label="Reviewer"
        metadata="@scout"
        onPress={() => undefined}
        testID="room-reviewer-action"
      />
      <HullActionSheetRow
        label="Repo notifications"
        testID="room-github-events-toggle"
        toggle={{ onValueChange: () => undefined, value: true }}
      />
      <HullActionSheetRow
        chevron="right"
        label="Members"
        metadata="6"
        onPress={() => undefined}
        testID="room-participant-roster-trigger"
      />
      <HullActionSheetRow
        chevron="right"
        label="Workflows"
        onPress={() => undefined}
        testID="room-workflows-trigger"
      />
      <HullActionSheetRow
        chevron="right"
        label="Scheduled work"
        onPress={() => undefined}
        testID="room-schedules-action"
      />
    </HullActionSheetModal>
  );
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 200));
async function run() {
  createRoot(document.getElementById('root')!).render(<Sheet />);
  await pause();
  const result = document.getElementById('result')!;
  result.style.display = 'none';
  result.textContent = 'READY';
}
run().catch((error) => {
  document.getElementById('result')!.textContent = `FAIL ${String(error)}`;
});
