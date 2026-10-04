import React, { useState } from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { HullActionSheetModal } from '../sources/components/buzz/HullActionSheet';
import { useRoomRepositoryChoice } from '../sources/components/buzz/RoomRepositoryChoice';

/**
 * Paints the real Room header sheet's Repository control at phone size and
 * walks it the way a person does: tap Repository, Link, open the list, pick a
 * repo, Save; then Create with the owner menu. `?stop=<step>` freezes the
 * sheet at that step for a screenshot. The page reports what each step showed.
 */
const STOP = new URLSearchParams(location.search).get('stop');
const LINKED = new URLSearchParams(location.search).get('linked') === '1';

const repo = (owner: string, name: string) => ({
  key: `${owner}/${name}`,
  name: `${owner}/${name}`,
  remote: `https://github.com/${owner}/${name}`,
  githubInstallationId: 1,
});
const candidates = [
  'trusty-squire',
  'castellan',
  'trusty-squire-housekeeper',
  'veritaserum',
  'goodser',
].map((name) => repo('trusty-squire', name));
const installations = [
  { installationId: 1, accountLogin: 'trusty-squire', status: 'active' },
  { installationId: 2, accountLogin: 'Beeline-Work', status: 'active' },
] as any;
const saved: string[] = [];

function Sheet() {
  const [listOpen, setListOpen] = useState(false);
  const choice = useRoomRepositoryChoice({
    visible: true,
    canManage: true,
    roomName: 'thecollector',
    current: LINKED ? candidates[1]! : null,
    candidates,
    installations,
    loading: false,
    busy: false,
    error: null,
    notice: null,
    listOpen,
    setListOpen,
    onLoad: () => undefined,
    onConnect: () => saved.push('connect'),
    onLink: (picked) => saved.push(`link ${picked.name}`),
    onCreate: async (installationId, name) => {
      saved.push(`create ${installationId} ${name}`);
    },
    onUnlink: () => saved.push('unlink'),
    onCancel: () => undefined,
    draftContext: 'proof',
  });
  return (
    <HullActionSheetModal
      footer={choice.footer}
      onClose={() => undefined}
      sticky={choice.listOpen ? undefined : choice.control}
      testID="room-actions-sheet"
      title={choice.listOpen ? 'Choose a repo' : '#thecollector'}
      visible
    >
      {choice.listOpen ? choice.list : choice.row}
    </HullActionSheetModal>
  );
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 200));
const byTestID = (testID: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
const lines: string[] = [];
let stopped = false;
async function step(name: string, act?: () => void) {
  if (stopped) return;
  act?.();
  await pause();
  const sheet = byTestID('room-actions-sheet');
  lines.push(`${name}: ${sheet?.innerText.replace(/\s+/g, ' ').trim()}`);
  if (STOP === name) stopped = true;
}
const tap = (testID: string) => () => {
  const node = byTestID(testID);
  if (!node) throw new Error(`no ${testID}`);
  node.click();
};

async function run() {
  createRoot(document.getElementById('root')!).render(<Sheet />);
  await pause();
  if (LINKED) {
    await step('H9', () => undefined);
    await step('H9-open', tap('room-repo-row'));
    await step('H9-none', tap('room-repo-mode-none'));
    await step('H9-save', tap('room-repo-save'));
  } else {
    await step('H1');
    await step('H2', tap('room-repo-row'));
    await step('H3', tap('room-repo-mode-link'));
    await step('H4', tap('room-repo-link'));
    const search = byTestID('room-repo-list-search') as HTMLInputElement | null;
    lines.push(`H4-search: ${search?.placeholder ?? '∅'}`);
    await step('H3-picked', tap('room-repo-list-candidate-trusty-squire/castellan'));
    await step('H3-save', tap('room-repo-save'));
    await step('H5', tap('room-repo-mode-create'));
    await step('H6', tap('room-repo-owner'));
    await step('H5-save', tap('room-repo-save'));
  }
  lines.push(`saved: ${saved.join(' | ') || 'nothing'}`);
  const errors = (window as any).__console.filter((line: string) => line.startsWith('error'));
  lines.push(`console errors: ${errors.join(' | ') || 'none'}`);
  document.getElementById('result')!.textContent = lines.join('\n');
}

run().catch((error) => {
  document.getElementById('result')!.textContent = `FAIL ${String(error)}\n${lines.join('\n')}`;
});
