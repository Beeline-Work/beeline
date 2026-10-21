import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ id: 'a'.repeat(43), identity: true }));
const operation = vi.hoisted(() => vi.fn(async () => ({ access: 'viewer-token' })));
const replace = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (factory: any) => factory({ buzz: { space: { md: 16 }, bgBase: 'black', textPrimary: 'white', type: { body: {} } } }) } }));
vi.mock('expo-router', () => ({ router: { replace }, useLocalSearchParams: () => ({ id: state.id }) }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => state.identity ? {} : null }));
vi.mock('@/buzz/pending-browser-share', () => ({ savePendingBrowserShare: save, validBrowserShareId: (id: string) => /^[A-Za-z0-9_-]{43}$/.test(id) }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.test' }) }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation }));
vi.mock('@/components/buzz/ComputerSession', () => ({ ComputerSessionViewer: (props: any) => React.createElement('Viewer', props) }));
import BrowserShare from './browser-share';
let tree: ReturnType<typeof create>;
beforeEach(() => { state.id = 'a'.repeat(43); state.identity = true; operation.mockReset().mockResolvedValue({ access: 'viewer-token' }); replace.mockClear(); save.mockClear(); });
afterEach(async () => { await act(async () => tree?.unmount()); });
it('opens the existing viewer only after phone authorization', async () => {
  await act(async () => { tree = create(<BrowserShare />); });
  expect(operation).toHaveBeenCalledWith('openComputerSession', { id: state.id });
  expect(tree.root.findByType('Viewer').props.session).toMatchObject({ id: state.id, access: 'viewer-token', url: `https://server.test/s/${state.id}/` });
});
it('preserves the share through sign-in without requesting a capability', async () => {
  state.identity = false;
  await act(async () => { tree = create(<BrowserShare />); });
  expect(save).toHaveBeenCalledWith(state.id);
  expect(replace).toHaveBeenCalledWith('/beeline/onboarding');
  expect(operation).not.toHaveBeenCalled();
});
it('renders a readable refusal when access is denied', async () => {
  operation.mockRejectedValueOnce(new Error('denied'));
  await act(async () => { tree = create(<BrowserShare />); });
  expect(tree.root.findByType('Text').props.children).toContain('do not have access');
  expect(tree.root.findAllByType('Viewer')).toHaveLength(0);
});
it('rejects a malformed share link before phone authorization', async () => {
  state.id = '//example.com';
  await act(async () => { tree = create(<BrowserShare />); });
  expect(tree.root.findByType('Text').props.children).toContain('invalid');
  expect(operation).not.toHaveBeenCalled();
});
