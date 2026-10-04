import React, { useCallback, useState } from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { NewRoomDialog } from '../sources/components/buzz/NewRoomDialog';
import type { RepoCandidate } from '../sources/buzz/room-repo-picker';
import type { GitHubInstallationAccess } from '@beeline/buzz-client';

/**
 * Paints the real New Room dialog's repo picker at phone size and walks it
 * the way a person does: tap Repository, then Create with the owner menu.
 * `?stop=<step>` freezes the sheet at that step for a screenshot. Wired the
 * same way `channels.tsx` wires NewRoomDialog.
 */
const STOP = new URLSearchParams(location.search).get('stop');

const repo = (owner: string, name: string) => ({
  key: `${owner}/${name}`,
  name: `${owner}/${name}`,
  remote: `https://github.com/${owner}/${name}`,
  githubInstallationId: 1,
});
const candidates: RepoCandidate[] = [
  'trusty-squire',
  'castellan',
  'trusty-squire-housekeeper',
  'veritaserum',
  'goodser',
].map((name) => repo('trusty-squire', name)) as any;
const installations: GitHubInstallationAccess[] = [
  { installationId: 1, accountLogin: 'trusty-squire', status: 'active' },
  { installationId: 2, accountLogin: 'Beeline-Work', status: 'active' },
] as any;
const saved: string[] = [];

function Dialog() {
  const [roomName, setRoomName] = useState('thecollector');
  const [inviteOnly, setInviteOnly] = useState(false);
  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const [pendingRepo, setPendingRepo] = useState<RepoCandidate | null>(null);

  const handleToggleRepoPicker = useCallback(() => setShowRepoPicker((v) => !v), []);
  const handleSelectRepoCandidate = useCallback((candidate: RepoCandidate) => {
    setPendingRepo(candidate);
    setShowRepoPicker(false);
  }, []);
  const handleSelectNoRepository = useCallback(() => setPendingRepo(null), []);

  return (
    <NewRoomDialog
      visible
      roomName={roomName}
      setRoomName={setRoomName}
      inviteOnly={inviteOnly}
      setInviteOnly={setInviteOnly}
      creatingRoom={false}
      createRoom={(repository) => saved.push(`create room repo=${repository?.name ?? 'none'}`)}
      onClose={() => undefined}
      pendingRepo={pendingRepo}
      showRepoPicker={showRepoPicker}
      handleToggleRepoPicker={handleToggleRepoPicker}
      handleLoadRepositories={() => undefined}
      handleSelectNoRepository={handleSelectNoRepository}
      handleSelectRepoCandidate={handleSelectRepoCandidate}
      repoCandidates={candidates}
      repoInstallations={installations}
      repoPickerError={null}
      handleAddGitHubAccount={() => saved.push('connect')}
      handleCreateRepository={async (installationId, name) => {
        saved.push(`create repo ${installationId} ${name}`);
        return repo('trusty-squire', name) as any;
      }}
    />
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
  const sheet = byTestID('new-room-dialog');
  lines.push(`${name}: ${sheet?.innerText.replace(/\s+/g, ' ').trim()}`);
  if (STOP === name) stopped = true;
}
const tap = (testID: string) => () => {
  const node = byTestID(testID);
  if (!node) throw new Error(`no ${testID}`);
  node.click();
};

async function run() {
  createRoot(document.getElementById('root')!).render(<Dialog />);
  await pause();
  await step('N1');
  await step('N2', tap('create-room-repo-row'));
  await step('N3', tap('create-room-repo-mode-create'));
  await step('N4', tap('create-room-repo-owner'));
  lines.push(`saved: ${saved.join(' | ') || 'nothing'}`);
  const errors = (window as any).__console.filter((line: string) => line.startsWith('error'));
  lines.push(`console errors: ${errors.join(' | ') || 'none'}`);
  document.getElementById('result')!.textContent = lines.join('\n');
}

run().catch((error) => {
  document.getElementById('result')!.textContent = `FAIL ${String(error)}\n${lines.join('\n')}`;
});
