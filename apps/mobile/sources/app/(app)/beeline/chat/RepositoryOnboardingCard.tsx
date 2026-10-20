import { useRepositoryOnboarding } from '@/buzz/onboarding-rollout';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import type { RoomViewIdentity } from '@beeline/api-contract/phone';
import React, { useState } from 'react';
import { AppState, Platform } from 'react-native';
import type { RepositoryOnboardingAction, RepositoryOnboardingCard as Card } from '@beeline/api-contract/phone';
import { TranscriptCard, type TranscriptCardAction, type TranscriptCardChoice } from '@/components/buzz/TranscriptCard';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { authSessionOptions } from '@/auth/auth-session';
import { openAccountAuthSession, subscribeToAuthUrls } from '@/auth/desktop-auth-session';
import { githubInstallationRedirectUri, runGitHubInstallationSession } from '@/auth/github-auth-session';

/** Reuses the shared ask-card anatomy; selections remain authoritative on the server. */
type Props = { card: Card; viewerId: string; author?: RoomViewIdentity };
export function RepositoryOnboardingCard(props: Props) {
  const enabled = useRepositoryOnboarding();
  return enabled ? <EnabledRepositoryOnboardingCard {...props} /> : null;
}
function EnabledRepositoryOnboardingCard({ card, viewerId, author }: Props) {
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canAct = card.status === 'open' && card.requesterId === viewerId && !busy;
  const act = async (action: RepositoryOnboardingAction['action'], extra: Partial<RepositoryOnboardingAction> = {}) => {
    if (!canAct) return;
    setBusy(true);
    setError(null);
    const request = { roomId: card.roomId, cardId: card.id, action, ...extra };
    try {
      if (action === 'install' || action === 'organization') {
        await runGitHubInstallationSession({
          returnPath: `/beeline/chat/${card.roomId}`,
          startInstallation: async () => {
            const result = await monolithPhoneOperation('actOnRepositoryCard', { ...request, redirectUri: githubInstallationRedirectUri() });
            if (!result.url) throw new Error('GitHub installation could not start. Try again.');
            return result.url;
          },
          openAuthSession: (url, redirect) => openAccountAuthSession(url, redirect, authSessionOptions(Platform.OS, redirect)),
          subscribeToUrls: subscribeToAuthUrls,
          subscribeToAppState: listener => AppState.addEventListener('change', listener),
          refreshRepositories: async () => { await monolithPhoneOperation('actOnRepositoryCard', { ...request, action: 'refresh' }); },
        });
      } else await monolithPhoneOperation('actOnRepositoryCard', request);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };
  const choices: TranscriptCardChoice[] = card.kind === 'starters'
    ? card.starters.map((starter, index) => ({ id: starter.id, letter: String(index + 1), label: starter.title,
      consequence: starter.evidence, ...(canAct ? { onPress: () => void act('starter', { starterId: starter.id }) } : {}) }))
    : picker ? card.repositories.map(repository => ({ id: String(repository.id), letter: repository.current ? '✓' : '→',
      label: repository.fullName, consequence: repository.current ? 'Current · open PRs stay open' : 'Use this repository',
      selected: repository.current, ...(canAct && !repository.current ? { onPress: () => void act('link', { repositoryId: repository.id }) } : {}) })) : [];
  const actions: TranscriptCardAction[] = card.kind === 'repository' && card.canLink && card.status === 'open' && card.requesterId === viewerId ? [
    ...(card.installationId ? [{ label: 'Create new repo', primary: true, loading: busy,
      disabled: !canAct, onPress: () => void act('create'), testID: 'repo-card-create' }] : [{ label: 'Install Beeline', primary: true,
      loading: busy, disabled: !canAct, onPress: () => void act('install'), testID: 'repo-card-install' }]),
    { label: 'Link existing', disabled: !canAct, onPress: () => setPicker(!picker), testID: 'repo-card-link' },
    { label: 'Add Beeline to an org', disabled: !canAct, onPress: () => void act('organization'), testID: 'repo-card-org' },
  ] : [];
  return <TranscriptCard tier={card.status === 'open' ? 'ask' : 'record'}
    identity={<IdentityMark kind="agent" seed={card.agentId} face={author?.face} name={author?.name} size={26} />}
    testID={`repository-onboarding-${card.kind}`}
    title={card.kind === 'starters' ? 'Pick a starting task' : card.repository ? 'Switch repository' : 'Choose a repository'}
    subline={card.repository ?? 'Create a private repo or link one you already own.'}
    body={card.kind === 'repository' ? card.canLink ? `New repo: ${card.defaultName}` : 'Ask a Workspace owner or admin to choose a repository for this Room.' : undefined}
    choices={choices} actions={actions}
    footerNote={error ?? (busy ? 'Working…' : card.selected ? `Selected · ${card.selected}` : picker && !card.repositories.length ? 'No repositories found. Install Beeline, then try again.' : undefined)}
    footerNoteTone={error ? 'failed' : 'quiet'} />;
}
