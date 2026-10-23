vi.mock('expo-router', () => ({ useLocalSearchParams: () => mocks.params, router: { setParams: vi.fn((params) => { Object.assign(mocks.params, params); }) } }));
vi.mock('@/components/buzz/ErrorBanner', () => ({ErrorBanner:(props:any)=>React.createElement('ErrorBanner',props)}));
vi.mock('@/buzz/onboarding-rollout', () => ({ useRepositoryOnboarding: () => mocks.enabled }));
import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { RepositoryOnboardingCard as Card } from '@beeline/api-contract/phone';
const mocks = vi.hoisted(() => ({ enabled: true, params: {} as Record<string, string | undefined>, operation: vi.fn<(...args: any[]) => Promise<any>>(async () => ({})) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null }));
vi.mock('react-native', () => ({ AppState: {}, Platform: { OS: 'android' } }));
vi.mock('@/components/buzz/TranscriptCard', () => ({ TranscriptCard: (props: any) => React.createElement('TranscriptCard', props) }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: mocks.operation }));
vi.mock('@/auth/auth-session', () => ({ authSessionOptions: () => ({}) }));
vi.mock('@/auth/desktop-auth-session', () => ({ openAccountAuthSession: vi.fn(), subscribeToAuthUrls: vi.fn() }));
vi.mock('@/auth/github-auth-session', () => ({ githubInstallationRedirectUri: () => 'beeline://beeline/github-installation', runGitHubInstallationSession: vi.fn(), clearPendingGitHubInstallation: vi.fn(async () => undefined) }));
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
it('R-GITHUB-CARD: consumes the return only on its initiating card, once', async () => {
  mocks.params = { repositoryPicker: card.id, githubConnectionError: 'github_account_already_linked', installed: '0' };
  let renderer: any;
  await act(async () => { renderer=create(<>
    <RepositoryOnboardingCard card={card} viewerId={H} />
    <RepositoryOnboardingCard card={{...card,id:'other'}} viewerId={H} />
  </>); });
  const cards = renderer.root.findAllByType('TranscriptCard');
  expect(cards[0].props.inlineError.description).toContain('linked to a different Beeline account');
  expect(cards[0].props.inlineError.title).toBe("GitHub didn't connect");
  expect(cards[0].props.actions.map((action:any) => action.label)).toEqual(['Dismiss', 'Try again']);
  expect(cards[0].props.actions[1].primary).toBe(true);
  expect(cards[0].props.actions[0].labelTone).toBe('quiet');
  expect(cards[1].props.inlineError).toBeUndefined();
  expect(mocks.params.githubConnectionError).toBeUndefined();
  expect(mocks.params.installed).toBe('0');
  expect(mocks.params.repositoryPicker).toBe(card.id);
  await act(async () => renderer.unmount());
  await act(async () => { renderer=create(<RepositoryOnboardingCard card={card} viewerId={H} />); });
  expect(renderer.root.findByType('TranscriptCard').props.inlineError).toBeUndefined();
  await act(async () => renderer.unmount());
  mocks.params = {};
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

for (const result of ['success', 'foreground', 'browser_canceled'] as const) {
  it(`consumes native installation state after ${result}`, async () => {
    const session = await import('@/auth/github-auth-session');
    vi.mocked(session.clearPendingGitHubInstallation).mockClear();
    if (result === 'browser_canceled') vi.mocked(session.runGitHubInstallationSession).mockRejectedValueOnce({ code: result });
    else vi.mocked(session.runGitHubInstallationSession).mockResolvedValueOnce(result === 'success' ? 'beeline://beeline/github-installation?installed=1' : null);
    mocks.operation.mockResolvedValueOnce({ url: 'https://github.com/apps/beeline/installations/select_target' });
    let renderer: any;
    await act(async () => { renderer = create(<RepositoryOnboardingCard card={{...card, installationId: undefined}} viewerId={H} />); });
    await act(async () => renderer.root.findByType('TranscriptCard').props.actions.find((action: any) => action.testID === 'repo-card-install').onPress());
    expect(session.clearPendingGitHubInstallation).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });
}

it('R-GITHUB-CARD: keeps an operation failure local and retries the failed action', async () => {
  mocks.params = {};
  mocks.operation.mockRejectedValueOnce({ code: 'github_connection_failed' });
  let renderer: any;
  await act(async () => { renderer=create(<>
    <RepositoryOnboardingCard card={card} viewerId={H} />
    <RepositoryOnboardingCard card={{...card,id:'other'}} viewerId={H} />
  </>); });
  await act(async () => renderer.root.findAllByType('TranscriptCard')[0].props.actions[0].onPress());
  const cards = renderer.root.findAllByType('TranscriptCard');
  expect(cards[0].props.inlineError.title).toBe("GitHub didn't connect");
  expect(cards[0].props.compactBody).toBe(true);
  expect(cards[0].props.primaryBody).toBe(true);
  expect(cards[0].props.subline).toBeUndefined();
  expect(cards[0].props.actions.map((a:any) => a.label)).toEqual(['Dismiss', 'Try again']);
  expect(cards[1].props.inlineError).toBeUndefined();
  await act(async () => cards[0].props.actions[1].onPress());
  expect(mocks.operation).toHaveBeenLastCalledWith('actOnRepositoryCard', expect.objectContaining({action:'create',cardId:card.id}));
  expect(renderer.root.findAllByType('TranscriptCard')[0].props.inlineError).toBeUndefined();
  await act(async () => renderer.unmount());
});

it('collapses a linked repository using its existing name without inventing visibility', async () => {
  let renderer: any;
  await act(async () => { renderer=create(<RepositoryOnboardingCard card={{...card,status:'settled'}} viewerId={H} />); });
  const props=renderer.root.findByType('TranscriptCard').props;
  expect(props.title).toBe('Repository linked');
  expect(props.subline).toBe('test/current');
  expect(props.body).toBeUndefined();
  expect(props.actions).toEqual([]);
  expect(props.identity).toBeTruthy();
  await act(async () => renderer.unmount());
});
it('dismisses a failed connect permanently while preserving the installation result', async () => {
  mocks.params={repositoryPicker:card.id,githubConnectionError:'github_account_already_linked',installed:'1'};
  let renderer:any;
  await act(async()=>{renderer=create(<RepositoryOnboardingCard card={card} viewerId={H}/>);});
  await act(async()=>renderer.root.findByType('TranscriptCard').props.actions[0].onPress());
  expect(renderer.root.findByType('TranscriptCard').props.inlineError).toBeUndefined();
  expect(mocks.params.githubConnectionError).toBeUndefined();
  expect(mocks.params.installed).toBe('1');
  await act(async()=>renderer.unmount());mocks.params={};
});
