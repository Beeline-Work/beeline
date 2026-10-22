import { ErrorBanner } from '@/components/buzz/ErrorBanner';
import { EmptyState } from '@/components/buzz/EmptyState';
import { githubConnectionErrorNotice } from '@/auth/github-connection-error';
import { useRepositoryOnboarding } from '@/buzz/onboarding-rollout';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import type { RoomViewIdentity } from '@beeline/api-contract/phone';
import React, { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { AppState, Platform } from 'react-native';
import type { RepositoryOnboardingAction, RepositoryOnboardingCard as Card } from '@beeline/api-contract/phone';
import { TranscriptCard, type TranscriptCardAction, type TranscriptCardChoice } from '@/components/buzz/TranscriptCard';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

/** Reuses the shared ask-card anatomy; selections remain authoritative on the server. */
type Props = { card: Card; viewerId: string; author?: RoomViewIdentity; connectionError?: string };
export function RepositoryOnboardingCard(props: Props) {
  const enabled = useRepositoryOnboarding();
  return enabled ? <EnabledRepositoryOnboardingCard {...props} /> : null;
}
function EnabledRepositoryOnboardingCard({ card, viewerId, author, connectionError }: Props) {
  const { repositoryPicker } = useLocalSearchParams<{ repositoryPicker?: string }>();
  const [picker, setPicker] = useState(repositoryPicker === card.id);
  const [busy, setBusy] = useState(false);
  const [errorTitle, setErrorTitle] = useState(connectionError ? githubConnectionErrorNotice(connectionError).title : 'GitHub could not connect');
  const [error, setError] = useState<string | null>(connectionError ? githubConnectionErrorNotice(connectionError).description : null);
  const canAct = card.status === 'open' && card.requesterId === viewerId && !busy;
  const act = async (action: RepositoryOnboardingAction['action'], extra: Partial<RepositoryOnboardingAction> = {}) => {
    if (!canAct) return;
    setBusy(true);
    setError(null);
    const request = { roomId: card.roomId, cardId: card.id, action, ...extra };
    try {
      if (action === 'install' || action === 'organization') {
        const [{ authSessionOptions }, { openAccountAuthSession, subscribeToAuthUrls },
          { githubInstallationRedirectUri, runGitHubInstallationSession }] = await Promise.all([
          import('@/auth/auth-session'), import('@/auth/desktop-auth-session'), import('@/auth/github-auth-session'),
        ]);
        const result = await monolithPhoneOperation('actOnRepositoryCard', {
          ...request, redirectUri: githubInstallationRedirectUri(),
        });
        if (result.openPicker) { setPicker(true); return; }
        if (!result.url) throw new Error('GitHub installation could not start. Try again.');
        await runGitHubInstallationSession({
          returnPath: `/beeline/chat/${card.roomId}?repositoryPicker=${card.id}`,
          startInstallation: async () => result.url!,
          onRefreshPhase: phase => {
            if (phase === 'refresh_failed') setError('Connect to Wi-Fi or mobile data, then try again.');
          },
          openAuthSession: (url, redirect) => openAccountAuthSession(url, redirect, authSessionOptions(Platform.OS, redirect)),
          subscribeToUrls: subscribeToAuthUrls,
          subscribeToAppState: listener => AppState.addEventListener('change', listener),
          refreshRepositories: async () => { await monolithPhoneOperation('actOnRepositoryCard', { ...request, action: 'refresh' }); },
        });
        setPicker(true);
      } else await monolithPhoneOperation('actOnRepositoryCard', request);
    } catch (reason) {
      const code = reason && typeof reason === 'object' && 'code' in reason && typeof reason.code === 'string' ? reason.code : 'unknown';
      const notice = githubConnectionErrorNotice(code);
      setErrorTitle(notice.title);
      setError(notice.description);
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
      disabled: !canAct, onPress: () => void act('create'), testID: 'repo-card-create' }] : [{ label: card.githubLinked === false ? 'Connect GitHub' : 'Install Beeline', primary: true,
      loading: busy, disabled: !canAct, onPress: () => void act('install'), testID: 'repo-card-install' }]),
    ...(card.githubLinked === false && !card.installationId ? [] : [
      { label: 'Link existing', disabled: !canAct, onPress: () => setPicker(!picker), testID: 'repo-card-link' },
      { label: 'Add Beeline to an org', disabled: !canAct, onPress: () => void act('organization'), testID: 'repo-card-org' },
    ]),
  ] : [];
  return <TranscriptCard tier={card.status === 'open' ? 'ask' : 'record'}
    identity={<IdentityMark kind="agent" seed={card.agentId} face={author?.face} name={author?.name} size={26} />}
    testID={`repository-onboarding-${card.kind}`}
    title={card.kind === 'starters' ? 'Pick a starting task' : card.repository ? 'Switch repository' : !card.canLink ? 'No repository yet' : 'Choose a repository'}
    subline={card.canLink ? card.repository ?? 'Create a private repo or link one you already own.' : undefined}
    body={card.kind === 'repository' ? card.canLink ? card.githubLinked === false && !card.installationId ? 'Connect GitHub to pick a repository or create one. You’ll approve it once on github.com, then come back here.' : `New repo: ${card.defaultName}` : card.ownerHandle ? `Ask @${card.ownerHandle} to link a repository for this Room` : 'Ask a Workspace owner or admin to choose a repository for this Room.' : undefined}
    choices={choices} actions={actions}
    footerNote={busy ? 'Working…' : card.selected ? `Selected · ${card.selected}` : undefined}>
    {error ? <ErrorBanner title={errorTitle}
      description={error} retryLabel="Back to Room" retryVariant="primary" onRetry={() => setError(null)} /> : picker && !card.repositories.length ?
      <EmptyState title="No repositories found. Install Beeline, then try again." /> : null}
  </TranscriptCard>;
}
