vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({}) }));
vi.mock('@/components/buzz/ErrorBanner', () => ({ErrorBanner:(props:any)=>React.createElement('ErrorBanner',props)}));
import { ErrorBanner } from '@/components/buzz/ErrorBanner';
vi.mock('@/buzz/onboarding-rollout', () => ({ useRepositoryOnboarding: () => mocks.enabled }));
import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { RepositoryOnboardingCard as Card } from '@beeline/api-contract/phone';
const mocks = vi.hoisted(() => ({ enabled: true, operation: vi.fn<(...args: any[]) => Promise<any>>(async () => ({})) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null }));
vi.mock('react-native', () => ({ AppState: {}, Platform: { OS: 'android' } }));
vi.mock('@/components/buzz/TranscriptCard', () => ({ TranscriptCard: (props: any) => React.createElement('TranscriptCard', props) }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: mocks.operation }));
vi.mock('@/auth/auth-session', () => ({ authSessionOptions: () => ({}) }));
vi.mock('@/auth/desktop-auth-session', () => ({ openAccountAuthSession: vi.fn(), subscribeToAuthUrls: vi.fn() }));
vi.mock('@/auth/github-auth-session', () => ({ githubInstallationRedirectUri: () => 'beeline://beeline/github-installation', runGitHubInstallationSession: vi.fn() }));
import { RepositoryOnboardingCard } from './RepositoryOnboardingCard';
const H='a'.repeat(64);
const card: Card = { id:'b'.repeat(64), roomId:'11111111-1111-4111-8111-111111111111', agentId:'c'.repeat(64), requesterId:H,
  kind:'repository', canLink:true, state:'repo_linked', status:'open', repository:'test/current', defaultName:'new-project-123456', installationId:77,
  repositories:[{ id:42, fullName:'test/current', installationId:77, defaultBranch:'main', current:true }, { id:43, fullName:'test/other', installationId:77, defaultBranch:'main', current:false }], starters:[] };
it('marks the current repo and sends the other repository id to the server', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  let rendered: any;
  await act(async () => { rendered=create(<RepositoryOnboardingCard card={card} viewerId={H} />); });
  let props=rendered.root.findByType('TranscriptCard').props;
  expect(props.title).toBe('Switch repository');
  await act(async () => props.actions.find((a:any)=>a.label==='Link existing').onPress());
  props=rendered.root.findByType('TranscriptCard').props;
  expect(props.choices[0].selected).toBe(true);
  expect(props.choices[0].onPress).toBeUndefined();
  await act(async () => props.choices[1].onPress());
  expect(mocks.operation).toHaveBeenCalledWith('actOnRepositoryCard', expect.objectContaining({ action:'link', repositoryId:43, cardId:card.id }));
});
it('does not offer actions to another viewer or repeat a settled task', async () => {
  let rendered: any;
  await act(async () => { rendered=create(<RepositoryOnboardingCard card={card} viewerId={'d'.repeat(64)} />); });
  expect(rendered.root.findByType('TranscriptCard').props.actions).toEqual([]);
  await act(async () => { rendered.update(<RepositoryOnboardingCard card={{...card,kind:'starters',status:'settled',starters:[{id:'readme',title:'README',evidence:'Empty repo',task:'Document it'}]}} viewerId={H} />); });
  expect(rendered.root.findByType('TranscriptCard').props.choices[0].onPress).toBeUndefined();
});

it('does not render a cached card when server eligibility is OFF', async () => {
  mocks.enabled = false;
  try {
    let renderer: any;
    await act(async () => { renderer = create(<RepositoryOnboardingCard card={card} viewerId={H} />); });
    expect(renderer.toJSON()).toBeNull();
  } finally { mocks.enabled = true; }
});

it('E4/E9: offers Connect GitHub to the Google owner and names that owner for a regular member', async () => {
  mocks.enabled = true;
  let renderer: any;
  const missing: Card = { ...card, repository:undefined, installationId:undefined, state:'install_missing', githubLinked:false, ownerHandle:'alex.chen' };
  await act(async () => { renderer=create(<RepositoryOnboardingCard card={missing} viewerId={H} />); });
  expect(renderer.root.findByType('TranscriptCard').props.actions[0].label).toBe('Connect GitHub');
  await act(async () => { renderer.update(<RepositoryOnboardingCard card={{...missing,canLink:false}} viewerId={H} />); });
  const props=renderer.root.findByType('TranscriptCard').props;
  expect(props.actions).toEqual([]);
  expect(props.body).toBe('Ask @alex.chen to link a repository for this Room');
});
it('E7: a failed cold return explains the other account and keeps Connect GitHub available', async () => {
  mocks.enabled = true;
  let renderer: any;
  await act(async () => { renderer=create(<RepositoryOnboardingCard
    card={{...card,installationId:undefined,githubLinked:false,state:'install_missing'}} viewerId={H}
    connectionError="github_account_already_linked" />); });
  const props=renderer.root.findByType('TranscriptCard').props;
  expect(renderer.root.findByType(ErrorBanner).props.title).toBe('GitHub account already connected');
  expect(renderer.root.findByType(ErrorBanner).props.retryVariant).toBe('primary');
  expect(renderer.root.findByType(ErrorBanner).props.description).toContain('sign out of Beeline');
  expect(props.actions.map((action:any) => action.label)).toEqual(['Connect GitHub']);
});


it('opens the repository picker for a covered user without opening GitHub', async () => {
  const { runGitHubInstallationSession } = await import('@/auth/github-auth-session');
  vi.mocked(runGitHubInstallationSession).mockClear();
  mocks.operation.mockResolvedValueOnce({ openPicker: true });
  let renderer: any;
  await act(async () => { renderer = create(<RepositoryOnboardingCard
    card={{...card, installationId: undefined, repository: undefined}} viewerId={H} />); });
  await act(async () => renderer.root.findByType('TranscriptCard').props.actions
    .find((action: any) => action.testID === 'repo-card-install').onPress());
  expect(runGitHubInstallationSession).not.toHaveBeenCalled();
  expect(renderer.root.findByType('TranscriptCard').props.choices.map((choice: any) => choice.label))
    .toEqual(['test/current', 'test/other']);
});
