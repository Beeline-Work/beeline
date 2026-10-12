import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

const phoneOperation = vi.hoisted(() => vi.fn(async () => ({ access: 'fresh-token' })));
const openExternalUrl = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
  return { Platform: { OS: 'ios' }, Pressable: host('Pressable'), Text: host('Text'), View: host('View') };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 24 }) }));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (factory: any) => factory({ buzz: {
    transcriptCard: { marginTop: 8, cornerRadius: 12, side: 16, footerMinHeight: 40 },
    space: { xs: 4, sm: 8, md: 16 }, type: { body: {}, bodyStrong: {}, machine: {} },
    border: '#444', borderStrong: '#555', bgBase: '#111', textPrimary: '#fff', ledgerQuiet: '#aaa', accent: '#c90',
  } }) },
}));
vi.mock('@/components/buzz/sandbox-webview', () => ({ useSandboxWebView: () => null }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: phoneOperation }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl }));
vi.mock('@/buzz/desktop-computer-pane', () => ({ openComputerInDesktopWorkPane: () => false }));
vi.mock('@/modal', () => ({ Modal: { show: vi.fn(), alert: vi.fn() } }));
vi.mock('@/components/buzz/ViewerConversationDock', () => ({ ViewerConversationDock: () => null }));

import { Modal } from '@/modal';
import { ComputerSessionCard, ComputerSessionViewer, type ComputerSessionView } from './ComputerSession';

const session = {
  id: 'session-1', title: 'Browser', url: 'https://computer.usebeeline.app/s/session-1/',
  status: 'live' as const, access: 'old-token',
} as ComputerSessionView;

afterEach(() => { phoneOperation.mockClear(); openExternalUrl.mockClear(); });

for (const isDesktop of [false, true]) {
  it(`shows a live card and open button to a viewer who can steer on ${isDesktop ? 'desktop' : 'phone'}`, async () => {
    let tree: ReturnType<typeof create>;
    await act(async () => { tree = create(<ComputerSessionCard session={{ ...session, access: undefined }} isDesktop={isDesktop} />); });
    expect(tree!.root.findAllByProps({ testID: 'computer-session-card-live' }).length).toBeGreaterThan(0);
    expect(tree!.root.findAllByProps({ testID: 'computer-session-open' }).length).toBeGreaterThan(0);
    await act(async () => tree!.unmount());
  });

  it(`shows the card without an open button when the viewer cannot steer on ${isDesktop ? 'desktop' : 'phone'}`, async () => {
    phoneOperation.mockRejectedValueOnce(new Error('access denied'));
    let tree: ReturnType<typeof create>;
    await act(async () => { tree = create(<ComputerSessionCard session={{ ...session, access: undefined }} isDesktop={isDesktop} />); });
    expect(tree!.root.findAllByProps({ testID: 'computer-session-card-live' }).length).toBeGreaterThan(0);
    expect(tree!.root.findAllByProps({ testID: 'computer-session-open' })).toHaveLength(0);
    await act(async () => tree!.unmount());
  });
}

it('shows an ended card without an open button', async () => {
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<ComputerSessionCard session={{ ...session, status: 'ended' }} />); });
  expect(tree!.root.findAllByProps({ testID: 'computer-session-card-ended' }).length).toBeGreaterThan(0);
  expect(tree!.root.findAllByProps({ testID: 'computer-session-open' })).toHaveLength(0);
  await act(async () => tree!.unmount());
});

it('mints a fresh steering token before opening the system browser', async () => {
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<ComputerSessionViewer session={session} onClose={() => undefined} />); });
  await act(async () => {
    tree!.root.findByProps({ testID: 'computer-session-open-browser' }).props.onPress();
    await vi.waitFor(() => expect(openExternalUrl).toHaveBeenCalledOnce());
  });
  expect(phoneOperation).toHaveBeenCalledWith('openComputerSession', { id: 'session-1' });
  expect(openExternalUrl).toHaveBeenCalledWith('https://computer.usebeeline.app/s/session-1/?access=fresh-token');
  expect(phoneOperation).not.toHaveBeenCalledWith('handbackComputerSession', expect.anything());
  await act(async () => tree!.unmount());
});

it('keeps only Open and Close above the page; closing never controls or ends the share', async () => {
  const onClose = vi.fn();
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<ComputerSessionViewer session={session} onClose={onClose} />); });
  expect(tree!.root.findByProps({ testID: 'computer-session-viewer' }).props.style[1]).toEqual({ paddingTop: 0, paddingBottom: 24 });
  const controls = tree!.root.findByProps({ testID: 'computer-session-controls' });
  expect(controls.props.style.position).toBeUndefined();
  expect(controls.props.style.marginTop + controls.props.style.marginBottom).toBe(24);
  expect(controls.props.style.marginHorizontal).toBe(16);
  expect(controls.findAllByType('Pressable').map((button: any) => button.props.accessibilityLabel))
    .toEqual(['Open in browser', 'Close browser']);
  await act(async () => tree!.root.findByProps({ testID: 'computer-session-close' }).props.onPress());
  expect(onClose).toHaveBeenCalledOnce();
  expect(phoneOperation).not.toHaveBeenCalled();
  await act(async () => tree!.unmount());
});

it('offers no browser handoff after the session ends', async () => {
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<ComputerSessionViewer session={{ ...session, status: 'ended' }} onClose={() => undefined} />); });
  expect(tree!.root.findAllByProps({ testID: 'computer-session-open-browser' })).toHaveLength(0);
  expect(tree!.root.findAllByProps({ testID: 'computer-session-end' })).toHaveLength(0);
  await act(async () => tree!.unmount());
});

it('offers no browser handoff without steering access', async () => {
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<ComputerSessionViewer session={{ ...session, access: undefined }} onClose={() => undefined} />); });
  expect(tree!.root.findAllByProps({ testID: 'computer-session-open-browser' })).toHaveLength(0);
  await act(async () => tree!.unmount());
});

it('keeps the already-live preview token and connection when minting a token for the full view', async () => {
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<ComputerSessionCard session={session} />); });
  const preview = () => tree!.root.findAll((node: { type: unknown; props: Record<string, any> }) => typeof node.type === 'function' && node.props.preview === true)[0]!;
  expect(preview().props.session.access).toBe('old-token');
  const open = tree!.root.findAllByType('Pressable').find((node: { props: Record<string, any> }) => node.props.testID === 'computer-session-open')!;
  await act(async () => { await open.props.onPress(); });
  expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({props: expect.objectContaining({session: expect.objectContaining({access: 'fresh-token'})})}));
  expect(preview().props.session.access).toBe('old-token');
  await act(async () => tree!.unmount());
});
