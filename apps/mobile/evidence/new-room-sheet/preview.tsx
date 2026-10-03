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
  {
    installationId: 12,
    accountId: '2',
    accountLogin: 'Trusty-Squire',
    accountType: 'Organization' as const,
    repositorySelection: 'selected' as const,
    status: 'active' as const,
    repositoryCount: 2,
    manageUrl: 'https://github.com/organizations/Trusty-Squire/settings/installations/12',
  },
];

function Preview() {
  const step = new URLSearchParams(location.search).get('step') ?? 'form';
  const [roomName, setRoomName] = useState('product-planning');
  const [candidates, setCandidates] = useState(FIXTURE_CANDIDATES);
  const [result, setResult] = useState('');
  const [inviteOnly, setInviteOnly] = useState(false);
  const [pendingRepo, setPendingRepo] = useState<RepoCandidate | null>(null);
  const [showRepoPicker, setShowRepoPicker] = useState(step === 'picker');

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
        createRoom={(repository) =>
          setResult(`Created #${roomName} linked to ${repository?.name ?? 'no repository'}`)
        }
        onClose={() => undefined}
        pendingRepo={pendingRepo}
        showRepoPicker={showRepoPicker}
        handleToggleRepoPicker={() => setShowRepoPicker((current) => !current)}
        handleSelectNoRepository={() => {
          setPendingRepo(null);
          setInviteOnly(false);
          setShowRepoPicker(false);
        }}
        handleSelectRepoCandidate={(repo) => {
          setPendingRepo(repo);
          setInviteOnly(repo.private !== false);
          setShowRepoPicker(false);
        }}
        repoCandidates={candidates}
        repoInstallations={FIXTURE_INSTALLATIONS}
        repoPickerError={null}
        handleAddGitHubAccount={() => undefined}
        handleCreateRepository={async (installationId, name) => {
          const owner = FIXTURE_INSTALLATIONS.find(
            (installation) => installation.installationId === installationId,
          )!.accountLogin;
          const created = {
            key: `github:new-${name}`,
            name: `${owner}/${name}`,
            remote: `git://github.com/${owner}/${name}`,
            githubInstallationId: installationId,
            defaultBranch: 'main',
            private: true,
          };
          setCandidates((current) => [...current, created]);
          setPendingRepo(created);
          return created;
        }}
      />
      <Text
        testID="preview-result"
        style={{ ...hull.type.meta, color: hull.textPrimary, padding: 22 }}
      >
        {result}
      </Text>
    </View>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);
