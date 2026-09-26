import React, { useState } from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import type { RepoCandidate } from '../../sources/buzz/room-repo-picker';
import { beelineThemes } from '../../sources/buzz/groknight';
import { NewRoomDialog } from '../../sources/components/buzz/NewRoomDialog';

const hull = beelineThemes.bone;

const FIXTURE_CANDIDATES: RepoCandidate[] = [
  {
    key: 'github:1',
    name: 'Beeline-Work/beeline',
    remote: 'git://github.com/Beeline-Work/beeline',
    githubInstallationId: 11,
    defaultBranch: 'main',
  },
  {
    key: 'github:2',
    name: 'Trusty-Squire/veritaserum',
    remote: 'git://github.com/Trusty-Squire/veritaserum',
    githubInstallationId: 11,
    defaultBranch: 'main',
  },
  {
    key: 'github:3',
    name: 'Trusty-Squire/castellan',
    remote: 'git://github.com/Trusty-Squire/castellan',
    githubInstallationId: 11,
    defaultBranch: 'main',
  },
];

const FIXTURE_INSTALLATIONS = [
  {
    installationId: 11,
    accountId: '1',
    accountLogin: 'Beeline-Work',
    accountType: 'Organization' as const,
    repositorySelection: 'selected' as const,
    status: 'active' as const,
    repositoryCount: 3,
    manageUrl: 'https://github.com/organizations/Beeline-Work/settings/installations/11',
  },
];

function Preview() {
  const step = new URLSearchParams(location.search).get('step') ?? 'form';
  const [roomName, setRoomName] = useState('product-planning');
  const [inviteOnly, setInviteOnly] = useState(false);
  const [pendingRepo, setPendingRepo] = useState<RepoCandidate | null>(null);
  const [showRepoPicker, setShowRepoPicker] = useState(step === 'picker' || step === 'create');

  return (
    <View style={{ minHeight: 844, backgroundColor: hull.bgBase }}>
      <View style={{ paddingTop: 54, paddingHorizontal: 22, gap: 18 }}>
        <Text style={{ ...hull.type.sectionHead, color: hull.textMuted }}>TUBING CREW</Text>
        <Text style={{ ...hull.type.hero, color: hull.textDisabled }}>#general</Text>
        <Text style={{ ...hull.type.hero, color: hull.textDisabled }}>#project-notes</Text>
      </View>
      <NewRoomDialog
        visible
        roomName={roomName}
        setRoomName={setRoomName}
        inviteOnly={inviteOnly}
        setInviteOnly={setInviteOnly}
        creatingRoom={false}
        createRoom={() => undefined}
        onClose={() => undefined}
        pendingRepo={pendingRepo}
        showRepoPicker={showRepoPicker}
        handleToggleRepoPicker={() => setShowRepoPicker((current) => !current)}
        handleSelectNoRepository={() => {
          setPendingRepo(null);
          setShowRepoPicker(false);
        }}
        handleSelectRepoCandidate={(repo) => {
          setPendingRepo(repo);
          setShowRepoPicker(false);
        }}
        repoCandidates={FIXTURE_CANDIDATES}
        repoInstallations={FIXTURE_INSTALLATIONS}
        repoPickerError={null}
        handleAddGitHubAccount={() => undefined}
        handleCreateRepository={async () => undefined}
      />
    </View>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);
