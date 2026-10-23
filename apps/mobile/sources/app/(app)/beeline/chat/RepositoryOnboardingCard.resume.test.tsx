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
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) }, Platform: { OS: 'android' } }));
vi.mock('@/components/buzz/TranscriptCard', () => ({ TranscriptCard: (props: any) => React.createElement('TranscriptCard', props) }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: mocks.operation }));
vi.mock('@/auth/auth-session', () => ({ authSessionOptions: () => ({}) }));
vi.mock('@/auth/desktop-auth-session', () => ({ openAccountAuthSession: async () => ({ type: 'success', url: 'beeline://beeline/github-installation?installed=1' }), subscribeToAuthUrls: () => ({ remove() {} }) }));

import { RepositoryOnboardingCard } from './RepositoryOnboardingCard';
const H='a'.repeat(64);
const card: Card = { id:'b'.repeat(64), roomId:'11111111-1111-4111-8111-111111111111', agentId:'c'.repeat(64), requesterId:H,
  kind:'repository', canLink:true, state:'repo_linked', status:'open', repository:'test/current', defaultName:'new-project-123456', installationId:77,
  repositories:[{ id:42, fullName:'test/current', installationId:77, defaultBranch:'main', current:true }, { id:43, fullName:'test/other', installationId:77, defaultBranch:'main', current:false }], starters:[] };

vi.mock('expo-linking', () => ({ createURL: (path: string) => `beeline://${path}` }));
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { storage.set(key, value); },
  removeItem: async (key: string) => { storage.delete(key); },
} }));
it('GITHUB-INSTALLATION-CONSUMED: a completed card connect never opens a picker on cold start', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { resumeInitialGitHubInstallation, githubInstallationReturnPath, completeGitHubInstallationRoute } = await import('@/auth/github-auth-session');
  storage.clear();
  mocks.operation.mockImplementation(async (_operation, input) => input.action === 'refresh' ? {} : { url: 'https://github.com/apps/beeline/installations/select_target' });
  let renderer: any;
  await act(async () => { renderer = create(<RepositoryOnboardingCard card={{...card, installationId: undefined}} viewerId={H} />); });
  await act(async () => renderer.root.findByType('TranscriptCard').props.actions.find((action: any) => action.testID === 'repo-card-install').onPress());
  expect(renderer.root.findByType('TranscriptCard').props.choices).toHaveLength(2);
  expect(mocks.operation).toHaveBeenCalledWith('actOnRepositoryCard', expect.objectContaining({ action: 'refresh' }));
  await act(async () => renderer.unmount());
  const openPicker = vi.fn();
  if (await resumeInitialGitHubInstallation(async () => null)) openPicker();
  expect(openPicker).not.toHaveBeenCalled();
  expect(await githubInstallationReturnPath()).toBeNull();
  expect(storage.size).toBe(0);
  await expect(completeGitHubInstallationRoute('1')).rejects.toThrow('started on this device');
  await act(async () => { renderer = create(<RepositoryOnboardingCard card={card} viewerId={H} />); });
  expect(renderer.root.findByType('TranscriptCard').props.choices).toHaveLength(0);
  await act(async () => renderer.unmount());
});
