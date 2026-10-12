import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

const phoneOperation = vi.hoisted(() => vi.fn(async () => ({ access: 'fresh-token' })));
const openExternalUrl = vi.hoisted(() => vi.fn(async () => undefined));
const injectJavaScript = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
  return { Platform: { OS: 'android' }, Image: host('Image'), Pressable: host('Pressable'), Text: host('Text'), View: host('View') };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 24 }) }));
vi.mock('expo-image', async () => {
  const ReactModule = await import('react');
  return { Image: (props: any) => ReactModule.createElement('Image', props) };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (factory: any) => factory({ buzz: {
    transcriptCard: { marginTop: 8, cornerRadius: 12, side: 16, footerMinHeight: 40 },
    space: { xs: 4, sm: 8, md: 16 }, type: { body: {}, bodyStrong: {}, machine: {} },
    border: '#444', borderStrong: '#555', bgBase: '#111', textPrimary: '#fff', ledgerQuiet: '#aaa', accent: '#c90',
  } }) },
}));
vi.mock('@/components/buzz/sandbox-webview', async () => {
  const ReactModule = await import('react');
  const WebView = ReactModule.forwardRef((props: any, ref) => {
    ReactModule.useImperativeHandle(ref, () => ({ injectJavaScript }));
    return ReactModule.createElement('WebView', props);
  });
  return { useSandboxWebView: () => WebView };
});
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: phoneOperation }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl }));
vi.mock('@/buzz/desktop-computer-pane', () => ({ openComputerInDesktopWorkPane: () => false }));
vi.mock('@/modal', () => ({ Modal: { show: vi.fn(), alert: vi.fn() } }));
vi.mock('@/components/buzz/ViewerConversationDock', () => ({ ViewerConversationDock: () => null }));

import { Modal } from '@/modal';
import { ComputerSessionCard, ComputerSessionViewer, openComputerSessionViewer, type ComputerSessionView } from './ComputerSession';

const session = {
  id: 'session-1', title: 'Browser', url: 'https://computer.usebeeline.app/s/session-1/',
  status: 'live' as const, access: 'old-token',
} as ComputerSessionView;

afterEach(() => {
  phoneOperation.mockReset().mockResolvedValue({ access: 'fresh-token' });
  openExternalUrl.mockClear(); injectJavaScript.mockClear(); vi.mocked(Modal.show).mockClear();
});

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
  expect(phoneOperation).toHaveBeenCalledExactlyOnceWith('openComputerSession', { id: 'session-1' });
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

it('opens with the preview access immediately while a fresh authorization RPC is stalled', async () => {
  let resolveAccess!: (value: { access: string }) => void;
  phoneOperation.mockImplementationOnce(() => new Promise(resolve => { resolveAccess = resolve; }));
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<ComputerSessionCard session={session} />); });
  const preview = () => tree!.root.findAll((node: { type: unknown; props: Record<string, any> }) => typeof node.type === 'function' && node.props.preview === true)[0]!;
  expect(preview().props.session.access).toBe('old-token');
  const open = tree!.root.findAllByType('Pressable').find((node: { props: Record<string, any> }) => node.props.testID === 'computer-session-open')!;
  await act(async () => { await open.props.onPress(); });
  expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({props: expect.objectContaining({session: expect.objectContaining({access: 'old-token'})})}));
  expect(preview().props.session.access).toBe('old-token');
  const shown = vi.mocked(Modal.show).mock.calls[0]![0] as any;
  let viewer: ReturnType<typeof create>;
  await act(async () => { viewer = create(<ComputerSessionViewer {...shown.props} onClose={() => {}} />); });
  expect(phoneOperation).toHaveBeenCalledOnce();
  const source = () => viewer!.root.findByType('WebView').props.source.uri;
  expect(source()).toContain('access=old-token');
  expect(injectJavaScript).toHaveBeenCalledWith(expect.stringContaining('viewer-snapshot-request'));
  await act(async () => {
    tree!.root.findByType('WebView').props.onMessage({ nativeEvent: { data: JSON.stringify({
      type: 'computer-snapshot', id: session.id, requestId: 1, image: 'latest-frame',
    }) } });
  });
  expect(viewer!.root.findByType('Image').props.source.uri).toBe('data:image/jpeg;base64,latest-frame');
  await act(async () => { resolveAccess({ access: 'fresh-token' }); });
  expect(source()).toContain('access=old-token');
  await act(async () => {
    viewer!.root.findByType('WebView').props.onMessage({ nativeEvent: { data: JSON.stringify({
      type: 'computer-first-frame', id: session.id,
    }) } });
  });
  expect(viewer!.root.findAllByType('Image')).toHaveLength(0);
  await act(async () => viewer!.unmount());
  await act(async () => tree!.unmount());
});

it('gets authorization before opening a reference that has no warm preview', async () => {
  await openComputerSessionViewer({ ...session, access: undefined });
  expect(phoneOperation).toHaveBeenCalledExactlyOnceWith('openComputerSession', { id: session.id });
  expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
    props: expect.objectContaining({ session: expect.objectContaining({ access: 'fresh-token' }) }),
  }));
});

it('retries an expired preview URL with the refreshed token', async () => {
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<ComputerSessionViewer session={session} onClose={() => {}} />); });
  const webview = () => tree!.root.findByType('WebView');
  await act(async () => webview().props.onHttpError({ nativeEvent: { statusCode: 403 } }));
  expect(webview().props.source.uri).toContain('access=fresh-token');
  await act(async () => tree!.unmount());
});

it('removes the stream if background authorization refuses current viewer access', async () => {
  phoneOperation.mockRejectedValueOnce(Object.assign(new Error('access denied'), { status: 403 }));
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<ComputerSessionViewer session={session} onClose={() => {}} />); });
  expect(tree!.root.findAllByType('WebView')).toHaveLength(0);
  expect(tree!.root.findAllByType('Text').some((node: any) => node.props.children === 'Browser is unavailable')).toBe(true);
  await act(async () => tree!.unmount());
});

it('keeps a valid warm stream when the background refresh has a transient failure', async () => {
  phoneOperation.mockRejectedValueOnce(new Error('network timeout'));
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<ComputerSessionViewer session={session} onClose={() => {}} />); });
  expect(tree!.root.findByType('WebView').props.source.uri).toContain('access=old-token');
  await act(async () => tree!.unmount());
});

it('ignores a late preview capture once the viewer has painted its own live frame', async () => {
  let resolveFrame!: (image: string | null) => void;
  const previewFrame = new Promise<string | null>(resolve => { resolveFrame = resolve; });
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<ComputerSessionViewer session={{ ...session, previewFrame }} onClose={() => {}} />); });
  await act(async () => tree!.root.findByType('WebView').props.onMessage({ nativeEvent: { data: JSON.stringify({
    type: 'computer-first-frame', id: session.id,
  }) } }));
  await act(async () => resolveFrame('late-frame'));
  expect(tree!.root.findAllByType('Image')).toHaveLength(0);
  await act(async () => tree!.unmount());
});

it('clears the opening frame when the session ends before the viewer document loads', async () => {
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<ComputerSessionViewer session={{ ...session, previewFrame: Promise.resolve('frame') }} onClose={() => {}} />); });
  expect(tree!.root.findAllByType('Image')).toHaveLength(1);
  await act(async () => tree!.root.findByType('WebView').props.onHttpError({ nativeEvent: { statusCode: 410 } }));
  expect(tree!.root.findAllByType('Image')).toHaveLength(0);
  expect(tree!.root.findAllByType('Text').some((node: any) => node.props.children === 'Browser session ended')).toBe(true);
  await act(async () => tree!.unmount());
});
